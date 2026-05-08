// POST /api/settings/fee-history { effectiveFrom, amount, id? }
// DELETE /api/settings/fee-history?id=...

import { json, error, readJSON, pickNum, isISODate, uid } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const effectiveFrom = body.effectiveFrom;
  const amount = pickNum(body.amount);
  if (!isISODate(effectiveFrom)) return error('תאריך לא תקף', 400);
  if (amount == null || amount < 0) return error('סכום לא תקף', 400);
  const db = env.DB;
  if (body.id) {
    await db.prepare('UPDATE monthly_fee_history SET effective_from = ?, amount = ? WHERE id = ?').bind(effectiveFrom, amount, body.id).run();
  } else {
    await db.prepare('INSERT INTO monthly_fee_history (id, effective_from, amount) VALUES (?, ?, ?)').bind(uid('fee-'), effectiveFrom, amount).run();
  }
  await logAudit(db, request, { event: 'fee_history_changed', role: 'admin', userLabel: 'מנהל', success: true });
  return json({ ok: true });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  const db = env.DB;
  const cnt = await db.prepare('SELECT COUNT(*) AS n FROM monthly_fee_history').first();
  if (cnt.n <= 1) return error('חייבת להישאר רשומה אחת לפחות', 400);
  await db.prepare('DELETE FROM monthly_fee_history WHERE id = ?').bind(id).run();
  return json({ ok: true });
};
