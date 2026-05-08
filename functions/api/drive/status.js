// GET /api/drive/status — admin only. Returns connection state.

import { json } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { getDriveStatus } from '../../lib/drive.js';

export const onRequestGet = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const status = await getDriveStatus(env.DB);
  const configured = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return json({ ...status, configured });
};
