// POST /api/admin/bulk-reset-passwords — master admin only.
// Body: {
//   apartmentIds?: [<id>, ...],
//   ownerIds?:     [<id>, ...],
//   newPassword:   '...'
// }
//
// Sets ONE common password for any combination of:
//   - apartment renters (apartments.password_hash) — picked via apartmentIds
//   - first-class owners (owners.password_hash)    — picked via ownerIds
// Plus, for backwards compat with the original "apartment-only" call, the
// owners linked to the selected apartments are ALSO reset (admin's mental
// model: "the same initial password for everyone associated with these
// apartments"). Owners that hold MULTIPLE selected apartments — or that are
// also passed explicitly via ownerIds — are only hashed once thanks to the
// Set deduplication below.

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { loadSession } from '../../lib/session.js';
import { hashPassword, validatePassword } from '../../lib/crypto.js';
import { stashPassword } from '../../lib/password-stash.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  const sess = await loadSession(db, request, env);
  // Master admin only — apartment-admins shouldn't be able to bulk-reset
  // passwords across the building.
  if (!sess || sess.role !== 'admin' || sess.apartmentId) return error('אין הרשאה', 403);

  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const newPassword = pickStr(body.newPassword, 200);
  const ids = Array.isArray(body.apartmentIds) ? body.apartmentIds.map(x => String(x).slice(0, 80)) : [];
  const directOwnerIds = Array.isArray(body.ownerIds) ? body.ownerIds.map(x => String(x).slice(0, 80)) : [];
  if (!ids.length && !directOwnerIds.length) return error('יש לבחור לפחות דירה או בעלים אחד', 400);
  if (ids.length > 200 || directOwnerIds.length > 200) return error('יותר מדי פריטים בבקשה אחת', 400);

  const v = validatePassword(newPassword);
  if (!v.ok) {
    return json({
      error: 'הסיסמה לא עומדת במדיניות (8+ תווים, אות גדולה+קטנה, ספרה, סימול)',
      passwordPolicy: v,
    }, { status: 400 });
  }

  // Verify all the apartments exist before doing any writes — atomicity light.
  const aptPlaceholders = ids.length ? ids.map(() => '?').join(',') : "''";
  const apts = ids.length
    ? await db.prepare(`SELECT id, number FROM apartments WHERE id IN (${aptPlaceholders})`).bind(...ids).all().then(r => r.results || [])
    : [];
  if (apts.length !== ids.length) {
    return error('חלק מהדירות שנבחרו לא נמצאו', 400);
  }

  // Hash once — same plaintext yields different hashes per row due to per-row
  // salt, but the salt+iterations are independent. Apply per-row.
  const iterations = Number(env.PBKDF2_ITERATIONS || 100000);
  let aptUpdated = 0;
  for (const apt of apts) {
    const h = await hashPassword(newPassword, iterations);
    await db.prepare(
      `UPDATE apartments SET password_hash = ?, password_salt = ?, iterations = ?, password_set_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).bind(h.hash, h.salt, h.iterations, apt.id).run();
    await stashPassword(db, env, 'apartment-tenant', apt.id, newPassword);
    // Kill tenant sessions only (owner sessions for the same apartment, if any, stay).
    await db.prepare(
      `DELETE FROM sessions
        WHERE apartment_id = ?
          AND id NOT IN (SELECT session_id FROM session_user_kind WHERE user_kind = 'owner')`
    ).bind(apt.id).run();
    aptUpdated++;
  }

  // Build the final owner-id set: any owner linked to one of the selected
  // apartments + any owner picked directly via the ownerIds param. Set
  // deduplicates collisions so an owner holding two selected apartments (or
  // explicitly listed in addition to one of their apartments) only gets hashed
  // once.
  const ownerSet = new Set(directOwnerIds);
  if (ids.length) {
    const linked = await db.prepare(
      `SELECT DISTINCT l.owner_id AS ownerId
         FROM apartment_owner_link l
        WHERE l.apartment_id IN (${aptPlaceholders})`
    ).bind(...ids).all().then(r => r.results || []);
    for (const r of linked) if (r.ownerId) ownerSet.add(r.ownerId);
  }
  // Verify all the explicitly-passed owners exist — no need to re-check
  // implicitly-linked ones since they were just JOINed from a real row.
  if (directOwnerIds.length) {
    const ownerPlaceholders = directOwnerIds.map(() => '?').join(',');
    const found = await db.prepare(
      `SELECT id FROM owners WHERE id IN (${ownerPlaceholders})`
    ).bind(...directOwnerIds).all().then(r => new Set((r.results || []).map(x => x.id)));
    for (const id of directOwnerIds) {
      if (!found.has(id)) return error('חלק מהבעלים שנבחרו לא נמצאו', 400);
    }
  }

  let ownerUpdated = 0;
  for (const ownerId of ownerSet) {
    const h = await hashPassword(newPassword, iterations);
    await db.prepare(
      `UPDATE owners SET password_hash = ?, password_salt = ?, iterations = ?, password_set_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).bind(h.hash, h.salt, h.iterations, ownerId).run();
    await stashPassword(db, env, 'owner', ownerId, newPassword);
    // Kill that owner's first-class session (apartmentId IS NULL, owner kind).
    await db.prepare(
      `DELETE FROM sessions
        WHERE id IN (SELECT session_id FROM session_owner WHERE owner_id = ?)`
    ).bind(ownerId).run();
    ownerUpdated++;
  }

  await logAudit(db, request, {
    event: 'bulk_password_reset', role: 'admin', userLabel: 'מנהל', success: true,
    meta: {
      apartmentCount: aptUpdated, ownerCount: ownerUpdated,
      apartmentNumbers: apts.map(a => String(a.number)),
    },
  });
  return json({ ok: true, count: aptUpdated, ownerCount: ownerUpdated, password: newPassword });
};
