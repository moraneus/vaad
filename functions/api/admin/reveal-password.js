// GET /api/admin/reveal-password?scope=...&id=...
// Returns the admin-stashed plaintext password for a user. Master admin only.
// Audited so every reveal is traceable.
//
// scope: 'apartment-tenant' | 'apartment-owner-legacy' | 'owner'
// id   : apartmentId or ownerId
//
// Response:
//   { plaintext: '...', updatedAt: '...' }    when stash exists
//   { plaintext: null }                       when no stash (user has self-changed,
//                                              or password is too old to have been stashed)

import { json, error } from '../../lib/util.js';
import { loadSession } from '../../lib/session.js';
import { revealPassword } from '../../lib/password-stash.js';
import { logAudit } from '../../lib/audit.js';

const VALID_SCOPES = new Set(['apartment-tenant', 'apartment-owner-legacy', 'owner']);

export const onRequestGet = async ({ request, env }) => {
  const db = env.DB;
  const sess = await loadSession(db, request, env);
  // Master admin only — apartment-admins or owner-sessions can't peek.
  if (!sess || sess.role !== 'admin' || sess.apartmentId) return error('אין הרשאה', 403);

  const url = new URL(request.url);
  const scope = url.searchParams.get('scope');
  const id = url.searchParams.get('id');
  if (!scope || !VALID_SCOPES.has(scope)) return error('scope לא תקף', 400);
  if (!id) return error('id חסר', 400);

  const result = await revealPassword(db, env, scope, id);
  await logAudit(db, request, { event: 'password_revealed', role: 'admin', userLabel: 'מנהל', success: !!result, meta: { scope, id } });
  if (!result) return json({ plaintext: null });
  return json({ plaintext: result.plaintext, updatedAt: result.updatedAt });
};
