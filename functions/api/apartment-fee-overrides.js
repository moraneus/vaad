// Per-apartment per-month fee overrides. When set, replaces the global monthly
// fee for that single (apartment, year, month) cell in every "expected"
// calculation across the system.
//
//   GET    /api/apartment-fee-overrides?apartmentId=...   — list overrides for one apartment
//   GET    /api/apartment-fee-overrides                   — list all overrides (admin only)
//   PUT    /api/apartment-fee-overrides                   — upsert (admin)
//   DELETE /api/apartment-fee-overrides?apartmentId=...&year=...&month=...  — clear (admin)

import { json, error, readJSON, pickStr, pickNum, pickInt } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `apartment_id AS apartmentId, year, month, amount, notes, updated_at AS updatedAt`;

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const apartmentId = new URL(request.url).searchParams.get('apartmentId');
  const sql = apartmentId
    ? `SELECT ${SAFE_FIELDS} FROM apartment_monthly_fee_overrides WHERE apartment_id = ? ORDER BY year DESC, month DESC`
    : `SELECT ${SAFE_FIELDS} FROM apartment_monthly_fee_overrides ORDER BY apartment_id, year DESC, month DESC`;
  const stmt = apartmentId ? env.DB.prepare(sql).bind(apartmentId) : env.DB.prepare(sql);
  const rows = await stmt.all();
  return json({ overrides: rows.results || [] });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const apartmentId = pickStr(body.apartmentId, 80);
  const year = pickInt(body.year);
  const month = pickInt(body.month);
  const amount = pickNum(body.amount);
  const notes = pickStr(body.notes, 500);
  if (!apartmentId || year == null || month == null || amount == null) return error('שדות חובה חסרים', 400);
  if (year < 2000 || year > 2100) return error('שנה לא תקפה', 400);
  if (month < 1 || month > 12) return error('חודש לא תקף', 400);
  if (amount < 0) return error('הסכום לא יכול להיות שלילי', 400);

  const apt = await env.DB.prepare('SELECT id FROM apartments WHERE id = ?').bind(apartmentId).first();
  if (!apt) return error('דירה לא נמצאה', 404);

  await env.DB.prepare(
    `INSERT INTO apartment_monthly_fee_overrides (apartment_id, year, month, amount, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(apartment_id, year, month) DO UPDATE SET
       amount = excluded.amount,
       notes = excluded.notes,
       updated_at = excluded.updated_at`
  ).bind(apartmentId, year, month, amount, notes || null).run();

  await logAudit(env.DB, request, { event: 'fee_override_set', role: 'admin', userLabel: r.sess.userLabel, success: true, meta: { apartmentId, year, month, amount } });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM apartment_monthly_fee_overrides WHERE apartment_id = ? AND year = ? AND month = ?`).bind(apartmentId, year, month).first();
  return json(row);
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const url = new URL(request.url);
  const apartmentId = url.searchParams.get('apartmentId');
  const year = Number(url.searchParams.get('year'));
  const month = Number(url.searchParams.get('month'));
  if (!apartmentId || !year || !month) return error('שדות חובה חסרים', 400);
  await env.DB.prepare('DELETE FROM apartment_monthly_fee_overrides WHERE apartment_id = ? AND year = ? AND month = ?')
    .bind(apartmentId, year, month).run();
  await logAudit(env.DB, request, { event: 'fee_override_cleared', role: 'admin', userLabel: r.sess.userLabel, success: true, meta: { apartmentId, year, month } });
  return json({ ok: true });
};
