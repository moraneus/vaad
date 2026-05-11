// POST   /api/document-links { documentId, targetType, targetId }
// DELETE /api/document-links?documentId=...&targetType=...&targetId=...

import { json, error, readJSON, pickStr } from '../lib/util.js';
import { requireAdmin, requireSession } from '../lib/guard.js';

// `infrastructure_expense`, `expense_payment` and `ticket` are stored in
// separate junction tables — the document_links CHECK constraint can't be
// widened idempotently to admit them.
const ALLOWED_TYPES = new Set(['expense', 'payment', 'infrastructure_expense', 'expense_payment', 'ticket']);

// Tickets are the one target where non-admins can attach (creator while
// the ticket is still open). Everything else stays admin-only.
async function authorizeLink(env, request, targetType, targetId) {
  if (targetType === 'ticket') {
    const r = await requireSession(env, request);
    if (r.error) return r;
    if (r.sess.role === 'admin') return r;
    const cur = await env.DB.prepare('SELECT opened_by_kind AS k, opened_by_id AS oid, status FROM tickets WHERE id = ?')
      .bind(targetId).first();
    if (!cur) return { error: error('פנייה לא נמצאה', 404) };
    if (cur.status !== 'open') return { error: error('הפנייה סגורה', 403) };
    const kind = r.sess.userKind === 'owner' ? 'owner'
              : (r.sess.userKind === 'tenant' ? 'apartment-tenant' : 'admin');
    const id = r.sess.ownerId || r.sess.apartmentId || null;
    if (cur.k !== kind || (cur.oid || null) !== id) {
      return { error: error('אין הרשאה לפנייה זו', 403) };
    }
    return r;
  }
  return requireAdmin(env, request);
}

export const onRequestPost = async ({ request, env }) => {
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const documentId = pickStr(body.documentId, 80);
  const targetType = pickStr(body.targetType, 32);
  const targetId = pickStr(body.targetId, 80);
  if (!documentId || !ALLOWED_TYPES.has(targetType) || !targetId) return error('שדות חסרים', 400);
  const r = await authorizeLink(env, request, targetType, targetId); if (r.error) return r.error;
  if (targetType === 'infrastructure_expense') {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO infrastructure_expense_documents (document_id, expense_id) VALUES (?, ?)'
    ).bind(documentId, targetId).run();
  } else if (targetType === 'expense_payment') {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO expense_payment_documents (document_id, payment_id) VALUES (?, ?)'
    ).bind(documentId, targetId).run();
  } else if (targetType === 'ticket') {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO ticket_documents (document_id, ticket_id) VALUES (?, ?)'
    ).bind(documentId, targetId).run();
  } else {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO document_links (document_id, target_type, target_id) VALUES (?, ?, ?)'
    ).bind(documentId, targetType, targetId).run();
  }
  return json({ ok: true });
};

export const onRequestDelete = async ({ request, env }) => {
  const u = new URL(request.url).searchParams;
  const targetType = u.get('targetType');
  const targetId = u.get('targetId');
  if (!ALLOWED_TYPES.has(targetType)) return error('targetType לא תקף', 400);
  const r = await authorizeLink(env, request, targetType, targetId); if (r.error) return r.error;
  if (targetType === 'infrastructure_expense') {
    await env.DB.prepare(
      'DELETE FROM infrastructure_expense_documents WHERE document_id = ? AND expense_id = ?'
    ).bind(u.get('documentId'), targetId).run();
  } else if (targetType === 'expense_payment') {
    await env.DB.prepare(
      'DELETE FROM expense_payment_documents WHERE document_id = ? AND payment_id = ?'
    ).bind(u.get('documentId'), targetId).run();
  } else if (targetType === 'ticket') {
    await env.DB.prepare(
      'DELETE FROM ticket_documents WHERE document_id = ? AND ticket_id = ?'
    ).bind(u.get('documentId'), targetId).run();
  } else {
    await env.DB.prepare('DELETE FROM document_links WHERE document_id = ? AND target_type = ? AND target_id = ?')
      .bind(u.get('documentId'), targetType, targetId).run();
  }
  return json({ ok: true });
};
