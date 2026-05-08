// POST /api/auth/reset-apartment — admin only. Clears the apartment password so
// the tenant can set a new one on next login.
// Body: { apartmentId }

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { loadSession } from '../../lib/session.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  const sess = await loadSession(db, request, env);
  if (!sess || sess.role !== 'admin') return error('אין הרשאה', 403);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const apartmentId = pickStr(body.apartmentId, 80);
  const apt = await db.prepare('SELECT id, number FROM apartments WHERE id = ?').bind(apartmentId).first();
  if (!apt) return error('דירה לא נמצאה', 404);
  await db.prepare('UPDATE apartments SET password_hash = NULL, password_salt = NULL, iterations = NULL, password_set_at = NULL, updated_at = datetime(\'now\') WHERE id = ?').bind(apt.id).run();
  // Invalidate any active tenant sessions for this apartment
  await db.prepare('DELETE FROM sessions WHERE apartment_id = ?').bind(apt.id).run();
  await logAudit(db, request, { event: 'apartment_password_reset', role: 'admin', userLabel: 'מנהל', apartmentId: apt.id, meta: { number: apt.number }, success: true });
  return json({ ok: true });
};
