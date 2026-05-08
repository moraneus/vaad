// POST /api/admin/monthly-report  { year?, month? }
// Admin-triggered monthly report. Defaults to the previous calendar month.

import { json, error, readJSON, pickInt } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { generateAndSendMonthlyReport } from '../../lib/monthly-report.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body = {};
  try { body = await readJSON(request); } catch {}
  const year = pickInt(body.year);
  const month = pickInt(body.month);
  try {
    const res = await generateAndSendMonthlyReport(env, request, {
      year, month,
      triggeredBy: 'admin',
      userLabel: r.sess.userLabel || 'מנהל',
    });
    return json(res);
  } catch (err) {
    return error(err.message || 'שגיאה בשליחת הדוח', 400);
  }
};
