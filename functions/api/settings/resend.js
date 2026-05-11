// Admin-only endpoint to manage the Resend email-channel credentials.
//
// Stores the API key encrypted (AES-GCM with the SESSION_SECRET as the
// derived-key seed) so it is never readable outside this server. The
// activation flow requires the admin to confirm a 6-digit code sent to the
// configured recipient address, proving both that the key works AND that
// the admin controls the receiving mailbox.
//
// Actions (all POST { action, ... }):
//   - 'save'        { apiKey, recipient }  store encrypted, send code
//   - 'verify'      { code }                consume code → status='enabled'
//   - 'resend-code' { }                     re-issue a code (e.g., expired)
//   - 'remove'      { }                     wipe key + status='disabled'

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { logAudit } from '../../lib/audit.js';
import { encryptString, hashPassword, verifyPassword, randomToken } from '../../lib/crypto.js';
import { sendEmail } from '../../lib/email.js';

const VERIFY_TTL_MIN = 10;
const CODE_LENGTH = 6;

function randomDigitCode(n = CODE_LENGTH) {
  // Crypto-random N-digit string. We sample bytes and reduce mod 10 — a
  // mild bias exists but it's irrelevant for a 10-minute one-shot code.
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, b => String(b % 10)).join('');
}

async function writeSetting(db, key, value) {
  await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
    .bind(key, value).run();
}

async function readSettingsMap(db, keys) {
  const placeholders = keys.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`).bind(...keys).all();
  const map = {};
  for (const r of (rows.results || [])) map[r.key] = r.value;
  return map;
}

async function issueVerificationCode(env, recipient, buildingName) {
  const code = randomDigitCode();
  const hashed = await hashPassword(code);
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MIN * 60_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO resend_verification (id, code_hash, salt, expires_at, recipient, created_at) VALUES ('pending', ?, ?, ?, ?, datetime('now')) " +
    "ON CONFLICT(id) DO UPDATE SET code_hash = excluded.code_hash, salt = excluded.salt, expires_at = excluded.expires_at, recipient = excluded.recipient, created_at = datetime('now')"
  ).bind(hashed.hash, hashed.salt, expiresAt, recipient).run();

  // Send the verification email USING the just-saved key. We let
  // sendEmail resolve the key from settings so we exercise the same path
  // production traffic will use.
  const subject = `קוד אימות לערוץ אימייל — ${buildingName || 'ועד הבית'}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
      <h2 style="margin:0 0 12px">הפעלת התראות אימייל לפניות</h2>
      <p style="margin:0 0 16px;line-height:1.6">קוד האימות שלך:</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f4f6fb;padding:16px;text-align:center;border-radius:8px;color:#1e5b9c">${code}</div>
      <p style="margin:18px 0 0;color:#64748b;font-size:13px;line-height:1.5">הקוד תקף למשך ${VERIFY_TTL_MIN} דקות. אם לא ביקשת אימות, התעלם מהודעה זו.</p>
    </div>
  `;
  const text = `קוד האימות שלך הוא ${code}. תקף למשך ${VERIFY_TTL_MIN} דקות.`;
  await sendEmail(env, { to: recipient, subject, html, text });
}

async function loadStatus(db) {
  const m = await readSettingsMap(db, ['resend_api_key_enc', 'tickets_admin_email', 'tickets_email_status']);
  return {
    hasResendKey: !!(m.resend_api_key_enc),
    ticketsAdminEmail: m.tickets_admin_email || '',
    ticketsEmailStatus: m.tickets_email_status || 'disabled',
  };
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  return json(await loadStatus(env.DB));
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const action = pickStr(body.action, 30);
  const db = env.DB;

  if (action === 'save') {
    const apiKey = pickStr(body.apiKey, 200).trim();
    const recipient = pickStr(body.recipient, 200).trim();
    if (!apiKey) return error('מפתח API חסר', 400);
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      return error('כתובת מייל לא תקפה', 400);
    }
    const secret = env.SESSION_SECRET || 'dev-only-secret-change-me-in-production-please-1234567890';
    const { ciphertext, iv } = await encryptString(apiKey, secret);
    // Update flag is wiped on every save, so a new key always re-verifies.
    await writeSetting(db, 'resend_api_key_enc', ciphertext);
    await writeSetting(db, 'resend_api_key_iv', iv);
    await writeSetting(db, 'tickets_admin_email', recipient);
    await writeSetting(db, 'tickets_email_status', 'pending');

    // Pull building name for the subject line.
    const bn = await db.prepare("SELECT value FROM settings WHERE key = 'building_name'").first();
    try {
      await issueVerificationCode(env, recipient, bn?.value || '');
    } catch (err) {
      // If sending fails the key may still be invalid; roll back the
      // status so the admin can fix and retry.
      await writeSetting(db, 'tickets_email_status', 'disabled');
      await logAudit(db, request, { event: 'resend_save_failed', role: 'admin', userLabel: 'מנהל', success: false, meta: { reason: String(err.message || err).slice(0, 200) } });
      return error(`שליחת קוד אימות נכשלה: ${err.message || err}`, 400);
    }
    await logAudit(db, request, { event: 'resend_key_saved', role: 'admin', userLabel: 'מנהל', success: true });
    return json({ ok: true, ...(await loadStatus(db)) });
  }

  if (action === 'verify') {
    const code = pickStr(body.code, 12).trim();
    if (!code) return error('קוד חסר', 400);
    const row = await db.prepare('SELECT code_hash, salt, expires_at FROM resend_verification WHERE id = ?').bind('pending').first();
    if (!row) return error('אין קוד אימות פעיל', 400);
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return error('הקוד פג תוקף — בקש קוד חדש', 400);
    }
    const ok = await verifyPassword(code, row.code_hash, row.salt, 100000);
    if (!ok) return error('קוד שגוי', 400);
    await writeSetting(db, 'tickets_email_status', 'enabled');
    await db.prepare("DELETE FROM resend_verification WHERE id = ?").bind('pending').run();
    await logAudit(db, request, { event: 'resend_verified', role: 'admin', userLabel: 'מנהל', success: true });
    return json({ ok: true, ...(await loadStatus(db)) });
  }

  if (action === 'resend-code') {
    const m = await readSettingsMap(db, ['tickets_admin_email']);
    const recipient = m.tickets_admin_email;
    if (!recipient) return error('לא הוגדר נמען', 400);
    const bn = await db.prepare("SELECT value FROM settings WHERE key = 'building_name'").first();
    try {
      await issueVerificationCode(env, recipient, bn?.value || '');
    } catch (err) {
      return error(`שליחה נכשלה: ${err.message || err}`, 400);
    }
    return json({ ok: true });
  }

  if (action === 'remove') {
    await writeSetting(db, 'resend_api_key_enc', '');
    await writeSetting(db, 'resend_api_key_iv', '');
    await writeSetting(db, 'tickets_admin_email', '');
    await writeSetting(db, 'tickets_email_status', 'disabled');
    await db.prepare("DELETE FROM resend_verification WHERE id = ?").bind('pending').run();
    await logAudit(db, request, { event: 'resend_removed', role: 'admin', userLabel: 'מנהל', success: true });
    return json({ ok: true, ...(await loadStatus(db)) });
  }

  return error('פעולה לא תקפה', 400);
};
