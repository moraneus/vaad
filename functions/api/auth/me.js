// GET /api/auth/me — returns current session info, or 401 if not logged in.
// Also reports whether the system needs first-time admin password change.

import { json } from '../../lib/util.js';
import { loadSession } from '../../lib/session.js';
import { emailEnabled } from '../../lib/email.js';

export const onRequestGet = async ({ request, env }) => {
  const sess = await loadSession(env.DB, request, env);
  const adminRow = await env.DB.prepare('SELECT password_hash AS h FROM admin_auth WHERE id = 1').first();
  const adminUsesDefault = !adminRow || adminRow.h === 'NEEDS_INIT';
  // System capability flag: true when the admin has configured the outgoing
  // email integration (Resend). The frontend uses this to conditionally
  // surface the email opt-in to residents — opt-in is meaningless if the
  // admin can't actually send anything.
  const emailIntegrationEnabled = emailEnabled(env);
  if (!sess) {
    return json({ loggedIn: false, adminUsesDefault, emailEnabled: emailIntegrationEnabled });
  }
  return json({
    loggedIn: true,
    role: sess.role,
    apartmentId: sess.apartmentId,
    ownerId: sess.ownerId || null,
    userKind: sess.userKind || 'tenant',
    userLabel: sess.userLabel,
    expiresAt: sess.expiresAt,
    adminUsesDefault,
    emailEnabled: emailIntegrationEnabled,
  });
};
