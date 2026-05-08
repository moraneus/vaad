// GET /api/auth/me — returns current session info, or 401 if not logged in.
// Also reports whether the system needs first-time admin password change.

import { json } from '../../lib/util.js';
import { loadSession } from '../../lib/session.js';

export const onRequestGet = async ({ request, env }) => {
  const sess = await loadSession(env.DB, request, env);
  const adminRow = await env.DB.prepare('SELECT password_hash AS h FROM admin_auth WHERE id = 1').first();
  const adminUsesDefault = !adminRow || adminRow.h === 'NEEDS_INIT';
  if (!sess) {
    return json({ loggedIn: false, adminUsesDefault });
  }
  return json({
    loggedIn: true,
    role: sess.role,
    apartmentId: sess.apartmentId,
    userLabel: sess.userLabel,
    expiresAt: sess.expiresAt,
    adminUsesDefault,
  });
};
