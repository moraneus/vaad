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

  // LEFT JOIN to the parallel frozen table — payments with a row there are
  // returned with frozen=1 and are subsequently filtered out of the
  // "actual expenses" totals on the client. History stays intact either way.
  const sql = `SELECT p.id, p.expense_id AS expenseId, p.year, p.month, p.amount,
                      p.paid_on AS paidOn, p.method, p.notes,
                      CASE WHEN epf.payment_id IS NULL THEN 0 ELSE 1 END AS frozen
                 FROM expense_payments p
                 LEFT JOIN expense_payment_frozen epf ON epf.payment_id = p.id
               ${where.length ? 'WHERE ' + where.map(w => w.replace(/\b(expense_id|year)\b/g, 'p.$1')).join(' AND ') : ''}
               ORDER BY p.year DESC, p.month DESC, p.paid_on DESC`;
  const rows = await env.DB.prepare(sql).bind(...params).all();
  // Normalize frozen to boolean for the client.
  const payments = (rows.results || []).map(p => ({ ...p, frozen: !!p.frozen }));
  return json({ payments });
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

  // Frozen-only update path: when the body is just { frozen: true|false },
  // touch only the parallel table so the freeze toggle doesn't require the
  // caller to re-send every editable field.
  if (Object.keys(body).length && Object.keys(body).every(k => k === 'frozen')) {
    if (body.frozen) {
      await env.DB.prepare(
        "INSERT INTO expense_payment_frozen (payment_id, frozen_at) VALUES (?, datetime('now')) " +
        "ON CONFLICT(payment_id) DO UPDATE SET frozen_at = datetime('now')"
      ).bind(id).run();
    } else {
      await env.DB.prepare('DELETE FROM expense_payment_frozen WHERE payment_id = ?').bind(id).run();
    }
    await logAudit(env.DB, request, { event: body.frozen ? 'expense_payment_frozen' : 'expense_payment_unfrozen', role: 'admin', userLabel: r.sess.userLabel, meta: { id }, success: true });
    return json({ ok: true });
  }

  const amount = pickNum(body.amount);
  const paidOn = isISODate(body.paidOn) ? body.paidOn : null;
  const method = pickStr(body.method, 30);
  const notes = pickStr(body.notes, 500);
  if (amount == null) return error('סכום חסר', 400);
  await env.DB.prepare('UPDATE expense_payments SET amount = ?, paid_on = ?, method = ?, notes = ? WHERE id = ?')
    .bind(amount, paidOn, method || null, notes || null, id).run();
  // The frozen flag is also accepted on full edits — keep the toggle in
  // sync if the admin opens the payment dialog and changes both.
  if (Object.prototype.hasOwnProperty.call(body, 'frozen')) {
    if (body.frozen) {
      await env.DB.prepare(
        "INSERT INTO expense_payment_frozen (payment_id, frozen_at) VALUES (?, datetime('now')) " +
        "ON CONFLICT(payment_id) DO UPDATE SET frozen_at = datetime('now')"
      ).bind(id).run();
    } else {
      await env.DB.prepare('DELETE FROM expense_payment_frozen WHERE payment_id = ?').bind(id).run();
    }
  }
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
