// POST /api/auth/identity-disconnect
//
// Removes the verified Google email associated with the CURRENT logged-in
// user — same scope rules as identity-status:
//   - master admin                 → admin_recovery row id=1
//   - apartment owner session      → apartment_owner_recovery for the apt
//   - apartment renter (tenant)    → apartment_recovery for the apt
//   - first-class owner (PR-E)     → owner_recovery for the owner
//
// Once disconnected, the Google-based password-recovery shortcut for that
// user is unavailable until they re-register via /identity-init. The main
// login + 2FA flows are unaffected.

import { json, error } from '../../lib/util.js';
import { loadSession } from '../../lib/session.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  const sess = await loadSession(db, request, env);
  if (!sess) return error('יש להתחבר תחילה', 401);

  // Pick the right recovery row to clear. The order here mirrors
  // identity-status so a session with both ownerId AND apartmentId
  // (legacy owner-as-apartment) clears the owner row.
  let scope = '';
  if (sess.ownerId) {
    await db.prepare('DELETE FROM owner_recovery WHERE owner_id = ?').bind(sess.ownerId).run();
    scope = 'owner';
  } else if (sess.apartmentId) {
    const userKind = sess.userKind === 'owner' ? 'owner' : 'tenant';
    const tableName = userKind === 'owner' ? 'apartment_owner_recovery' : 'apartment_recovery';
    await db.prepare(`DELETE FROM ${tableName} WHERE apartment_id = ?`).bind(sess.apartmentId).run();
    scope = `apartment-${userKind}`;
  } else if (sess.role === 'admin') {
    await db.prepare('DELETE FROM admin_recovery WHERE id = 1').run();
    scope = 'master';
  } else {
    return error('אין הרשאה', 403);
  }

  await logAudit(db, request, {
    event: 'identity_disconnected',
    role: sess.role,
    userLabel: sess.userLabel || null,
    meta: { scope },
    success: true,
  });
  return json({ ok: true });
};
