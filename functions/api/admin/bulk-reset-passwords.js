// POST /api/admin/bulk-reset-passwords — master admin only.
// Body: { apartmentIds: [<id>, ...], newPassword: '...' }
//
// Sets ONE common password for all the selected apartments' tenant credentials.
// Validates against the password policy, hashes once, applies to each.
// Stashes the plaintext per apartment (admin can re-display via the password
// manager) and kills active tenant sessions for those apartments so the new
// password takes effect immediately.

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
  if (!ids.length) return error('יש לבחור לפחות דירה אחת', 400);
  if (ids.length > 200) return error('יותר מדי דירות בבקשה אחת', 400);

  const v = validatePassword(newPassword);
  if (!v.ok) {
    return json({
      error: 'הסיסמה לא עומדת במדיניות (8+ תווים, אות גדולה+קטנה, ספרה, סימול)',
      passwordPolicy: v,
    }, { status: 400 });
  }

  // Verify all the apartments exist before doing any writes — atomicity light.
  const placeholders = ids.map(() => '?').join(',');
  const apts = await db.prepare(
    `SELECT id, number FROM apartments WHERE id IN (${placeholders})`
  ).bind(...ids).all().then(r => r.results || []);
  if (apts.length !== ids.length) {
    return error('חלק מהדירות שנבחרו לא נמצאו', 400);
  }

  // Hash once — same plaintext yields different hashes per apartment due to
  // per-row salt, but the salt+iterations are independent. Apply per-row.
  // (We could share the salt across rows for efficiency, but that's
  // unconventional and offers no security benefit.)
  const iterations = Number(env.PBKDF2_ITERATIONS || 100000);
  let updated = 0;
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
    updated++;
  }

  await logAudit(db, request, {
    event: 'bulk_password_reset', role: 'admin', userLabel: 'מנהל', success: true,
    meta: { count: updated, apartmentNumbers: apts.map(a => String(a.number)) },
  });
  return json({ ok: true, count: updated, password: newPassword });
};
