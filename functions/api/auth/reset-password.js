// POST /api/auth/reset-password  { token, newPassword }
// Completes a password reset using a token minted by the identity-OAuth
// callback (after Google verified the user owns the registered recovery email).
//
// On success:
//   • the admin password is replaced
//   • the token is marked used (single-use)
//   • all admin sessions are killed (the user must log in fresh)
//   • 2FA is disabled if it was on — losing your password usually means
//     losing your authenticator too, and we don't want a permanent lockout.
//     The admin can re-enable 2FA from Settings after logging in.

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { hashPassword } from '../../lib/crypto.js';
import { disableAdmin2FA } from '../../lib/admin2fa.js';
import { logAudit } from '../../lib/audit.js';

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const token = pickStr(body.token, 200).trim();
  const newPassword = pickStr(body.newPassword, 200);
  if (!token || !newPassword) return error('שדות חובה חסרים', 400);
  if (newPassword.length < 4) return error('הסיסמה החדשה חייבת לכלול 4 תווים לפחות', 400);

  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT id, expires_at AS expiresAt, used_at AS usedAt FROM password_reset_tokens
      WHERE token_hash = ? AND type = 'admin' LIMIT 1`
  ).bind(tokenHash).first();

  if (!row) {
    await logAudit(db, request, { event: 'pwreset_failed', role: 'admin', userLabel: 'מנהל', success: false, meta: { reason: 'unknown_token' } });
    return error('לינק לא תקף', 400);
  }
  if (row.usedAt) {
    await logAudit(db, request, { event: 'pwreset_failed', role: 'admin', userLabel: 'מנהל', success: false, meta: { reason: 'token_used' } });
    return error('הלינק כבר נוצל. אם הסיסמה שלך לא משוחזרת, בקש לינק חדש.', 400);
  }
  if (new Date(row.expiresAt) < new Date()) {
    await logAudit(db, request, { event: 'pwreset_failed', role: 'admin', userLabel: 'מנהל', success: false, meta: { reason: 'token_expired' } });
    return error('הלינק פג תוקף. בקש לינק חדש.', 400);
  }

  // Replace admin password
  const h = await hashPassword(newPassword, Number(env.PBKDF2_ITERATIONS || 100000));
  await db.prepare(
    `UPDATE admin_auth SET password_hash = ?, password_salt = ?, iterations = ?, updated_at = datetime('now') WHERE id = 1`
  ).bind(h.hash, h.salt, h.iterations).run();

  // Mark token used
  await db.prepare(`UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?`)
    .bind(row.id).run();

  // Disable 2FA — see comment at top of file.
  await disableAdmin2FA(db);

  // Kill any active admin sessions so a previously-stolen session can't ride
  // through the reset.
  await db.prepare(`DELETE FROM sessions WHERE role = 'admin' AND apartment_id IS NULL`).run();

  await logAudit(db, request, { event: 'pwreset_completed', role: 'admin', userLabel: 'מנהל', success: true });
  return json({ ok: true });
};
