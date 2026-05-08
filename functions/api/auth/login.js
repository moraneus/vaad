// POST /api/auth/login
// Body: { mode: 'admin' | 'tenant', password, apartmentId?, newPassword? }
// - admin: validates against admin_auth row
// - tenant: validates against apartment row; if apartment.password_hash is null,
//           sets it from the supplied newPassword (first-time setup).

import { json, error, readJSON, pickStr, clientIP } from '../../lib/util.js';
import { hashPassword, verifyPassword } from '../../lib/crypto.js';
import { createSession, setCookie } from '../../lib/session.js';
import { logAudit, checkRateLimit, recordFailedAttempt, clearAttempts } from '../../lib/audit.js';
import { admin2FAEnabled, verifyAdmin2FACode } from '../../lib/admin2fa.js';

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  let body;
  try { body = await readJSON(request); } catch (e) { return error('בקשה לא תקינה'); }

  const mode = pickStr(body.mode, 16);
  const password = pickStr(body.password, 200);
  const totpCode = pickStr(body.totpCode, 20);

  if (mode === 'admin') {
    return loginAdmin({ db, env, request, password, totpCode });
  }
  if (mode === 'tenant') {
    const apartmentId = pickStr(body.apartmentId, 80);
    const newPassword = pickStr(body.newPassword, 200);
    return loginTenant({ db, env, request, apartmentId, password, newPassword });
  }
  return error('מצב כניסה לא תקף', 400);
};

async function loginAdmin({ db, env, request, password, totpCode }) {
  const bucket = 'admin';
  const rl = await checkRateLimit(db, request, bucket, env);
  if (!rl.allowed) {
    await logAudit(db, request, { event: 'login_rate_limited', role: 'admin', userLabel: 'מנהל', success: false });
    return error('יותר מדי ניסיונות כושלים. נסו שוב מאוחר יותר.', 429, { retryAfterSec: rl.retryAfterSec });
  }
  if (!password) {
    await recordFailedAttempt(db, request, bucket);
    return error('סיסמה חסרה', 400);
  }
  const row = await db.prepare('SELECT password_hash AS h, password_salt AS s, iterations AS i FROM admin_auth WHERE id = 1').first();
  if (!row) return error('המערכת אינה מאותחלת', 500);

  // First-time init: if password is the literal "1234" and the hash is sentinel, accept and lock
  if (row.h === 'NEEDS_INIT') {
    if (password !== '1234') {
      await recordFailedAttempt(db, request, bucket);
      await logAudit(db, request, { event: 'login_failed', role: 'admin', userLabel: 'מנהל', success: false, meta: { reason: 'init_needed' } });
      return error('בכניסה הראשונה יש להשתמש בסיסמה הזמנית 1234. לאחר הכניסה — שנו אותה מיד בהגדרות.', 401);
    }
    // Set the actual hash for "1234" so future logins work normally
    const h = await hashPassword('1234', Number(env.PBKDF2_ITERATIONS || 100000));
    await db.prepare('UPDATE admin_auth SET password_hash = ?, password_salt = ?, iterations = ?, updated_at = datetime(\'now\') WHERE id = 1')
      .bind(h.hash, h.salt, h.iterations).run();
  }

  const stored = await db.prepare('SELECT password_hash AS h, password_salt AS s, iterations AS i FROM admin_auth WHERE id = 1').first();
  const ok = await verifyPassword(password, stored.h, stored.s, stored.i);
  if (!ok) {
    await recordFailedAttempt(db, request, bucket);
    await logAudit(db, request, { event: 'login_failed', role: 'admin', userLabel: 'מנהל', success: false });
    return error('סיסמת מנהל שגויה', 401);
  }

  // 2FA gate: if enabled, the password alone is not enough — the client must
  // also send a valid TOTP or backup code. The first request answers
  // requires2FA so the UI can show the second-factor prompt.
  if (await admin2FAEnabled(db)) {
    if (!totpCode) {
      return json({ requires2FA: true }, { status: 401 });
    }
    const codeOk = await verifyAdmin2FACode(db, env, totpCode);
    if (!codeOk.ok) {
      await recordFailedAttempt(db, request, bucket);
      await logAudit(db, request, { event: 'login_failed', role: 'admin', userLabel: 'מנהל', success: false, meta: { reason: '2fa_code_invalid' } });
      return error('הקוד שגוי או כבר נוצל', 401);
    }
  }

  await clearAttempts(db, request, bucket);
  const session = await createSession(db, { role: 'admin', userLabel: 'מנהל' }, env, request);
  await logAudit(db, request, { event: 'login', role: 'admin', userLabel: 'מנהל', success: true });

  const res = json({ ok: true, role: 'admin', userLabel: 'מנהל', expiresAt: session.expiresAt });
  setCookie(res, env, session.token, 60 * 60 * Number(env.SESSION_TTL_HOURS || 12), request);
  return res;
}

async function loginTenant({ db, env, request, apartmentId, password, newPassword }) {
  if (!apartmentId) return error('יש לבחור דירה', 400);
  const apt = await db.prepare('SELECT id, number, password_hash AS h, password_salt AS s, iterations AS i FROM apartments WHERE id = ?').bind(apartmentId).first();
  if (!apt) return error('דירה לא קיימת', 404);
  // An apartment can be promoted to admin by another admin. The role on the
  // session is decided here (after password verification, below) based on
  // membership in apartment_admins.
  const adminRow = await db.prepare('SELECT 1 AS isAdmin FROM apartment_admins WHERE apartment_id = ?').bind(apt.id).first();
  const isAdminApt = !!adminRow?.isAdmin;
  const role = isAdminApt ? 'admin' : 'tenant';
  const userLabel = isAdminApt ? `${apt.number} (מנהל)` : String(apt.number);

  const bucket = `tenant:${apt.id}`;
  const rl = await checkRateLimit(db, request, bucket, env);
  if (!rl.allowed) {
    await logAudit(db, request, { event: 'login_rate_limited', role, userLabel, apartmentId: apt.id, success: false });
    return error('יותר מדי ניסיונות כושלים. נסו שוב מאוחר יותר.', 429, { retryAfterSec: rl.retryAfterSec });
  }

  if (!apt.h) {
    // First-time setup
    const setPwd = newPassword || password;
    if (!setPwd || setPwd.length < 4) {
      return error('בכניסה הראשונה יש להגדיר סיסמה של 4 תווים לפחות', 400);
    }
    const h = await hashPassword(setPwd, Number(env.PBKDF2_ITERATIONS || 100000));
    await db.prepare('UPDATE apartments SET password_hash = ?, password_salt = ?, iterations = ?, password_set_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
      .bind(h.hash, h.salt, h.iterations, apt.id).run();
    await clearAttempts(db, request, bucket);
    const session = await createSession(db, { role, apartmentId: apt.id, userLabel }, env, request);
    await logAudit(db, request, { event: 'login_first', role, userLabel, apartmentId: apt.id, success: true });
    const res = json({ ok: true, role, userLabel, apartmentId: apt.id, firstLogin: true, expiresAt: session.expiresAt });
    setCookie(res, env, session.token, 60 * 60 * Number(env.SESSION_TTL_HOURS || 12), request);
    return res;
  }

  if (!password) {
    await recordFailedAttempt(db, request, bucket);
    return error('סיסמה חסרה', 400);
  }
  const ok = await verifyPassword(password, apt.h, apt.s, apt.i);
  if (!ok) {
    await recordFailedAttempt(db, request, bucket);
    await logAudit(db, request, { event: 'login_failed', role, userLabel, apartmentId: apt.id, success: false });
    return error('סיסמה שגויה', 401);
  }

  await clearAttempts(db, request, bucket);
  const session = await createSession(db, { role, apartmentId: apt.id, userLabel }, env, request);
  await logAudit(db, request, { event: 'login', role, userLabel, apartmentId: apt.id, success: true });
  const res = json({ ok: true, role, userLabel, apartmentId: apt.id, expiresAt: session.expiresAt });
  setCookie(res, env, session.token, 60 * 60 * Number(env.SESSION_TTL_HOURS || 12), request);
  return res;
}
