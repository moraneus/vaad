// POST   /api/expense-rates { expenseId, effectiveFrom, amount }
// DELETE /api/expense-rates?id=...

import { json, error, readJSON, pickStr, pickNum, isISODate, uid } from '../lib/util.js';
import { requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const expenseId = pickStr(body.expenseId, 80);
  const effectiveFrom = body.effectiveFrom;
  const amount = pickNum(body.amount);
  if (!expenseId || !isISODate(effectiveFrom) || amount == null) return error('שדות חובה חסרים', 400);
  const id = uid('rate-');
  await env.DB.prepare('INSERT INTO expense_rates (id, expense_id, effective_from, amount) VALUES (?, ?, ?, ?)')
    .bind(id, expenseId, effectiveFrom, amount).run();
  // Update expense.amount to reflect latest rate
  const latest = await env.DB.prepare('SELECT amount FROM expense_rates WHERE expense_id = ? ORDER BY effective_from DESC LIMIT 1').bind(expenseId).first();
  if (latest) await env.DB.prepare('UPDATE expenses SET amount = ? WHERE id = ?').bind(latest.amount, expenseId).run();
  await logAudit(env.DB, request, { event: 'expense_rate_added', role: 'admin', userLabel: 'מנהל', meta: { expenseId, amount }, success: true });
  return json({ ok: true, id }, { status: 201 });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  const row = await env.DB.prepare('SELECT expense_id AS expenseId FROM expense_rates WHERE id = ?').bind(id).first();
  if (!row) return error('לא נמצא', 404);
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM expense_rates WHERE expense_id = ?').bind(row.expenseId).first();
  if (cnt.n <= 1) return error('חייב להישאר תעריף אחד לפחות', 400);
  await env.DB.prepare('DELETE FROM expense_rates WHERE id = ?').bind(id).run();
  const latest = await env.DB.prepare('SELECT amount FROM expense_rates WHERE expense_id = ? ORDER BY effective_from DESC LIMIT 1').bind(row.expenseId).first();
  if (latest) await env.DB.prepare('UPDATE expenses SET amount = ? WHERE id = ?').bind(latest.amount, row.expenseId).run();
  return json({ ok: true });
};
