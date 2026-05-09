// Grant / revoke admin privileges for a first-class owner.
// Only an existing admin may call this. When an owner is in owner_admins,
// any of their first-class sessions is automatically promoted to admin role
// (see functions/lib/session.js for the dynamic derivation).
//
//   POST   /api/owner-admin?id=OWNER_ID  — grant
//   DELETE /api/owner-admin?id=OWNER_ID  — revoke

import { json, error } from '../lib/util.js';
import { requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  const owner = await env.DB.prepare('SELECT id, name FROM owners WHERE id = ?').bind(id).first();
  if (!owner) return error('בעלים לא נמצא', 404);
  await env.DB.prepare('INSERT OR IGNORE INTO owner_admins (owner_id, granted_by) VALUES (?, ?)')
    .bind(owner.id, r.sess.userLabel || null).run();
  await logAudit(env.DB, request, {
    event: 'owner_admin_granted', role: 'admin', userLabel: r.sess.userLabel,
    meta: { ownerId: owner.id, name: owner.name }, success: true,
  });
  return json({ ok: true });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM owner_admins WHERE owner_id = ?').bind(id).run();
  // Kill the owner's active first-class sessions so the role downgrade is
  // immediate. (apartment_admins-based admin role for one of the owner's
  // apartments is independent and survives this revoke.)
  await env.DB.prepare(
    `DELETE FROM sessions
      WHERE id IN (SELECT session_id FROM session_owner WHERE owner_id = ?)`
  ).bind(id).run();
  await logAudit(env.DB, request, {
    event: 'owner_admin_revoked', role: 'admin', userLabel: r.sess.userLabel,
    meta: { ownerId: id }, success: true,
  });
  return json({ ok: true });
};
