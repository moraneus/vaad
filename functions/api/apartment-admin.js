// Grant / revoke admin privileges for an apartment user.
// Only an existing admin may call this. Once an apartment is in
// apartment_admins, that apartment's user logs in with full admin role.
//
//   POST   /api/apartment-admin?id=APARTMENT_ID  — grant
//   DELETE /api/apartment-admin?id=APARTMENT_ID  — revoke

import { json, error } from '../lib/util.js';
import { requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  const apt = await env.DB.prepare('SELECT id, number FROM apartments WHERE id = ?').bind(id).first();
  if (!apt) return error('דירה לא נמצאה', 404);
  await env.DB.prepare('INSERT OR IGNORE INTO apartment_admins (apartment_id, granted_by) VALUES (?, ?)')
    .bind(apt.id, r.sess.userLabel || null).run();
  await logAudit(env.DB, request, { event: 'apartment_admin_granted', role: 'admin', userLabel: r.sess.userLabel, apartmentId: apt.id, meta: { number: apt.number }, success: true });
  return json({ ok: true });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM apartment_admins WHERE apartment_id = ?').bind(id).run();
  // Revoke any active sessions tied to this apartment so the role downgrade
  // takes effect immediately. Two paths:
  //   1) Apartment-bound sessions (renter / legacy PR-B owner): apartment_id matches.
  //   2) First-class owner sessions (PR-E): apartment_id IS NULL but session_owner
  //      points to an owner whose apartment_owner_link row is THIS apartment.
  await env.DB.prepare('DELETE FROM sessions WHERE apartment_id = ?').bind(id).run();
  await env.DB.prepare(
    `DELETE FROM sessions
      WHERE id IN (
        SELECT so.session_id
          FROM session_owner so
          JOIN apartment_owner_link l ON l.owner_id = so.owner_id
         WHERE l.apartment_id = ?
      )`
  ).bind(id).run();
  await logAudit(env.DB, request, { event: 'apartment_admin_revoked', role: 'admin', userLabel: r.sess.userLabel, apartmentId: id, success: true });
  return json({ ok: true });
};
