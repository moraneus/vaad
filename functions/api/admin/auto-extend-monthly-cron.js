// POST /api/admin/auto-extend-monthly-cron
// Internal endpoint called by the standalone cron Worker on the 1st of each
// month. Auth via shared header `x-cron-secret` matching env.CRON_SECRET.
//
// For every expense that has an opt-in row in `expense_auto_extend` AND is
// type='monthly' AND has a non-null end_date, push end_date forward to the
// last day of the CURRENT calendar month — but only if the current end_date
// is BEFORE that target. Already-extended rows are no-ops, so re-running is
// safe (idempotent within a calendar month).
//
// Logs an audit row summarising count + list of extended expense ids.

import { json, error } from '../../lib/util.js';

// Returns YYYY-MM-DD for the last day of the current calendar month, in UTC.
// Workers don't carry a TZ — UTC is fine for date math here since the field
// is a date, not a timestamp.
function lastDayOfThisMonthISO() {
  const d = new Date();
  // Day 0 of next month = last day of current month.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  const y = last.getUTCFullYear();
  const m = String(last.getUTCMonth() + 1).padStart(2, '0');
  const day = String(last.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const onRequestPost = async ({ request, env }) => {
  const provided = request.headers.get('x-cron-secret');
  if (!env.CRON_SECRET || provided !== env.CRON_SECRET) {
    return error('Forbidden', 403);
  }
  const db = env.DB;
  const target = lastDayOfThisMonthISO();

  // Find all monthly expenses that are eligible: opted-in, type=monthly,
  // bounded end_date, status not closed/paused, and end_date is BEFORE the
  // target (otherwise no work to do).
  const rows = await db.prepare(
    `SELECT e.id, e.end_date AS endDate
       FROM expenses e
       JOIN expense_auto_extend a ON a.expense_id = e.id
      WHERE e.type = 'monthly'
        AND e.status NOT IN ('closed', 'paused')
        AND e.end_date IS NOT NULL
        AND e.end_date < ?`
  ).bind(target).all();

  const ids = (rows.results || []).map(r => r.id);
  if (!ids.length) {
    return json({ ok: true, extended: 0, target });
  }

  // Batch-update: end_date := target for each row. Also stamp last_extended_at
  // so admins can verify when the cron last touched the row.
  for (const id of ids) {
    await db.prepare(
      "UPDATE expenses SET end_date = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(target, id).run();
    await db.prepare(
      "UPDATE expense_auto_extend SET last_extended_at = datetime('now') WHERE expense_id = ?"
    ).bind(id).run();
  }

  // Audit row — best-effort; don't let logging failures mask the result.
  try {
    await db.prepare(
      "INSERT INTO audit_log (id, ts, event, role, user_label, success, ip, user_agent, meta) VALUES (?, datetime('now'), 'expense_auto_extend', 'admin', 'cron', 1, ?, ?, ?)"
    ).bind(
      crypto.randomUUID(),
      request.headers.get('CF-Connecting-IP') || 'cron',
      'cron-worker',
      JSON.stringify({ target, count: ids.length, ids }),
    ).run();
  } catch { /* ignore */ }

  return json({ ok: true, extended: ids.length, target, ids });
};
