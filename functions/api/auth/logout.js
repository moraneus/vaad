import { json } from '../../lib/util.js';
import { destroySession, clearCookie } from '../../lib/session.js';
import { logAudit } from '../../lib/audit.js';
import { loadSession } from '../../lib/session.js';

export const onRequestPost = async ({ request, env }) => {
  const sess = await loadSession(env.DB, request, env);
  if (sess) {
    await logAudit(env.DB, request, { event: 'logout', role: sess.role, userLabel: sess.userLabel, apartmentId: sess.apartmentId, success: true });
  }
  await destroySession(env.DB, request, env);
  const res = json({ ok: true });
  clearCookie(res, env, request);
  return res;
};
