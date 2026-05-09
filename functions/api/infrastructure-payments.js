// GET    /api/infrastructure-payments?demandId=...  — list (any logged-in)
// POST   /api/infrastructure-payments               — admin records payment
// DELETE /api/infrastructure-payments?id=...        — admin removes a payment

import { json, error, readJSON, pickStr, pickNum, isISODate, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `id, demand_id AS demandId, amount, paid_on AS paidOn, method, notes,
  created_at AS createdAt`;

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const demandId = new URL(request.url).searchParams.get('demandId');
  const sql = demandId
    ? `SELECT ${SAFE_FIELDS} FROM infrastructure_payments WHERE demand_id = ? ORDER BY paid_on DESC, created_at DESC`
    : `SELECT ${SAFE_FIELDS} FROM infrastructure_payments ORDER BY paid_on DESC, created_at DESC`;
  const stmt = demandId ? env.DB.prepare(sql).bind(demandId) : env.DB.prepare(sql);
  const rows = await stmt.all();
  return json({ payments: rows.results || [] });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const demandId = pickStr(body.demandId, 80);
  const amount = pickNum(body.amount);
  const paidOn = isISODate(body.paidOn) ? body.paidOn : null;
  const method = pickStr(body.method, 16);
  const notes = pickStr(body.notes, 500);
  if (!demandId) return error('demandId חסר', 400);
  if (amount == null || amount <= 0) return error('הסכום חייב להיות גדול מאפס', 400);
  if (!paidOn) return error('תאריך תשלום חסר', 400);

  const demand = await env.DB.prepare('SELECT id FROM infrastructure_demands WHERE id = ?').bind(demandId).first();
  if (!demand) return error('דרישת התשלום לא נמצאה', 404);

  const id = uid('infp-');
  await env.DB.prepare(
    'INSERT INTO infrastructure_payments (id, demand_id, amount, paid_on, method, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, demandId, amount, paidOn, method || null, notes || null).run();
  await logAudit(env.DB, request, { event: 'infrastructure_payment_recorded', role: 'admin', userLabel: r.sess.userLabel || 'מנהל', success: true, meta: { id, demandId, amount } });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM infrastructure_payments WHERE id = ?`).bind(id).first();
  return json(row, { status: 201 });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM infrastructure_payments WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'infrastructure_payment_deleted', role: 'admin', userLabel: r.sess.userLabel || 'מנהל', success: true, meta: { id } });
  return json({ ok: true });
};
