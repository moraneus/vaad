// POST /api/admin/email-broadcast  { subject, message }
// Send a custom message to every apartment that opted in (has a row in
// apartment_email). Admin only.

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { sendBatchEmail, emailEnabled, emailFooter } from '../../lib/email.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  if (!emailEnabled(env)) return error('שירות האימייל לא הוגדר. ראה הגדרות → אינטגרציות.', 400);

  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const subject = pickStr(body.subject, 200).trim();
  const message = pickStr(body.message, 5000).trim();
  if (!subject || !message) return error('נושא וגוף הודעה — חובה', 400);

  // Recipients = every apartment with an opted-in email.
  const rows = await env.DB.prepare(
    `SELECT ae.email, a.number AS aptNumber
       FROM apartment_email ae
       JOIN apartments a ON a.id = ae.apartment_id`
  ).all();
  if (!rows.results || rows.results.length === 0) {
    return error('אין דיירים שרשומים לקבלת מיילים', 400);
  }

  const buildingRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'building_name'").first();
  const buildingName = buildingRow?.value || 'ועד הבית';
  const subjectPrefix = await env.DB.prepare("SELECT value FROM settings WHERE key = 'email_subject_prefix'").first()
    .then(r => r?.value || '').catch(() => '');
  const fullSubject = subjectPrefix ? `${subjectPrefix} ${subject}` : `[${buildingName}] ${subject}`;

  // Convert message body (plain text from textarea) to safe HTML preserving newlines.
  const htmlBody = escapeHtml(message).replace(/\n/g, '<br>');

  const messages = rows.results.map(row => ({
    to: row.email,
    subject: fullSubject,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#1f2937;direction:rtl;text-align:right">
        <h2 style="color:#1f4068;margin-top:0">${escapeHtml(buildingName)}</h2>
        <div style="font-size:14px;line-height:1.7">${htmlBody}</div>
        ${emailFooter(buildingName)}
      </div>
    `,
  }));

  // Send in chunks of 100 (Resend batch limit).
  let sent = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    await sendBatchEmail(env, chunk);
    sent += chunk.length;
  }

  await logAudit(env.DB, request, {
    event: 'email_broadcast_sent',
    role: 'admin',
    userLabel: r.sess.userLabel,
    meta: { subject, count: sent },
    success: true,
  });
  return json({ ok: true, sent });
};

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
