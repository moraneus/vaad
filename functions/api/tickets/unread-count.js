// Admin-only: how many tickets were created after the admin's last visit
// to the tickets view. Drives the bell badge + toast on the client.
//
//   GET  /api/tickets/unread-count               — { count }
//   POST /api/tickets/unread-count?op=mark-seen  — bump last_seen_at to now

import { json, error } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';

function adminKey(sess) {
  // Distinct admins (master, owner-admin, apartment-admin) have different
  // session sources; we key on (kind, id-or-label) so each gets their own
  // "seen" cursor.
  if (sess.ownerId) return { kind: 'owner', id: sess.ownerId };
  if (sess.apartmentId) return { kind: 'apartment', id: sess.apartmentId };
  return { kind: 'master', id: sess.userLabel || 'admin' };
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const k = adminKey(r.sess);
  const seen = await env.DB.prepare('SELECT last_seen_at FROM ticket_seen WHERE admin_kind = ? AND admin_id = ?')
    .bind(k.kind, k.id).first();
  const cutoff = seen?.last_seen_at || '1970-01-01';
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tickets WHERE datetime(opened_at) > datetime(?)"
  ).bind(cutoff).first();
  return json({ count: Number(row?.n || 0), since: cutoff });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const op = new URL(request.url).searchParams.get('op');
  if (op !== 'mark-seen') return error('פעולה לא תקפה', 400);
  const k = adminKey(r.sess);
  await env.DB.prepare(
    "INSERT INTO ticket_seen (admin_kind, admin_id, last_seen_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(admin_kind, admin_id) DO UPDATE SET last_seen_at = datetime('now')"
  ).bind(k.kind, k.id).run();
  return json({ ok: true });
};
