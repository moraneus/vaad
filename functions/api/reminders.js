// Reminders CRUD + acknowledge.
// One reminder per expense at most (enforced by unique index in schema).

import { json, error, readJSON, pickStr, pickInt, isISODate, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `id, title, note, due_date AS dueDate, lead_days AS leadDays,
  expense_id AS expenseId, acknowledged_at AS acknowledgedAt, created_at AS createdAt`;

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const rows = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM reminders ORDER BY due_date ASC, created_at ASC`).all();
  return json({ reminders: rows.results });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const title = pickStr(body.title, 200).trim();
  const dueDate = isISODate(body.dueDate) ? body.dueDate : null;
  if (!title || !dueDate) return error('שדות חובה חסרים', 400);
  const note = pickStr(body.note, 1000);
  const leadDays = Math.max(0, pickInt(body.leadDays) ?? 0);
  const expenseId = pickStr(body.expenseId, 80) || null;

  const id = uid('rem-');
  try {
    await env.DB.prepare('INSERT INTO reminders (id, title, note, due_date, lead_days, expense_id) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, title, note || null, dueDate, leadDays, expenseId).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return error('כבר קיימת תזכורת להוצאה זו', 409);
    throw e;
  }
  await logAudit(env.DB, request, { event: 'reminder_created', role: 'admin', userLabel: r.sess.userLabel, meta: { title, expenseId }, success: true });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM reminders WHERE id = ?`).bind(id).first();
  return json(row, { status: 201 });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const action = url.searchParams.get('action');
  if (!id) return error('id חסר', 400);

  // PUT ?id=...&action=acknowledge | unacknowledge
  if (action === 'acknowledge') {
    await env.DB.prepare("UPDATE reminders SET acknowledged_at = datetime('now') WHERE id = ?").bind(id).run();
    await logAudit(env.DB, request, { event: 'reminder_acknowledged', role: 'admin', userLabel: r.sess.userLabel, success: true });
    const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM reminders WHERE id = ?`).bind(id).first();
    return json(row);
  }
  if (action === 'unacknowledge') {
    await env.DB.prepare('UPDATE reminders SET acknowledged_at = NULL WHERE id = ?').bind(id).run();
    const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM reminders WHERE id = ?`).bind(id).first();
    return json(row);
  }

  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const title = pickStr(body.title, 200).trim();
  const dueDate = isISODate(body.dueDate) ? body.dueDate : null;
  if (!title || !dueDate) return error('שדות חובה חסרים', 400);
  const note = pickStr(body.note, 1000);
  const leadDays = Math.max(0, pickInt(body.leadDays) ?? 0);
  const expenseId = pickStr(body.expenseId, 80) || null;

  try {
    await env.DB.prepare('UPDATE reminders SET title = ?, note = ?, due_date = ?, lead_days = ?, expense_id = ? WHERE id = ?')
      .bind(title, note || null, dueDate, leadDays, expenseId, id).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return error('כבר קיימת תזכורת להוצאה זו', 409);
    throw e;
  }
  await logAudit(env.DB, request, { event: 'reminder_updated', role: 'admin', userLabel: r.sess.userLabel, success: true });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM reminders WHERE id = ?`).bind(id).first();
  return json(row);
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'reminder_deleted', role: 'admin', userLabel: r.sess.userLabel, success: true });
  return json({ ok: true });
};
