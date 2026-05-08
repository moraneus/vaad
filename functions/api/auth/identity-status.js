// GET /api/auth/identity-status — admin-only.
// Returns whether a recovery email is registered and what it is.

import { json } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';

export const onRequestGet = async ({ request, env }) => {
  const r = await requireAdmin(env, request);
  if (r.error) return r.error;

  const row = await env.DB.prepare('SELECT email, verified_at AS verifiedAt FROM admin_recovery WHERE id = 1').first();
  return json({
    registered: !!row?.email,
    email: row?.email || null,
    verifiedAt: row?.verifiedAt || null,
  });
};
