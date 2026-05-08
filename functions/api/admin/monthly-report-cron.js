// POST /api/admin/monthly-report-cron
// Internal endpoint called by the standalone cron Worker each month.
// Auth via shared header `x-cron-secret` matching env.CRON_SECRET — no
// session cookie required since the worker is not a user.

import { json, error } from '../../lib/util.js';
import { generateAndSendMonthlyReport } from '../../lib/monthly-report.js';

export const onRequestPost = async ({ request, env }) => {
  const provided = request.headers.get('x-cron-secret');
  if (!env.CRON_SECRET || provided !== env.CRON_SECRET) {
    return error('Forbidden', 403);
  }
  try {
    const res = await generateAndSendMonthlyReport(env, request, {
      triggeredBy: 'cron',
      userLabel: 'cron',
    });
    return json(res);
  } catch (err) {
    return error(err.message || 'שגיאה בשליחת הדוח', 500);
  }
};
