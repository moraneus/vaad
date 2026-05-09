// POST /api/auth/login
// Body: { mode: 'admin' | 'tenant', password, apartmentId?, newPassword?, userKind? }
// - admin: validates against admin_auth row
// - tenant: validates against either the apartment's renter credentials
//           (apartments.password_hash) or its owner credentials
//           (apartment_owner_auth.password_hash) depending on userKind.
//           First-time setup applies per-credential. Both renter and owner
//           sessions get role='admin' if the apartment is in apartment_admins.

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
    const rawKind = pickStr(body.userKind, 16);
    const userKind = rawKind === 'owner' ? 'owner' : 'tenant';
    return loginTenant({ db, env, request, apartmentId, password, newPassword, userKind });
  }
  if (mode === 'owner') {
    // First-class owner login. Picks the owner via ownerId (from the public
    // dropdown) — mirrors the renter flow which picks an apartment via id.
    // loginEmail is also accepted as a backwards-compat lookup.
    const ownerId = pickStr(body.ownerId, 80);
    const loginEmail = pickStr(body.loginEmail, 254).trim().toLowerCase();
    return loginOwner({ db, env, request, ownerId, loginEmail, password });
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

async function loginTenant({ db, env, request, apartmentId, password, newPassword, userKind }) {
  if (!apartmentId) return error('יש לבחור דירה', 400);
  const apt = await db.prepare('SELECT id, number FROM apartments WHERE id = ?').bind(apartmentId).first();
  if (!apt) return error('דירה לא קיימת', 404);

  // Pick the right credential set based on userKind.
  const credRow = userKind === 'owner'
    ? await db.prepare('SELECT password_hash AS h, password_salt AS s, iterations AS i FROM apartment_owner_auth WHERE apartment_id = ?').bind(apt.id).first()
    : await db.prepare('SELECT password_hash AS h, password_salt AS s, iterations AS i FROM apartments WHERE id = ?').bind(apt.id).first();

  // An apartment can be promoted to admin by another admin. The role applies
  // to BOTH the renter and owner sessions for that apartment (per the
  // project's rule that they have identical permissions).
  const adminRow = await db.prepare('SELECT 1 AS isAdmin FROM apartment_admins WHERE apartment_id = ?').bind(apt.id).first();
  const isAdminApt = !!adminRow?.isAdmin;
  const role = isAdminApt ? 'admin' : 'tenant';
  const labelSuffix = userKind === 'owner'
    ? (isAdminApt ? ' (בעלים, מנהל)' : ' (בעלים)')
    : (isAdminApt ? ' (מנהל)' : '');
  const userLabel = `${apt.number}${labelSuffix}`;

  const bucket = `${userKind}:${apt.id}`;
  const rl = await checkRateLimit(db, request, bucket, env);
  if (!rl.allowed) {
    await logAudit(db, request, { event: 'login_rate_limited', role, userLabel, apartmentId: apt.id, success: false });
    return error('יותר מדי ניסיונות כושלים. נסו שוב מאוחר יותר.', 429, { retryAfterSec: rl.retryAfterSec });
  }

  // First-time setup: no credentials stored yet for this user-kind.
  if (!credRow?.h) {
    const setPwd = newPassword || password;
    if (!setPwd || setPwd.length < 4) {
      return error('בכניסה הראשונה יש להגדיר סיסמה של 4 תווים לפחות', 400);
    }
    const h = await hashPassword(setPwd, Number(env.PBKDF2_ITERATIONS || 100000));
    if (userKind === 'owner') {
      await db.prepare(
        `INSERT INTO apartment_owner_auth (apartment_id, password_hash, password_salt, iterations, password_set_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(apartment_id) DO UPDATE SET
           password_hash = excluded.password_hash,
           password_salt = excluded.password_salt,
           iterations = excluded.iterations,
           password_set_at = excluded.password_set_at,
           updated_at = excluded.updated_at`
      ).bind(apt.id, h.hash, h.salt, h.iterations).run();
    } else {
      await db.prepare('UPDATE apartments SET password_hash = ?, password_salt = ?, iterations = ?, password_set_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
        .bind(h.hash, h.salt, h.iterations, apt.id).run();
    }
    await clearAttempts(db, request, bucket);
    const session = await createSession(db, { role, apartmentId: apt.id, userLabel, userKind }, env, request);
    await logAudit(db, request, { event: 'login_first', role, userLabel, apartmentId: apt.id, success: true, meta: { userKind } });
    const res = json({ ok: true, role, userLabel, apartmentId: apt.id, userKind, firstLogin: true, expiresAt: session.expiresAt });
    setCookie(res, env, session.token, 60 * 60 * Number(env.SESSION_TTL_HOURS || 12), request);
    return res;
  }

  if (!password) {
    await recordFailedAttempt(db, request, bucket);
    return error('סיסמה חסרה', 400);
  }
  const ok = await verifyPassword(password, credRow.h, credRow.s, credRow.i);
  if (!ok) {
    await recordFailedAttempt(db, request, bucket);
    await logAudit(db, request, { event: 'login_failed', role, userLabel, apartmentId: apt.id, success: false, meta: { userKind } });
    return error('סיסמה שגויה', 401);
  }

  await clearAttempts(db, request, bucket);
  const session = await createSession(db, { role, apartmentId: apt.id, userLabel, userKind }, env, request);
  await logAudit(db, request, { event: 'login', role, userLabel, apartmentId: apt.id, success: true, meta: { userKind } });
  const res = json({ ok: true, role, userLabel, apartmentId: apt.id, userKind, expiresAt: session.expiresAt });
  setCookie(res, env, session.token, 60 * 60 * Number(env.SESSION_TTL_HOURS || 12), request);
  return res;
}

// Owner login — first-class entity. Looks up by login_email + password against
// `owners`. The session has userKind='owner', no apartmentId (since one owner
// can hold multiple apartments — the frontend lets them pick one to view).
async function loginOwner({ db, env, request, ownerId, loginEmail, password }) {
  // Lookup by ownerId (from the public dropdown) — preferred. loginEmail
  // path is kept for backwards compat with older clients that posted email.
  let owner = null;
  if (ownerId) {
    owner = await db.prepare(
      `SELECT id, name, password_hash AS h, password_salt AS s, iterations AS i
         FROM owners WHERE id = ?`
    ).bind(ownerId).first();
  } else if (loginEmail) {
    owner = await db.prepare(
      `SELECT id, name, password_hash AS h, password_salt AS s, iterations AS i
         FROM owners WHERE LOWER(login_email) = ?`
    ).bind(loginEmail).first();
  }
  if (!owner) {
    if (!ownerId && !loginEmail) return error('יש לבחור בעלים', 400);
    await logAudit(db, request, { event: 'login_failed', role: 'tenant', userLabel: `owner:${ownerId || loginEmail}`, success: false, meta: { reason: 'unknown_owner' } });
    return error('פרטי כניסה שגויים', 401);
  }

  const bucket = `owner:${owner.id}`;
  const rl = await checkRateLimit(db, request, bucket, env);
  if (!rl.allowed) {
    await logAudit(db, request, { event: 'login_rate_limited', role: 'tenant', userLabel: `owner:${owner.id}`, success: false });
    return error('יותר מדי ניסיונות כושלים. נסו שוב מאוחר יותר.', 429, { retryAfterSec: rl.retryAfterSec });
  }

  const userLabel = `${owner.name} (בעלים)`;

  // No password set: admin hasn't initialized this owner yet. Mirror the
  // renter flow — refuse self-setup, point the user back to the admin.
  if (!owner.h) {
    await logAudit(db, request, { event: 'login_failed', role: 'tenant', userLabel, success: false, meta: { userKind: 'owner', ownerId: owner.id, reason: 'no_initial_password' } });
    return error('לא נמצאה סיסמה ראשונית. פנה למנהל הוועד.', 401);
  }

  if (!password) {
    await recordFailedAttempt(db, request, bucket);
    return error('סיסמה חסרה', 400);
  }
  const ok = await verifyPassword(password, owner.h, owner.s, owner.i);
  if (!ok) {
    await recordFailedAttempt(db, request, bucket);
    await logAudit(db, request, { event: 'login_failed', role: 'tenant', userLabel, success: false, meta: { userKind: 'owner', ownerId: owner.id } });
    return error('פרטי כניסה שגויים', 401);
  }

  await clearAttempts(db, request, bucket);
  // If any apartment owned by this owner is in apartment_admins, the owner
  // session is admin. Mirrors the apartment-bound admin grant.
  const adminRow = await db.prepare(
    `SELECT 1 AS isAdmin
       FROM apartment_owner_link l
       JOIN apartment_admins aa ON aa.apartment_id = l.apartment_id
      WHERE l.owner_id = ?
      LIMIT 1`
  ).bind(owner.id).first();
  const role = adminRow?.isAdmin ? 'admin' : 'tenant';
  const ownerLabel = role === 'admin' ? `${owner.name} (בעלים, מנהל)` : userLabel;
  const session = await createSession(db, { role, apartmentId: null, userLabel: ownerLabel, userKind: 'owner', ownerId: owner.id }, env, request);
  await logAudit(db, request, { event: 'login', role, userLabel: ownerLabel, success: true, meta: { userKind: 'owner', ownerId: owner.id } });
  const res = json({ ok: true, role, userLabel: ownerLabel, ownerId: owner.id, userKind: 'owner', expiresAt: session.expiresAt });
  setCookie(res, env, session.token, 60 * 60 * Number(env.SESSION_TTL_HOURS || 12), request);
  return res;
}

