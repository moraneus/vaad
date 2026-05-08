// Payments recorded against a specific charge (apartment_adjustment).
// Mirrors the regular `payments` table flow but anchored to a charge id.
//   GET    /api/adjustment-payments[?adjustmentId=...]  — list (any logged-in)
//   POST   /api/adjustment-payments                     — create (admin)
//   DELETE /api/adjustment-payments?id=...              — delete (admin)

import { json, error, readJSON, pickStr, pickNum, isISODate, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `id, adjustment_id AS adjustmentId, amount,
  paid_on AS paidOn, method, notes, created_at AS createdAt`;

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const adjustmentId = new URL(request.url).searchParams.get('adjustmentId');
  const sql = adjustmentId
    ? `SELECT ${SAFE_FIELDS} FROM adjustment_payments WHERE adjustment_id = ? ORDER BY paid_on DESC, created_at DESC`
    : `SELECT ${SAFE_FIELDS} FROM adjustment_payments ORDER BY paid_on DESC, created_at DESC`;
  const stmt = adjustmentId ? env.DB.prepare(sql).bind(adjustmentId) : env.DB.prepare(sql);
  const rows = await stmt.all();
  return json({ payments: rows.results });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const adjustmentId = pickStr(body.adjustmentId, 80);
  const amount = pickNum(body.amount);
  const paidOn = isISODate(body.paidOn) ? body.paidOn : null;
  const method = pickStr(body.method, 30);
  const notes = pickStr(body.notes, 500);
  if (!adjustmentId || amount == null || !paidOn) return error('שדות חובה חסרים', 400);
  if (amount <= 0) return error('הסכום חייב להיות גדול מאפס', 400);

  // Confirm parent charge exists and is of kind 'charge'.
  const adj = await env.DB.prepare("SELECT id, kind FROM apartment_adjustments WHERE id = ?").bind(adjustmentId).first();
  if (!adj) return error('החיוב לא נמצא', 404);
  if (adj.kind !== 'charge') return error('ניתן לשלם רק עבור חיוב', 400);

  const id = uid('apay-');
  await env.DB.prepare('INSERT INTO adjustment_payments (id, adjustment_id, amount, paid_on, method, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, adjustmentId, amount, paidOn, method || null, notes || null).run();
  await logAudit(env.DB, request, { event: 'adjustment_payment_created', role: 'admin', userLabel: r.sess.userLabel, meta: { adjustmentId, amount }, success: true });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM adjustment_payments WHERE id = ?`).bind(id).first();
  return json(row, { status: 201 });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM adjustment_payments WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'adjustment_payment_deleted', role: 'admin', userLabel: r.sess.userLabel, success: true });
  return json({ ok: true });
};
