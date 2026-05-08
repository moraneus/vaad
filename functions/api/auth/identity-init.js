// POST /api/auth/identity-init
// Body: { purpose: 'register' | 'replace' | 'reset' }
//
// Returns: { url } — Google OAuth consent URL the client redirects to.
//
// Purposes:
//   register: first-time admin verifies a Google email. Requires admin session.
//   replace : admin already has a recovery email, wants to switch to a new
//             Google account. Requires admin session.
//   reset   : anonymous "forgot password" flow. Verified email at the callback
//             must match admin_recovery.email to mint a reset token.
//             Rate-limited per IP.

import { json, error, uid, readJSON } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { buildIdentityAuthURL } from '../../lib/identity-oauth.js';
import { logAudit, checkRateLimit, recordFailedAttempt } from '../../lib/audit.js';

const VALID_PURPOSES = new Set(['register', 'replace', 'reset']);

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return error('Google OAuth client not configured. Admin must set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', 412);
  }

  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const purpose = String(body?.purpose || '').trim();
  if (!VALID_PURPOSES.has(purpose)) return error('מטרה לא חוקית', 400);

  if (purpose === 'register' || purpose === 'replace') {
    const r = await requireAdmin(env, request);
    if (r.error) return r.error;
  } else {
    // 'reset' — anonymous, rate-limit per IP
    const rl = await checkRateLimit(db, request, 'identity-reset', env);
    if (!rl.allowed) {
      await logAudit(db, request, { event: 'identity_reset_rate_limited', role: 'admin', userLabel: 'מנהל', success: false });
      return error('יותר מדי בקשות. נסה שוב מאוחר יותר.', 429, { retryAfterSec: rl.retryAfterSec });
    }
    await recordFailedAttempt(db, request, 'identity-reset');
  }

  const url = new URL(request.url);
  const redirectURI = `${url.origin}/api/auth/identity-callback`;
  const state = uid('id-');

  await db.prepare('INSERT INTO identity_oauth_state (state, purpose) VALUES (?, ?)').bind(state, purpose).run();
  // Best-effort prune of expired state nonces (older than 30 minutes)
  db.prepare("DELETE FROM identity_oauth_state WHERE datetime(created_at) < datetime('now', '-30 minutes')").run().catch(() => {});

  await logAudit(db, request, { event: 'identity_oauth_started', role: 'admin', userLabel: 'מנהל', success: true, meta: { purpose } });
  return json({ url: buildIdentityAuthURL(env, redirectURI, state) });
};
