// GET /api/infrastructure-demands?expenseId=&apartmentId=  — list (any logged-in)
// PUT /api/infrastructure-demands?id=...                   — admin edits per-apartment amount

import { json, error, readJSON, pickNum, pickStr } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `id, expense_id AS expenseId, apartment_id AS apartmentId, amount, notes,
  created_at AS createdAt, updated_at AS updatedAt`;

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const url = new URL(request.url);
  const expenseId = url.searchParams.get('expenseId');
  const apartmentId = url.searchParams.get('apartmentId');
  let sql = `SELECT ${SAFE_FIELDS} FROM infrastructure_demands`;
  const where = [];
  const args = [];
  if (expenseId) { where.push('expense_id = ?'); args.push(expenseId); }
  if (apartmentId) { where.push('apartment_id = ?'); args.push(apartmentId); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY apartment_id, created_at';
  const rows = args.length
    ? await env.DB.prepare(sql).bind(...args).all()
    : await env.DB.prepare(sql).all();
  return json({ demands: rows.results || [] });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const amount = pickNum(body.amount);
  const notes = pickStr(body.notes, 500);
  if (amount == null || amount < 0) return error('הסכום לא תקף', 400);
  await env.DB.prepare(
    "UPDATE infrastructure_demands SET amount = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(amount, notes || null, id).run();
  await logAudit(env.DB, request, { event: 'infrastructure_demand_updated', role: 'admin', userLabel: r.sess.userLabel || 'מנהל', success: true, meta: { id, amount } });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM infrastructure_demands WHERE id = ?`).bind(id).first();
  return json(row);
};
