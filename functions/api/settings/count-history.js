// POST /api/settings/count-history { effectiveFrom, count } — add or update entry
// DELETE /api/settings/count-history?id=...

import { json, error, readJSON, pickInt, isISODate, uid } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const effectiveFrom = body.effectiveFrom;
  const count = pickInt(body.count);
  const id = body.id;
  if (!isISODate(effectiveFrom)) return error('תאריך לא תקף', 400);
  if (count == null || count < 1) return error('מספר דירות לא תקף', 400);
  const db = env.DB;
  if (id) {
    await db.prepare('UPDATE apartment_count_history SET effective_from = ?, count = ? WHERE id = ?').bind(effectiveFrom, count, id).run();
  } else {
    await db.prepare('INSERT INTO apartment_count_history (id, effective_from, count) VALUES (?, ?, ?)').bind(uid('cnt-'), effectiveFrom, count).run();
  }
  await logAudit(db, request, { event: 'count_history_changed', role: 'admin', userLabel: 'מנהל', success: true });
  return json({ ok: true });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  const db = env.DB;
  const cnt = await db.prepare('SELECT COUNT(*) AS n FROM apartment_count_history').first();
  if (cnt.n <= 1) return error('חייבת להישאר רשומה אחת לפחות', 400);
  await db.prepare('DELETE FROM apartment_count_history WHERE id = ?').bind(id).run();
  return json({ ok: true });
};
