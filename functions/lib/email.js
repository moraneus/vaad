// Outbound email via Resend (https://resend.com).
// Free tier: 3000 emails/month, 100/day — way more than a vaad needs.
//
// Requires two env vars set as Cloudflare Pages secrets:
//   - RESEND_API_KEY  (the api key from the Resend dashboard)
//   - EMAIL_FROM      (a verified sender address; the domain must be verified
//                      with Resend, or you can use the default "onboarding@resend.dev"
//                      sender for testing).

export function emailEnabled(env) {
  return !!(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export async function sendEmail(env, { to, subject, html, text, replyTo }) {
  if (!emailEnabled(env)) {
    throw new Error('שירות האימייל לא הוגדר (חסרים RESEND_API_KEY / EMAIL_FROM)');
  }
  const fromName = env.EMAIL_FROM_NAME || 'Vaad Bayit';
  const fromAddr = env.EMAIL_FROM;
  const fromHeader = `${fromName} <${fromAddr}>`;
  const recipients = Array.isArray(to) ? to : [to];

  const body = {
    from: fromHeader,
    to: recipients,
    subject,
    html: html || undefined,
    text: text || undefined,
    reply_to: replyTo || undefined,
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API: ${res.status} — ${err.slice(0, 200)}`);
  }
  return res.json();
}

// Convenience: send the same email to many recipients in batch. Resend's
// batch endpoint accepts up to 100 messages at a time. Use this for the
// monthly report and the admin broadcast.
export async function sendBatchEmail(env, messages) {
  if (!emailEnabled(env)) {
    throw new Error('שירות האימייל לא הוגדר (חסרים RESEND_API_KEY / EMAIL_FROM)');
  }
  if (!messages.length) return { ok: true, sent: 0 };
  const fromName = env.EMAIL_FROM_NAME || 'Vaad Bayit';
  const fromHeader = `${fromName} <${env.EMAIL_FROM}>`;
  const payload = messages.map(m => ({
    from: fromHeader,
    to: Array.isArray(m.to) ? m.to : [m.to],
    subject: m.subject,
    html: m.html || undefined,
    text: m.text || undefined,
  }));

  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend batch: ${res.status} — ${err.slice(0, 200)}`);
  }
  const result = await res.json();
  return { ok: true, sent: payload.length, result };
}

// Build a friendly footer for emails — required for compliance ("not spam"
// notice + how to opt out).
export function emailFooter(buildingName) {
  return `
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px" />
    <p style="font-size:12px;color:#64748b;line-height:1.6;margin:0">
      הודעה זו נשלחה מטעם <strong>${escapeHtml(buildingName || 'ועד הבית')}</strong> אליך כי הגדרת את כתובת המייל הזו במערכת ניהול הוועד.
      אינה דואר זבל. ניתן להסיר את עצמך מרשימת התפוצה דרך מסך ההגדרות באתר הוועד או על ידי פנייה למנהל.
    </p>
  `;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
