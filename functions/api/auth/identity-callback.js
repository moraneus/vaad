// GET /api/auth/identity-callback?code=...&state=...
// Google redirects here after the user picks an account on the consent screen.
// Branches on the `purpose` stored alongside the state nonce:
//
//   register : Store the verified email as admin_recovery.email. Requires admin session.
//   replace  : Replace the existing recovery email with the new verified one.
//              Requires admin session. (Settings UI also requires a current admin
//              password before letting the user start this flow — see settings.js.)
//   reset    : Anonymous. If the verified email matches admin_recovery.email,
//              mint a one-time reset token and redirect to `/?reset=<token>`,
//              which the frontend already handles to render the reset form.

import { uid, clientIP, userAgent } from '../../lib/util.js';
import { loadSession } from '../../lib/session.js';
import { exchangeAndFetchEmail } from '../../lib/identity-oauth.js';
import { randomToken } from '../../lib/crypto.js';
import { logAudit } from '../../lib/audit.js';

const RESET_TTL_MIN = 30;
const STATE_TTL_MIN = 30;

const html = (status, message, ok = false, extraHead = '') => new Response(
  `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${ok ? 'אומת' : 'שגיאת אימות'}</title>
   <meta name="viewport" content="width=device-width,initial-scale=1">
   <style>body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:80px auto;padding:24px;text-align:center;direction:rtl}
   .ok{color:#1f7a52}.err{color:#b3261e}h1{font-size:22px}p{line-height:1.6}
   a{color:#1f4068}</style>${extraHead}</head>
   <body><h1 class="${ok ? 'ok' : 'err'}">${ok ? '✓ אומת בהצלחה' : '✗ אימות נכשל'}</h1>
   <p>${message}</p>
   <p><a href="/#settings">חזרה להגדרות</a></p>
   <script>setTimeout(() => location.href = '/#settings', 2500);</script>
   </body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
);

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const onRequestGet = async ({ request, env }) => {
  const db = env.DB;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) return html(400, `Google denied access: ${errorParam}.`);
  if (!code || !state) return html(400, 'חסרים פרמטרים. נסה שוב מהגדרות.');

  // Validate + consume state
  const stateRow = await db.prepare('SELECT purpose, created_at FROM identity_oauth_state WHERE state = ?').bind(state).first();
  if (!stateRow) return html(400, 'הקישור פג תוקף או אינו תקף. התחל את התהליך מחדש מההגדרות.');
  await db.prepare('DELETE FROM identity_oauth_state WHERE state = ?').bind(state).run();

  const ageMin = (Date.now() - new Date(stateRow.created_at + 'Z').getTime()) / 60000;
  if (ageMin > STATE_TTL_MIN) return html(400, 'הבקשה פגה. נסה שוב.');

  const purpose = stateRow.purpose;
  const redirectURI = `${url.origin}/api/auth/identity-callback`;

  let email;
  try {
    email = await exchangeAndFetchEmail(env, code, redirectURI);
  } catch (e) {
    await logAudit(db, request, { event: 'identity_oauth_failed', role: 'admin', userLabel: 'מנהל', success: false, meta: { purpose, reason: String(e.message || e).slice(0, 200) } });
    return html(500, `אימות נכשל: ${escapeHtml(e.message || 'שגיאה לא ידועה')}`);
  }

  if (purpose === 'register' || purpose === 'replace') {
    const sess = await loadSession(db, request, env);
    if (!sess || sess.role !== 'admin') {
      await logAudit(db, request, { event: 'identity_register_denied', role: 'admin', userLabel: 'מנהל', success: false, meta: { purpose, reason: 'no_admin_session' } });
      return html(403, 'יש להיכנס כמנהל לפני אימות הזהות. התחבר ונסה שוב.');
    }

    await db.prepare(
      `INSERT INTO admin_recovery (id, email, verified_at, updated_at)
       VALUES (1, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         verified_at = excluded.verified_at,
         updated_at = excluded.updated_at`
    ).bind(email).run();

    await logAudit(db, request, {
      event: purpose === 'register' ? 'identity_registered' : 'identity_replaced',
      role: 'admin', userLabel: 'מנהל', success: true, meta: { email },
    });
    return html(200, `הזהות אומתה. ${escapeHtml(email)} שמור כעת ככתובת לאיפוס סיסמה. מעביר חזרה להגדרות…`, true);
  }

  if (purpose === 'reset') {
    const recovery = await db.prepare('SELECT email FROM admin_recovery WHERE id = 1').first();

    if (!recovery?.email || String(recovery.email).toLowerCase() !== email) {
      // Never reveal whether a recovery email exists or whether it matched.
      await logAudit(db, request, { event: 'identity_reset_mismatch', role: 'admin', userLabel: 'מנהל', success: false, meta: { attempted: email } });
      return html(403, 'חשבון Google לא תואם לחשבון השחזור הרשום. אם אתה המנהל, התחבר עם החשבון שרשמת בהגדרות הזהות.');
    }

    // Mint a single-use reset token (same machinery as the previous email-based flow)
    const plainToken = randomToken(32);
    const tokenHash = await sha256Hex(plainToken);
    const expiresAt = new Date(Date.now() + RESET_TTL_MIN * 60 * 1000).toISOString();
    await db.prepare(
      `INSERT INTO password_reset_tokens (id, type, token_hash, expires_at, ip, user_agent)
       VALUES (?, 'admin', ?, ?, ?, ?)`
    ).bind(uid('pwr-'), tokenHash, expiresAt, clientIP(request), userAgent(request)).run();

    await logAudit(db, request, { event: 'identity_reset_minted', role: 'admin', userLabel: 'מנהל', success: true, meta: { email } });

    // Redirect straight to the reset form. Frontend reads ?reset=<token>.
    const target = `/?reset=${encodeURIComponent(plainToken)}`;
    return new Response(null, { status: 302, headers: { location: target } });
  }

  return html(400, 'מטרה לא חוקית.');
};

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
