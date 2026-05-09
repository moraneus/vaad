// POST /api/auth/reset-apartment — admin only.
// Body: { apartmentId, userKind?: 'tenant' | 'owner' }
//
// Used both for "I forgot my password" admin-resets AND for the "replace
// resident" flow — when a renter or property owner is replaced, the admin
// wipes the credentials + recovery email for that role so the new person
// sets a fresh password and registers a fresh recovery account on first
// login. Apartment payment history (payments, adjustments, infrastructure
// demands, etc.) is NEVER touched — it's owned by the apartment, not by
// the resident. Only credentials, recovery, and (for tenant) the opt-in
// email are cleared.
//
// userKind selects which credential set is reset:
//   tenant (default) → apartments.password_*, apartment_recovery, apartment_email,
//                      kill tenant sessions
//   owner            → apartment_owner_auth.password_*, apartment_owner_recovery,
//                      kill owner sessions

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { loadSession } from '../../lib/session.js';
import { logAudit } from '../../lib/audit.js';
import { generateRandomPassword, hashPassword, validatePassword } from '../../lib/crypto.js';
import { stashPassword } from '../../lib/password-stash.js';

// Resolve the new password for the reset operation:
//   - If the admin supplied newPassword, validate against the policy and use it.
//   - If the admin supplied randomize=true (or nothing), generate a random one.
//   - Returns { plaintext } so the caller can hash + return the plaintext once.
function resolveNewPassword(body) {
  const supplied = pickStr(body.newPassword, 200);
  if (supplied) {
    const v = validatePassword(supplied);
    if (!v.ok) {
      return { error: 'הסיסמה לא עומדת במדיניות (8+ תווים, אות גדולה+קטנה, ספרה, סימול)', passwordPolicy: v };
    }
    return { plaintext: supplied };
  }
  return { plaintext: generateRandomPassword(8) };
}

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  const sess = await loadSession(db, request, env);
  // Master admin only — apartment-admins can't reset other apartments.
  if (!sess || sess.role !== 'admin' || sess.apartmentId) return error('אין הרשאה', 403);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const apartmentId = pickStr(body.apartmentId, 80);
  const userKind = pickStr(body.userKind, 16) === 'owner' ? 'owner' : 'tenant';
  const apt = await db.prepare('SELECT id, number FROM apartments WHERE id = ?').bind(apartmentId).first();
  if (!apt) return error('דירה לא נמצאה', 404);

  // Resolve + hash the new password (admin-typed or random).
  const resolved = resolveNewPassword(body);
  if (resolved.error) return json(resolved, { status: 400 });
  const { plaintext } = resolved;
  const h = await hashPassword(plaintext, Number(env.PBKDF2_ITERATIONS || 100000));

  if (userKind === 'owner') {
    // Legacy per-apartment owner credentials (PR B). Set the new hash so the
    // owner can log in with the admin-given password, instead of nulling.
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
    await db.prepare('DELETE FROM apartment_owner_recovery WHERE apartment_id = ?').bind(apt.id).run();
    await db.prepare(
      `DELETE FROM sessions
        WHERE apartment_id = ?
          AND id IN (SELECT session_id FROM session_user_kind WHERE user_kind = 'owner')`
    ).bind(apt.id).run();
    await stashPassword(db, env, 'apartment-owner-legacy', apt.id, plaintext);
    await logAudit(db, request, { event: 'apartment_owner_reset', role: 'admin', userLabel: 'מנהל', apartmentId: apt.id, meta: { number: apt.number }, success: true });
    return json({ ok: true, userKind, initialPassword: plaintext });
  }

  // Tenant (default).
  await db.prepare(
    `UPDATE apartments SET password_hash = ?, password_salt = ?, iterations = ?, password_set_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).bind(h.hash, h.salt, h.iterations, apt.id).run();
  await db.prepare('DELETE FROM apartment_recovery WHERE apartment_id = ?').bind(apt.id).run();
  // The apartment_email opt-in is tied to the resident — wipe it too so the
  // new resident isn't accidentally subscribed.
  await db.prepare('DELETE FROM apartment_email WHERE apartment_id = ?').bind(apt.id).run();
  await db.prepare(
    `DELETE FROM sessions
      WHERE apartment_id = ?
        AND id NOT IN (SELECT session_id FROM session_user_kind WHERE user_kind = 'owner')`
  ).bind(apt.id).run();
  await stashPassword(db, env, 'apartment-tenant', apt.id, plaintext);
  await logAudit(db, request, { event: 'apartment_password_reset', role: 'admin', userLabel: 'מנהל', apartmentId: apt.id, meta: { number: apt.number }, success: true });
  return json({ ok: true, userKind: 'tenant', initialPassword: plaintext });
};
