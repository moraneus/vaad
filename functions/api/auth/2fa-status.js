// GET /api/auth/2fa/status — is 2FA enabled for the master admin?
// Available to any logged-in user (used by the settings UI).

import { json } from '../../lib/util.js';
import { requireSession } from '../../lib/guard.js';
import { admin2FAEnabled } from '../../lib/admin2fa.js';

export const onRequestGet = async ({ request, env }) => {
  const r = await requireSession(env, request); if (r.error) return r.error;
  const enabled = await admin2FAEnabled(env.DB);
  return json({ enabled });
};
