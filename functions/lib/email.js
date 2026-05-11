// Outbound email via Resend (https://resend.com).
// Free tier: 3000 emails/month, 100/day — way more than a vaad needs.
//
// Two ways to configure:
//   1. Cloudflare Pages secrets: RESEND_API_KEY + EMAIL_FROM (legacy path).
//   2. Admin uploads the key from settings; we store it encrypted under
//      'resend_api_key_enc' + 'resend_api_key_iv' (preferred — lets the
//      building admin manage it without redeploys).
// When both are present, env wins so an org-level key always trumps a
// per-building one.

import { decryptString } from './crypto.js';

const ensureSecret = (env) => env.SESSION_SECRET || 'dev-only-secret-change-me-in-production-please-1234567890';

// Best-effort decryption of the settings-stored API key. Returns null when
// no key is stored or the ciphertext is unreadable (e.g., SESSION_SECRET
// rotated).
async function loadStoredApiKey(env) {
  if (!env?.DB) return null;
  const rows = await env.DB
    .prepare("SELECT key, value FROM settings WHERE key IN ('resend_api_key_enc', 'resend_api_key_iv')")
    .all();
  let ct = '', iv = '';
  for (const r of (rows.results || [])) {
    if (r.key === 'resend_api_key_enc') ct = r.value || '';
    if (r.key === 'resend_api_key_iv') iv = r.value || '';
  }
  if (!ct || !iv) return null;
  try {
    return await decryptString(ct, iv, ensureSecret(env));
  } catch {
    return null;
  }
}

// Resolves the API key to use for this request, preferring the env-var
// (legacy / global) over the per-building stored one.
async function resolveApiKey(env) {
  if (env?.RESEND_API_KEY) return env.RESEND_API_KEY;
  return loadStoredApiKey(env);
}

// Defaults so admin-managed keys still get a sender header even when the
// env vars aren't set.
const FALLBACK_FROM = 'onboarding@resend.dev';

// Quick sync probe — true when env vars are set. The full async check
// (which also looks at the settings table) is in emailEnabledAsync.
export function emailEnabled(env) {
  return !!(env.RESEND_API_KEY && env.EMAIL_FROM);
}

// Async: returns true when EITHER the env path is configured OR a key is
// stored in settings. Callers that need to gate ticket emails should use
// this since the admin-managed path is the common case.
export async function emailEnabledAsync(env) {
  if (emailEnabled(env)) return true;
  const stored = await loadStoredApiKey(env);
  return !!stored;
}

export async function sendEmail(env, { to, subject, html, text, replyTo, apiKeyOverride, fromOverride }) {
  const apiKey = apiKeyOverride || await resolveApiKey(env);
  if (!apiKey) {
    throw new Error('שירות האימייל לא הוגדר (אין מפתח Resend)');
  }
  const fromName = env.EMAIL_FROM_NAME || 'Vaad Bayit';
  const fromAddr = fromOverride || env.EMAIL_FROM || FALLBACK_FROM;
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
      'Authorization': `Bearer ${apiKey}`,
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
  const apiKey = await resolveApiKey(env);
  if (!apiKey) {
    throw new Error('שירות האימייל לא הוגדר (אין מפתח Resend)');
  }
  if (!messages.length) return { ok: true, sent: 0 };
  const fromName = env.EMAIL_FROM_NAME || 'Vaad Bayit';
  const fromAddr = env.EMAIL_FROM || FALLBACK_FROM;
  const fromHeader = `${fromName} <${fromAddr}>`;
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
      'Authorization': `Bearer ${apiKey}`,
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
