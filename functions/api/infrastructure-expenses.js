// GET    /api/infrastructure-expenses        — list (any logged-in)
// POST   /api/infrastructure-expenses        — create + auto-split into per-apartment demands (admin)
// PUT    /api/infrastructure-expenses?id=... — update name/date/notes (admin)
// DELETE /api/infrastructure-expenses?id=... — cascade delete (admin)
//
// On POST, after inserting the expense row, this endpoint creates one
// `infrastructure_demands` row per existing apartment with amount = total/count.
// Admin can later override each demand's amount via /api/infrastructure-demands.

import { json, error, readJSON, pickStr, pickNum, isISODate, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `id, name, total_amount AS totalAmount, expense_date AS expenseDate,
  notes, created_at AS createdAt, updated_at AS updatedAt`;

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const rows = await env.DB.prepare(
    `SELECT ${SAFE_FIELDS} FROM infrastructure_expenses ORDER BY expense_date DESC, created_at DESC`
  ).all();
  return json({ expenses: rows.results || [] });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const name = pickStr(body.name, 200).trim();
  const totalAmount = pickNum(body.totalAmount);
  const expenseDate = isISODate(body.expenseDate) ? body.expenseDate : null;
  const notes = pickStr(body.notes, 1000);
  if (!name) return error('שם ההוצאה חסר', 400);
  if (totalAmount == null || totalAmount <= 0) return error('הסכום חייב להיות גדול מאפס', 400);
  if (!expenseDate) return error('תאריך ההוצאה חסר', 400);

  // Snapshot current apartments and split equally. Apartments added after this
  // moment are NOT auto-charged for this expense — only the apartments that
  // existed at creation time get a demand. Admin can manually add demands
  // later if needed via the demands endpoint.
  const apts = await env.DB.prepare('SELECT id FROM apartments').all().then(x => x.results || []);
  if (apts.length === 0) return error('אין דירות במערכת — אי אפשר לחלק את ההוצאה', 400);

  const id = uid('infe-');
  await env.DB.prepare(
    'INSERT INTO infrastructure_expenses (id, name, total_amount, expense_date, notes) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, name, totalAmount, expenseDate, notes || null).run();

  // Round each share to 2 decimals; the last apartment absorbs any rounding
  // residual so the sum of demands == totalAmount exactly.
  const equalShare = Math.round((totalAmount / apts.length) * 100) / 100;
  let allocated = 0;
  for (let i = 0; i < apts.length; i++) {
    const apt = apts[i];
    const isLast = (i === apts.length - 1);
    const share = isLast
      ? Math.round((totalAmount - allocated) * 100) / 100
      : equalShare;
    allocated += share;
    await env.DB.prepare(
      'INSERT INTO infrastructure_demands (id, expense_id, apartment_id, amount) VALUES (?, ?, ?, ?)'
    ).bind(uid('infd-'), id, apt.id, share).run();
  }

  await logAudit(env.DB, request, { event: 'infrastructure_expense_created', role: 'admin', userLabel: r.sess.userLabel || 'מנהל', success: true, meta: { id, name, totalAmount, demandCount: apts.length } });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM infrastructure_expenses WHERE id = ?`).bind(id).first();
  return json(row, { status: 201 });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const name = pickStr(body.name, 200).trim();
  const expenseDate = isISODate(body.expenseDate) ? body.expenseDate : null;
  const notes = pickStr(body.notes, 1000);
  if (!name) return error('שם ההוצאה חסר', 400);
  if (!expenseDate) return error('תאריך ההוצאה חסר', 400);
  // Note: we don't update total_amount here. Re-splitting an existing expense
  // would clobber any per-apartment overrides the admin already entered. To
  // change the total, delete and recreate.
  await env.DB.prepare(
    "UPDATE infrastructure_expenses SET name = ?, expense_date = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(name, expenseDate, notes || null, id).run();
  await logAudit(env.DB, request, { event: 'infrastructure_expense_updated', role: 'admin', userLabel: r.sess.userLabel || 'מנהל', success: true, meta: { id } });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM infrastructure_expenses WHERE id = ?`).bind(id).first();
  return json(row);
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM infrastructure_expenses WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'infrastructure_expense_deleted', role: 'admin', userLabel: r.sess.userLabel || 'מנהל', success: true, meta: { id } });
  return json({ ok: true });
};
