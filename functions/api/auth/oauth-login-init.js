// POST /api/auth/oauth-login-init
//
// Anonymous endpoint — starts a Google OAuth flow whose callback will look
// up the verified email in our user records and create a session if a match
// is found. Distinct from identity-init (which is for verifying the recovery
// account of an already-logged-in user); this one IS the login.
//
// Lookup order (in identity-callback, purpose='login'):
//   1. owners.login_email          → first-class owner session
//   2. apartment_email.email       → renter session for that apartment
// No match → polite error page from the callback.
//
// Rate-limited per IP to mirror the password login path.

import { json, error, uid } from '../../lib/util.js';
import { buildIdentityAuthURL } from '../../lib/identity-oauth.js';
import { logAudit, checkRateLimit, recordFailedAttempt } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return error('Google OAuth client not configured. Admin must set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', 412);
  }

  const rl = await checkRateLimit(db, request, 'oauth-login', env);
  if (!rl.allowed) {
    await logAudit(db, request, { event: 'login_rate_limited', role: 'tenant', userLabel: 'oauth', success: false });
    return error('יותר מדי בקשות. נסה שוב מאוחר יותר.', 429, { retryAfterSec: rl.retryAfterSec });
  }
  // Pre-emptively count this attempt so a stuck OAuth flow doesn't bypass
  // the rate limiter. clearAttempts in the callback would zero this on
  // success, but we don't have a hook there yet — fine for now.
  await recordFailedAttempt(db, request, 'oauth-login');

  const url = new URL(request.url);
  const redirectURI = `${url.origin}/api/auth/identity-callback`;
  const state = uid('id-');

  await db.prepare(
    "INSERT INTO identity_oauth_state (state, purpose, scope) VALUES (?, 'login', 'login')"
  ).bind(state).run();
  // Best-effort prune of expired state nonces (older than 30 minutes)
  db.prepare("DELETE FROM identity_oauth_state WHERE datetime(created_at) < datetime('now', '-30 minutes')").run().catch(() => {});

  await logAudit(db, request, { event: 'oauth_login_started', role: 'tenant', userLabel: 'oauth', success: true });
  return json({ url: buildIdentityAuthURL(env, redirectURI, state) });
};
