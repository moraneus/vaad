// Comments thread on a ticket.
//
//   POST   /api/tickets/comments?ticketId=...   — any logged-in role
//   DELETE /api/tickets/comments?id=...         — author or admin

import { json, error, readJSON, pickStr, uid } from '../../lib/util.js';
import { requireSession, requireAdmin } from '../../lib/guard.js';
import { logAudit } from '../../lib/audit.js';

function actorFromSession(sess) {
  const kind = sess.userKind === 'owner' ? 'owner'
            : (sess.role === 'admin' && !sess.apartmentId && !sess.ownerId) ? 'admin'
            : (sess.userKind === 'tenant' ? 'apartment-tenant' : 'admin');
  const id = sess.ownerId || sess.apartmentId || null;
  return { kind, id, label: sess.userLabel || 'משתמש' };
}

export const onRequestPost = async ({ request, env }) => {
  const r = await requireSession(env, request); if (r.error) return r.error;
  const ticketId = new URL(request.url).searchParams.get('ticketId');
  if (!ticketId) return error('ticketId חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const text = pickStr(body.body, 4000).trim();
  if (!text) return error('תוכן ההודעה חסר', 400);

  const ticket = await env.DB.prepare('SELECT id FROM tickets WHERE id = ?').bind(ticketId).first();
  if (!ticket) return error('פנייה לא נמצאה', 404);

  const actor = actorFromSession(r.sess);
  const id = uid('tc-');
  await env.DB.prepare(
    'INSERT INTO ticket_comments (id, ticket_id, body, author_kind, author_id, author_label) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, ticketId, text, actor.kind, actor.id, actor.label).run();
  // Touch the parent ticket so unread-count picks up the activity.
  await env.DB.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").bind(ticketId).run();
  await logAudit(env.DB, request, { event: 'ticket_comment_added', role: r.sess.role, userLabel: actor.label, success: true, meta: { ticketId, id } });

  const row = await env.DB.prepare(
    'SELECT id, body, author_kind AS authorKind, author_id AS authorId, author_label AS authorLabel, created_at AS createdAt FROM ticket_comments WHERE id = ?'
  ).bind(id).first();
  return json(row, { status: 201 });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireSession(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  const cur = await env.DB.prepare('SELECT author_kind AS k, author_id AS oid FROM ticket_comments WHERE id = ?').bind(id).first();
  if (!cur) return error('הערה לא נמצאה', 404);
  const actor = actorFromSession(r.sess);
  const isAdmin = r.sess.role === 'admin';
  const isAuthor = cur.k === actor.kind && (cur.oid || null) === (actor.id || null);
  if (!isAdmin && !isAuthor) return error('אין הרשאה למחוק הערה זו', 403);
  await env.DB.prepare('DELETE FROM ticket_comments WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'ticket_comment_deleted', role: r.sess.role, userLabel: actor.label, success: true, meta: { id } });
  return json({ ok: true });
};
