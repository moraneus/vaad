// POST /api/admin/email-test  { to }
// Send a test email to verify Resend is configured correctly. Admin only.

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { sendEmail, emailEnabled, emailFooter } from '../../lib/email.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  if (!emailEnabled(env)) return error('שירות האימייל לא הוגדר. ראה הגדרות → אינטגרציות.', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const to = pickStr(body.to, 200).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return error('כתובת מייל לא תקפה', 400);

  const buildingRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'building_name'").first();
  const buildingName = buildingRow?.value || 'ועד הבית';
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#1f2937;direction:rtl;text-align:right">
      <h2 style="color:#1f4068">בדיקת מייל מ${escapeHtml(buildingName)}</h2>
      <p>הודעת בדיקה — ההגדרה תקינה. מערכת המיילים פעילה.</p>
      ${emailFooter(buildingName)}
    </div>
  `;
  await sendEmail(env, { to, subject: `[${buildingName}] בדיקת מייל`, html });
  await logAudit(env.DB, request, { event: 'email_test_sent', role: 'admin', userLabel: r.sess.userLabel, meta: { to }, success: true });
  return json({ ok: true });
};

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
