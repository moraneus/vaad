// Expense payments — actual outflows recorded against an expense definition.

import { json, error, readJSON, pickStr, pickInt, pickNum, isISODate, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const url = new URL(request.url);
  const expenseId = url.searchParams.get('expenseId');
  const year = url.searchParams.get('year');

  const where = [];
  const params = [];
  if (expenseId) { where.push('expense_id = ?'); params.push(expenseId); }
  if (year) { where.push('year = ?'); params.push(Number(year)); }

  const sql = `SELECT id, expense_id AS expenseId, year, month, amount, paid_on AS paidOn, method, notes
               FROM expense_payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY year DESC, month DESC, paid_on DESC`;
  const rows = await env.DB.prepare(sql).bind(...params).all();
  return json({ payments: rows.results });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const expenseId = pickStr(body.expenseId, 80);
  const year = pickInt(body.year);
  const month = pickInt(body.month);
  const amount = pickNum(body.amount);
  const paidOn = isISODate(body.paidOn) ? body.paidOn : null;
  const method = pickStr(body.method, 30);
  const notes = pickStr(body.notes, 500);
  if (!expenseId || !year || !month || amount == null) return error('שדות חובה חסרים', 400);
  if (month < 1 || month > 12) return error('חודש לא תקף', 400);

  const id = uid('epay-');
  await env.DB.prepare('INSERT INTO expense_payments (id, expense_id, year, month, amount, paid_on, method, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, expenseId, year, month, amount, paidOn, method || null, notes || null).run();
  await logAudit(env.DB, request, { event: 'expense_payment_created', role: 'admin', userLabel: r.sess.userLabel, meta: { expenseId, year, month, amount }, success: true });
  const row = await env.DB.prepare('SELECT id, expense_id AS expenseId, year, month, amount, paid_on AS paidOn, method, notes FROM expense_payments WHERE id = ?').bind(id).first();
  return json(row, { status: 201 });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const amount = pickNum(body.amount);
  const paidOn = isISODate(body.paidOn) ? body.paidOn : null;
  const method = pickStr(body.method, 30);
  const notes = pickStr(body.notes, 500);
  if (amount == null) return error('סכום חסר', 400);
  await env.DB.prepare('UPDATE expense_payments SET amount = ?, paid_on = ?, method = ?, notes = ? WHERE id = ?')
    .bind(amount, paidOn, method || null, notes || null, id).run();
  await logAudit(env.DB, request, { event: 'expense_payment_updated', role: 'admin', userLabel: r.sess.userLabel, success: true });
  return json({ ok: true });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM expense_payments WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'expense_payment_deleted', role: 'admin', userLabel: r.sess.userLabel, success: true });
  return json({ ok: true });
};
