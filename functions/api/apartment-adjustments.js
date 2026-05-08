// Apartment manual adjustments (charges/credits) that affect outstanding balance
// independently of monthly fees and payments.
//   GET    /api/apartment-adjustments?apartmentId=...   — list (any logged-in)
//   GET    /api/apartment-adjustments                   — list all
//   POST   /api/apartment-adjustments                   — create (admin)
//   DELETE /api/apartment-adjustments?id=...            — delete (admin)

import { json, error, readJSON, pickStr, pickNum, isISODate, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `id, apartment_id AS apartmentId, kind, amount,
  effective_date AS effectiveDate, notes, created_at AS createdAt`;

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const apartmentId = new URL(request.url).searchParams.get('apartmentId');
  const sql = apartmentId
    ? `SELECT ${SAFE_FIELDS} FROM apartment_adjustments WHERE apartment_id = ? ORDER BY effective_date DESC, created_at DESC`
    : `SELECT ${SAFE_FIELDS} FROM apartment_adjustments ORDER BY effective_date DESC, created_at DESC`;
  const stmt = apartmentId ? env.DB.prepare(sql).bind(apartmentId) : env.DB.prepare(sql);
  const rows = await stmt.all();
  return json({ adjustments: rows.results });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const apartmentId = pickStr(body.apartmentId, 80);
  const kind = pickStr(body.kind, 16);
  const amount = pickNum(body.amount);
  const effectiveDate = isISODate(body.effectiveDate) ? body.effectiveDate : null;
  const notes = pickStr(body.notes, 500);
  if (!apartmentId || !kind || amount == null || !effectiveDate) return error('שדות חובה חסרים', 400);
  if (!['charge', 'credit'].includes(kind)) return error('סוג לא תקף', 400);
  if (amount <= 0) return error('הסכום חייב להיות גדול מאפס', 400);

  const id = uid('adj-');
  await env.DB.prepare('INSERT INTO apartment_adjustments (id, apartment_id, kind, amount, effective_date, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, apartmentId, kind, amount, effectiveDate, notes || null).run();
  await logAudit(env.DB, request, { event: 'apartment_adjustment_created', role: 'admin', userLabel: r.sess.userLabel, meta: { apartmentId, kind, amount }, success: true });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM apartment_adjustments WHERE id = ?`).bind(id).first();
  return json(row, { status: 201 });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM apartment_adjustments WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'apartment_adjustment_deleted', role: 'admin', userLabel: r.sess.userLabel, success: true });
  return json({ ok: true });
};
