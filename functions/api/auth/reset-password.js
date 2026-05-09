// POST /api/auth/reset-password  { token, newPassword, apartmentId?, role? }
// Completes a password reset using a token minted by the identity-OAuth
// callback (after Google verified the user owns the registered recovery email).
//
// Three flavors:
//   * Master admin reset — body has no apartmentId. Token from `password_reset_tokens`.
//     Replaces admin_auth password, disables 2FA, kills master-admin sessions.
//   * Apartment renter reset — body has apartmentId, role omitted or 'tenant'.
//     Token from `apartment_password_reset_tokens`. Replaces apartments.password_hash
//     and kills tenant sessions of that apartment.
//   * Apartment owner reset  — body has apartmentId AND role='owner'.
//     Token from `apartment_owner_password_reset_tokens`. Replaces
//     apartment_owner_auth.password_hash and kills owner sessions of that
//     apartment (renter sessions of the same apartment are untouched).

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
  const apartmentId = pickStr(body.apartmentId, 80);
  const ownerId = pickStr(body.ownerId, 80);
  const role = String(body?.role || '').trim();
  const userKind = role === 'owner' ? 'owner' : 'tenant';
  if (!token || !newPassword) return error('שדות חובה חסרים', 400);
  if (newPassword.length < 4) return error('הסיסמה החדשה חייבת לכלול 4 תווים לפחות', 400);

  const tokenHash = await sha256Hex(token);

  if (ownerId) {
    // First-class owner (PR E) reset.
    const row = await db.prepare(
      `SELECT id, owner_id AS ownerId, expires_at AS expiresAt, used_at AS usedAt
         FROM owner_password_reset_tokens WHERE token_hash = ? LIMIT 1`
    ).bind(tokenHash).first();
    if (!row || row.ownerId !== ownerId) {
      await logAudit(db, request, { event: 'pwreset_failed', role: 'tenant', userLabel: `owner:${ownerId}`, success: false, meta: { reason: 'unknown_token' } });
      return error('לינק לא תקף', 400);
    }
    if (row.usedAt) return error('הלינק כבר נוצל. בקש לינק חדש.', 400);
    if (new Date(row.expiresAt) < new Date()) return error('הלינק פג תוקף. בקש לינק חדש.', 400);

    const h = await hashPassword(newPassword, Number(env.PBKDF2_ITERATIONS || 100000));
    await db.prepare(
      "UPDATE owners SET password_hash = ?, password_salt = ?, iterations = ?, password_set_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).bind(h.hash, h.salt, h.iterations, ownerId).run();
    await db.prepare(`UPDATE owner_password_reset_tokens SET used_at = datetime('now') WHERE id = ?`).bind(row.id).run();
    // Kill all sessions for this owner.
    await db.prepare(
      `DELETE FROM sessions WHERE id IN (SELECT session_id FROM session_owner WHERE owner_id = ?)`
    ).bind(ownerId).run();
    await logAudit(db, request, { event: 'pwreset_completed', role: 'tenant', userLabel: `owner:${ownerId}`, success: true, meta: { ownerId } });
    return json({ ok: true });
  }

  if (apartmentId) {
    // Apartment reset path — pick the right token + auth tables based on role.
    const tokenTable = userKind === 'owner' ? 'apartment_owner_password_reset_tokens' : 'apartment_password_reset_tokens';
    const row = await db.prepare(
      `SELECT id, apartment_id AS apartmentId, expires_at AS expiresAt, used_at AS usedAt
         FROM ${tokenTable}
        WHERE token_hash = ? LIMIT 1`
    ).bind(tokenHash).first();

    if (!row || row.apartmentId !== apartmentId) {
      await logAudit(db, request, { event: 'pwreset_failed', role: 'tenant', userLabel: `apt:${apartmentId}`, apartmentId, success: false, meta: { reason: 'unknown_token', userKind } });
      return error('לינק לא תקף', 400);
    }
    if (row.usedAt) {
      await logAudit(db, request, { event: 'pwreset_failed', role: 'tenant', userLabel: `apt:${apartmentId}`, apartmentId, success: false, meta: { reason: 'token_used', userKind } });
      return error('הלינק כבר נוצל. אם הסיסמה לא משוחזרה, בקש לינק חדש.', 400);
    }
    if (new Date(row.expiresAt) < new Date()) {
      await logAudit(db, request, { event: 'pwreset_failed', role: 'tenant', userLabel: `apt:${apartmentId}`, apartmentId, success: false, meta: { reason: 'token_expired', userKind } });
      return error('הלינק פג תוקף. בקש לינק חדש.', 400);
    }

    const h = await hashPassword(newPassword, Number(env.PBKDF2_ITERATIONS || 100000));
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
      ).bind(apartmentId, h.hash, h.salt, h.iterations).run();
      // Kill ONLY owner sessions of this apartment (identified via session_user_kind).
      await db.prepare(
        `DELETE FROM sessions
          WHERE apartment_id = ?
            AND id IN (SELECT session_id FROM session_user_kind WHERE user_kind = 'owner')`
      ).bind(apartmentId).run();
    } else {
      await db.prepare(
        `UPDATE apartments SET password_hash = ?, password_salt = ?, iterations = ?, password_set_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).bind(h.hash, h.salt, h.iterations, apartmentId).run();
      // Kill ONLY tenant sessions of this apartment (anything that's NOT marked
      // as owner in session_user_kind).
      await db.prepare(
        `DELETE FROM sessions
          WHERE apartment_id = ?
            AND id NOT IN (SELECT session_id FROM session_user_kind WHERE user_kind = 'owner')`
      ).bind(apartmentId).run();
    }
    await db.prepare(`UPDATE ${tokenTable} SET used_at = datetime('now') WHERE id = ?`).bind(row.id).run();
    await logAudit(db, request, { event: 'pwreset_completed', role: 'tenant', userLabel: `apt:${apartmentId}${userKind === 'owner' ? ' (בעלים)' : ''}`, apartmentId, success: true, meta: { userKind } });
    return json({ ok: true });
  }

  // Master admin reset path.
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

  const h = await hashPassword(newPassword, Number(env.PBKDF2_ITERATIONS || 100000));
  await db.prepare(
    `UPDATE admin_auth SET password_hash = ?, password_salt = ?, iterations = ?, updated_at = datetime('now') WHERE id = 1`
  ).bind(h.hash, h.salt, h.iterations).run();
  await db.prepare(`UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?`).bind(row.id).run();
  // Master-admin reset disables 2FA + kills master-admin sessions only.
  await disableAdmin2FA(db);
  await db.prepare(`DELETE FROM sessions WHERE role = 'admin' AND apartment_id IS NULL`).run();

  await logAudit(db, request, { event: 'pwreset_completed', role: 'admin', userLabel: 'מנהל', success: true });
  return json({ ok: true });
};
