// Tickets / building-issue reports.
//
//   GET    /api/tickets             — list all (any logged-in role)
//   GET    /api/tickets?id=xxx      — single ticket with comments + image refs
//   POST   /api/tickets             — create (any logged-in role)
//   PUT    /api/tickets?id=xxx      — edit (creator while open OR admin)
//   PATCH  /api/tickets?id=xxx&op=close|reopen|link-expense   (admin only)
//   DELETE /api/tickets?id=xxx      — admin only
//
// Comments live at /api/tickets/comments. Unread-count at
// /api/tickets/unread-count. Image uploads reuse the generic /api/documents
// upload pipeline + the ticket_documents junction table written here.

import { json, error, readJSON, pickStr, uid } from '../lib/util.js';
import { requireRead, requireAdmin, requireSession } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';
import { sendEmail, emailEnabledAsync } from '../lib/email.js';

const VALID_CATEGORIES = new Set([
  'electricity', 'plumbing', 'sewage', 'elevator', 'cleaning',
  'garden', 'parking', 'security', 'intercom', 'renovation', 'other',
]);

const SAFE_FIELDS = `id, title, description, category, custom_category AS customCategory,
  opened_by_kind AS openedByKind, opened_by_id AS openedById, opened_by_label AS openedByLabel,
  opened_at AS openedAt, closed_at AS closedAt, closed_by_label AS closedByLabel,
  status, expense_id AS expenseId, updated_at AS updatedAt`;

async function hydrateTicket(db, ticket) {
  const docs = await db.prepare('SELECT document_id AS id FROM ticket_documents WHERE ticket_id = ?').bind(ticket.id).all();
  ticket.documents = (docs.results || []).map(r => r.id);
  const comments = await db.prepare(
    'SELECT id, body, author_kind AS authorKind, author_id AS authorId, author_label AS authorLabel, created_at AS createdAt ' +
    'FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC'
  ).bind(ticket.id).all();
  ticket.comments = comments.results || [];
  return ticket;
}

// Builds a {kind, id, label} snapshot describing the actor behind this
// request — used as opened_by / author for tickets and comments.
function actorFromSession(sess) {
  // userKind from session: 'admin' | 'owner' | 'tenant'.
  // For tenants we tag as 'apartment-tenant' for clarity in the data.
  const kind = sess.userKind === 'owner' ? 'owner'
            : (sess.role === 'admin' && !sess.apartmentId && !sess.ownerId) ? 'admin'
            : (sess.userKind === 'tenant' ? 'apartment-tenant' : 'admin');
  const id = sess.ownerId || sess.apartmentId || null;
  return { kind, id, label: sess.userLabel || 'משתמש' };
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (id) {
    const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM tickets WHERE id = ?`).bind(id).first();
    if (!row) return error('פנייה לא נמצאה', 404);
    await hydrateTicket(env.DB, row);
    return json(row);
  }
  const rows = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM tickets ORDER BY opened_at DESC`).all();
  const tickets = rows.results || [];
  // Bulk-hydrate documents and comments to avoid N round-trips.
  if (tickets.length) {
    const ids = tickets.map(t => t.id);
    const placeholders = ids.map(() => '?').join(',');
    const docRows = await env.DB.prepare(`SELECT ticket_id AS tid, document_id AS id FROM ticket_documents WHERE ticket_id IN (${placeholders})`).bind(...ids).all();
    const docMap = new Map();
    for (const r of (docRows.results || [])) {
      if (!docMap.has(r.tid)) docMap.set(r.tid, []);
      docMap.get(r.tid).push(r.id);
    }
    const cmtRows = await env.DB.prepare(
      'SELECT id, ticket_id AS tid, body, author_kind AS authorKind, author_id AS authorId, author_label AS authorLabel, created_at AS createdAt ' +
      `FROM ticket_comments WHERE ticket_id IN (${placeholders}) ORDER BY created_at ASC`
    ).bind(...ids).all();
    const cmtMap = new Map();
    for (const r of (cmtRows.results || [])) {
      if (!cmtMap.has(r.tid)) cmtMap.set(r.tid, []);
      cmtMap.get(r.tid).push({ id: r.id, body: r.body, authorKind: r.authorKind, authorId: r.authorId, authorLabel: r.authorLabel, createdAt: r.createdAt });
    }
    for (const t of tickets) {
      t.documents = docMap.get(t.id) || [];
      t.comments = cmtMap.get(t.id) || [];
    }
  }
  return json({ tickets });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireSession(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const title = pickStr(body.title, 200).trim();
  const description = pickStr(body.description, 4000);
  const category = pickStr(body.category, 30);
  const customCategory = pickStr(body.customCategory, 100);
  if (!title) return error('כותרת חסרה', 400);
  if (!VALID_CATEGORIES.has(category)) return error('קטגוריה לא תקפה', 400);
  if (category === 'other' && !customCategory) return error('יש לציין קטגוריה כאשר נבחר "אחר"', 400);

  const actor = actorFromSession(r.sess);
  const id = uid('tk-');
  await env.DB.prepare(
    'INSERT INTO tickets (id, title, description, category, custom_category, opened_by_kind, opened_by_id, opened_by_label, status) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, title, description || null, category, customCategory || null, actor.kind, actor.id, actor.label, 'open').run();

  await logAudit(env.DB, request, { event: 'ticket_created', role: r.sess.role, userLabel: actor.label, success: true, meta: { id, title, category } });

  // Fire-and-forget email to the admin if the channel is configured. We
  // don't await — a slow Resend response shouldn't block ticket creation.
  // ctx.waitUntil would be ideal, but ad-hoc Promise.resolve works too.
  (async () => {
    try {
      if (!(await emailEnabledAsync(env))) return;
      const statusRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'tickets_email_status'").first();
      if (statusRow?.value !== 'enabled') return;
      const recRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'tickets_admin_email'").first();
      const recipient = recRow?.value;
      if (!recipient) return;
      const bnRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'building_name'").first();
      const building = bnRow?.value || 'ועד הבית';
      const subject = `[${building}] פנייה חדשה: ${title}`;
      const html = `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
          <h2 style="margin:0 0 12px">פנייה חדשה — ${escapeHtml(building)}</h2>
          <p style="margin:0 0 6px"><strong>כותרת:</strong> ${escapeHtml(title)}</p>
          <p style="margin:0 0 6px"><strong>קטגוריה:</strong> ${escapeHtml(category === 'other' ? (customCategory || 'אחר') : category)}</p>
          <p style="margin:0 0 6px"><strong>פותח:</strong> ${escapeHtml(actor.label)}</p>
          ${description ? `<p style="margin:14px 0 0;white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:6px">${escapeHtml(description)}</p>` : ''}
        </div>
      `;
      await sendEmail(env, { to: recipient, subject, html, text: `${title}\n\n${description || ''}` });
    } catch { /* swallow — already audited the ticket creation itself */ }
  })();

  const ret = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM tickets WHERE id = ?`).bind(id).first();
  await hydrateTicket(env.DB, ret);
  return json(ret, { status: 201 });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireSession(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }

  const cur = await env.DB.prepare('SELECT id, opened_by_kind AS k, opened_by_id AS oid, status FROM tickets WHERE id = ?').bind(id).first();
  if (!cur) return error('פנייה לא נמצאה', 404);

  // Edit permission: admin always; otherwise creator while still open.
  const actor = actorFromSession(r.sess);
  const isAdmin = r.sess.role === 'admin';
  const isCreator = cur.k === actor.kind && (cur.oid || null) === (actor.id || null);
  if (!isAdmin && !(isCreator && cur.status === 'open')) {
    return error('אין הרשאה לערוך פנייה זו', 403);
  }

  const title = pickStr(body.title, 200).trim();
  const description = pickStr(body.description, 4000);
  const category = pickStr(body.category, 30);
  const customCategory = pickStr(body.customCategory, 100);
  if (!title) return error('כותרת חסרה', 400);
  if (!VALID_CATEGORIES.has(category)) return error('קטגוריה לא תקפה', 400);
  if (category === 'other' && !customCategory) return error('יש לציין קטגוריה כאשר נבחר "אחר"', 400);

  await env.DB.prepare(
    "UPDATE tickets SET title = ?, description = ?, category = ?, custom_category = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(title, description || null, category, customCategory || null, id).run();
  await logAudit(env.DB, request, { event: 'ticket_updated', role: r.sess.role, userLabel: actor.label, success: true, meta: { id } });

  const ret = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM tickets WHERE id = ?`).bind(id).first();
  await hydrateTicket(env.DB, ret);
  return json(ret);
};

export const onRequestPatch = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const op = url.searchParams.get('op');
  if (!id || !op) return error('פרמטרים חסרים', 400);

  const cur = await env.DB.prepare('SELECT id, status FROM tickets WHERE id = ?').bind(id).first();
  if (!cur) return error('פנייה לא נמצאה', 404);
  const actor = actorFromSession(r.sess);

  if (op === 'close') {
    if (cur.status === 'closed') return error('הפנייה כבר סגורה', 400);
    await env.DB.prepare(
      "UPDATE tickets SET status = 'closed', closed_at = datetime('now'), closed_by_label = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(actor.label, id).run();
    await logAudit(env.DB, request, { event: 'ticket_closed', role: 'admin', userLabel: actor.label, success: true, meta: { id } });
  } else if (op === 'reopen') {
    if (cur.status === 'open') return error('הפנייה כבר פתוחה', 400);
    await env.DB.prepare(
      "UPDATE tickets SET status = 'open', closed_at = NULL, closed_by_label = NULL, updated_at = datetime('now') WHERE id = ?"
    ).bind(id).run();
    await logAudit(env.DB, request, { event: 'ticket_reopened', role: 'admin', userLabel: actor.label, success: true, meta: { id } });
  } else if (op === 'link-expense') {
    let body; try { body = await readJSON(request); } catch { body = {}; }
    const expenseId = pickStr(body.expenseId, 80);
    // Validate that the expense exists (or null to clear).
    if (expenseId) {
      const ex = await env.DB.prepare('SELECT id FROM expenses WHERE id = ?').bind(expenseId).first();
      if (!ex) return error('הוצאה לא נמצאה', 404);
    }
    await env.DB.prepare(
      "UPDATE tickets SET expense_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(expenseId || null, id).run();
    await logAudit(env.DB, request, { event: 'ticket_linked_expense', role: 'admin', userLabel: actor.label, success: true, meta: { id, expenseId } });
  } else {
    return error('פעולה לא תקפה', 400);
  }

  const ret = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM tickets WHERE id = ?`).bind(id).first();
  await hydrateTicket(env.DB, ret);
  return json(ret);
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM tickets WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'ticket_deleted', role: 'admin', userLabel: r.sess.userLabel, success: true, meta: { id } });
  return json({ ok: true });
};

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
