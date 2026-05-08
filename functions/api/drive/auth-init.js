// POST /api/drive/auth-init — admin-only. Returns Google OAuth URL.
// State token is stored in DB so the callback can validate.

import { json, error, uid } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { buildAuthURL } from '../../lib/drive.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return error('Google OAuth client not configured. Admin must set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets.', 412);
  }
  const url = new URL(request.url);
  const redirectURI = `${url.origin}/api/drive/auth-callback`;
  const state = uid('s-');
  await env.DB.prepare("INSERT INTO oauth_state (state, user_label) VALUES (?, ?)").bind(state, r.sess.userLabel).run();
  // Best-effort prune of expired state tokens (older than 30 minutes)
  env.DB.prepare("DELETE FROM oauth_state WHERE datetime(created_at) < datetime('now', '-30 minutes')").run().catch(() => {});

  await logAudit(env.DB, request, { event: 'drive_oauth_started', role: 'admin', userLabel: 'מנהל', success: true });
  return json({ url: buildAuthURL(env, redirectURI, state) });
};
