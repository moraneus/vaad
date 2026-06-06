// Payments CRUD. All logged-in users see every apartment's payments —
// transparency is a goal of the app: tenants want to know who paid and who didn't.

import { json, error, readJSON, pickStr, pickInt, pickNum, isISODate, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const url = new URL(request.url);
  const aptId = url.searchParams.get('apartmentId');
  const year = url.searchParams.get('year');

  const where = [];
  const params = [];
  if (aptId) {
    where.push('apartment_id = ?');
    params.push(aptId);
  }
  if (year) {
    where.push('year = ?');
    params.push(Number(year));
  }
  const sql = `SELECT id, apartment_id AS apartmentId, year, month, amount, paid_on AS paidOn, method, notes
               FROM payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY year DESC, month DESC, paid_on DESC`;
  const rows = await env.DB.prepare(sql).bind(...params).all();
  return json({ payments: rows.results });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const apartmentId = pickStr(body.apartmentId, 80);
  const year = pickInt(body.year);
  const month = pickInt(body.month);
  const amount = pickNum(body.amount);
  const paidOn = isISODate(body.paidOn) ? body.paidOn : null;
  const method = pickStr(body.method, 30);
  const notes = pickStr(body.notes, 500);
  if (!apartmentId || !year || !month || amount == null) return error('שדות חובה חסרים', 400);
  if (month < 1 || month > 12) return error('חודש לא תקף', 400);
  const id = uid('pay-');
  await env.DB.prepare('INSERT INTO payments (id, apartment_id, year, month, amount, paid_on, method, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, apartmentId, year, month, amount, paidOn, method || null, notes || null).run();
  await logAudit(env.DB, request, { event: 'payment_created', role: 'admin', userLabel: 'מנהל', meta: { apartmentId, year, month, amount }, success: true });
  const row = await env.DB.prepare('SELECT id, apartment_id AS apartmentId, year, month, amount, paid_on AS paidOn, method, notes FROM payments WHERE id = ?').bind(id).first();
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
  await env.DB.prepare('UPDATE payments SET amount = ?, paid_on = ?, method = ?, notes = ? WHERE id = ?')
    .bind(amount, paidOn, method || null, notes || null, id).run();
  await logAudit(env.DB, request, { event: 'payment_updated', role: 'admin', userLabel: 'מנהל', success: true });
  return json({ ok: true });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  // Look up the payment's cell coordinates BEFORE deleting so we can detect
  // a now-orphaned per-cell fee override. The "Record payment" dialog can
  // create a fee override and the payment together (when the admin types a Y
  // that differs from the inherited fee). Deleting only the payment used to
  // leave the override behind, so the cell appeared stuck at the override's
  // value forever. Enforcing the rule here (not just in the client) means
  // any caller — UI, script, future cron — gets the same cleanup.
  const cell = await env.DB.prepare('SELECT apartment_id AS aid, year, month FROM payments WHERE id = ?').bind(id).first();
  await env.DB.prepare('DELETE FROM payments WHERE id = ?').bind(id).run();
  let overrideCleared = false;
  if (cell) {
    const remaining = await env.DB.prepare('SELECT COUNT(*) AS n FROM payments WHERE apartment_id = ? AND year = ? AND month = ?')
      .bind(cell.aid, cell.year, cell.month).first();
    if ((remaining?.n || 0) === 0) {
      const res = await env.DB.prepare('DELETE FROM apartment_monthly_fee_overrides WHERE apartment_id = ? AND year = ? AND month = ?')
        .bind(cell.aid, cell.year, cell.month).run();
      overrideCleared = (res?.meta?.changes || res?.changes || 0) > 0;
    }
  }
  await logAudit(env.DB, request, { event: 'payment_deleted', role: 'admin', userLabel: 'מנהל', success: true, meta: { overrideCleared } });
  return json({ ok: true });
};
