// Permission guards for API endpoints.

import { error } from './util.js';
import { loadSession } from './session.js';

export async function requireSession(env, request) {
  const sess = await loadSession(env.DB, request, env);
  if (!sess) return { error: error('יש להתחבר תחילה', 401) };
  return { sess };
}

export async function requireAdmin(env, request) {
  const r = await requireSession(env, request);
  if (r.error) return r;
  if (r.sess.role !== 'admin') return { error: error('פעולה זו דורשת הרשאת מנהל', 403) };
  return r;
}

// Tenants are read-only on most resources. Admin = full access.
export async function requireRead(env, request) {
  return requireSession(env, request);
}
