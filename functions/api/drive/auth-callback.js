// GET /api/drive/auth-callback?code=...&state=... — Google redirects here.
// Exchanges code → tokens, ensures the folder exists, persists encrypted refresh token.

import { exchangeCode, ensureFolder, fetchUserEmail, saveDriveConfig } from '../../lib/drive.js';
import { logAudit } from '../../lib/audit.js';

const html = (status, message, ok = false) => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><title>Drive ${ok ? 'connected' : 'error'}</title>
   <style>body{font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:24px;text-align:center}
   .ok{color:#1f7a52}.err{color:#b3261e}h1{font-size:22px}</style></head>
   <body><h1 class="${ok ? 'ok' : 'err'}">${ok ? '✓ Google Drive connected' : '✗ Connection failed'}</h1>
   <p>${message}</p>
   <p><a href="/#settings">Return to settings →</a></p>
   <script>setTimeout(() => location.href = '/#settings', 2000);</script>
   </body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
);

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    return html(400, `Google denied access: ${errorParam}. Please try again.`);
  }
  if (!code || !state) {
    return html(400, 'Missing code or state. Try again from Settings.');
  }

  // Validate state
  const stateRow = await env.DB.prepare("SELECT user_label, created_at FROM oauth_state WHERE state = ?").bind(state).first();
  if (!stateRow) {
    return html(400, 'Invalid or expired session. Please retry the connection.');
  }
  await env.DB.prepare("DELETE FROM oauth_state WHERE state = ?").bind(state).run();

  // Check expiry (30 min)
  const ageMin = (Date.now() - new Date(stateRow.created_at + 'Z').getTime()) / 60000;
  if (ageMin > 30) {
    return html(400, 'Session expired. Please retry.');
  }

  const redirectURI = `${url.origin}/api/drive/auth-callback`;
  let tokens;
  try {
    tokens = await exchangeCode(env, code, redirectURI);
  } catch (e) {
    return html(500, `Token exchange failed: ${e.message}`);
  }
  if (!tokens.refresh_token) {
    return html(400, 'No refresh token received. In Google account settings, revoke previous app access and try again.');
  }

  let folderId, accountEmail;
  try {
    accountEmail = await fetchUserEmail(tokens.access_token);
    folderId = await ensureFolder(tokens.access_token);
  } catch (e) {
    return html(500, `Drive setup failed: ${e.message}`);
  }

  await saveDriveConfig(env.DB, env, { refreshToken: tokens.refresh_token, folderId, accountEmail });
  await logAudit(env.DB, request, { event: 'drive_connected', role: 'admin', userLabel: stateRow.user_label, success: true, meta: { email: accountEmail } });

  return html(200, `Folder "vaad-docs" is ready in ${accountEmail || 'your Drive'}. Redirecting…`, true);
};
