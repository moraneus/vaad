// POST /api/admin/bulk-mark-paid — master admin only.
// Body: { year, month, paidOn, method, notes, items: [{ apartmentId, amount }, ...] }
//
// Records one payment row per item, all sharing the same year/month/method/
// paidOn/notes. The frontend pre-computes per-apartment amounts (typically
// "remaining = expected − already paid this month") and skips apartments
// that are already fully paid, so the server just inserts what it's told.
//
// Why a dedicated endpoint instead of N calls to /api/payments? Round-trip
// economy on slow connections + a single audit-log entry for the bulk action
// (with the count + month) instead of N separate `payment_created` rows.

import { json, error, readJSON, pickStr, isISODate, uid } from '../../lib/util.js';
import { loadSession } from '../../lib/session.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  const sess = await loadSession(db, request, env);
  // Master-admin only — apartment-admins shouldn't be able to fabricate
  // building-wide payment rows.
  if (!sess || sess.role !== 'admin' || sess.apartmentId) return error('אין הרשאה', 403);

  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const year = Number(body.year);
  const month = Number(body.month);
  const paidOn = isISODate(body.paidOn) ? body.paidOn : null;
  const method = pickStr(body.method, 30);
  const notes = pickStr(body.notes, 500);
  const items = Array.isArray(body.items) ? body.items : [];

  if (!Number.isInteger(year) || year < 2000 || year > 2100) return error('שנה לא תקפה', 400);
  if (!Number.isInteger(month) || month < 1 || month > 12) return error('חודש לא תקף', 400);
  if (!items.length) return error('לא נבחרו דירות', 400);
  if (items.length > 200) return error('יותר מדי דירות בבקשה אחת', 400);

  // Verify all apartmentIds exist before inserting anything — atomicity light.
  const ids = items
    .map(x => String(x?.apartmentId || '').slice(0, 80))
    .filter(Boolean);
  const placeholders = ids.length ? ids.map(() => '?').join(',') : "''";
  const found = await db.prepare(
    `SELECT id FROM apartments WHERE id IN (${placeholders})`
  ).bind(...ids).all().then(r => new Set((r.results || []).map(x => x.id)));

  let created = 0;
  let skipped = 0;
  for (const item of items) {
    const apartmentId = String(item?.apartmentId || '').slice(0, 80);
    const amount = Number(item?.amount);
    if (!apartmentId || !found.has(apartmentId) || !Number.isFinite(amount) || amount <= 0) {
      skipped++;
      continue;
    }
    await db.prepare(
      'INSERT INTO payments (id, apartment_id, year, month, amount, paid_on, method, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(uid('pay-'), apartmentId, year, month, amount, paidOn, method || null, notes || null).run();
    created++;
  }

  await logAudit(db, request, {
    event: 'bulk_mark_paid', role: 'admin', userLabel: sess.userLabel || 'מנהל', success: true,
    meta: { year, month, created, skipped, method: method || null },
  });
  return json({ ok: true, created, skipped });
};
