// POST /api/drive/disconnect — admin only. Removes Drive credentials from D1.
// Note: this does not delete files from the user's Drive. The vaad-docs folder
// remains in the admin's account; the admin can delete it manually.

import { json } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { disconnectDrive } from '../../lib/drive.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  await disconnectDrive(env.DB);
  await logAudit(env.DB, request, { event: 'drive_disconnected', role: 'admin', userLabel: r.sess.userLabel, success: true });
  return json({ ok: true });
};
