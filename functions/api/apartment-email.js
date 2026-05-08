// Manage the opt-in email address per apartment.
//   GET    /api/apartment-email?apartmentId=...   — lookup current (any logged-in)
//   POST   /api/apartment-email   { apartmentId, email }   — set/update
//   DELETE /api/apartment-email?apartmentId=...           — opt out
//
// Tenants may only manage their own apartment's email. Admins may set/clear
// any apartment's email (so they can fix typos on behalf of residents).

import { json, error, readJSON, pickStr } from '../lib/util.js';
import { requireSession } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length < 200;
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireSession(env, request); if (r.error) return r.error;
  const apartmentId = new URL(request.url).searchParams.get('apartmentId');
  if (!apartmentId) return error('id חסר', 400);
  if (r.sess.role !== 'admin' && r.sess.apartmentId !== apartmentId) {
    return error('אין הרשאה', 403);
  }
  const row = await env.DB.prepare(
    'SELECT email, consented_at AS consentedAt, updated_at AS updatedAt FROM apartment_email WHERE apartment_id = ?'
  ).bind(apartmentId).first();
  return json(row || { email: null });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireSession(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const apartmentId = pickStr(body.apartmentId, 80);
  const email = pickStr(body.email, 200).trim().toLowerCase();
  if (!apartmentId || !email) return error('שדות חובה חסרים', 400);
  if (!isValidEmail(email)) return error('כתובת מייל לא תקפה', 400);
  if (r.sess.role !== 'admin' && r.sess.apartmentId !== apartmentId) {
    return error('אין הרשאה', 403);
  }
  await env.DB.prepare(
    `INSERT INTO apartment_email (apartment_id, email)
     VALUES (?, ?)
     ON CONFLICT(apartment_id) DO UPDATE SET email = excluded.email, updated_at = datetime('now')`
  ).bind(apartmentId, email).run();
  await logAudit(env.DB, request, { event: 'apartment_email_set', role: r.sess.role, userLabel: r.sess.userLabel, apartmentId, success: true });
  return json({ ok: true, email });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireSession(env, request); if (r.error) return r.error;
  const apartmentId = new URL(request.url).searchParams.get('apartmentId');
  if (!apartmentId) return error('id חסר', 400);
  if (r.sess.role !== 'admin' && r.sess.apartmentId !== apartmentId) {
    return error('אין הרשאה', 403);
  }
  await env.DB.prepare('DELETE FROM apartment_email WHERE apartment_id = ?').bind(apartmentId).run();
  await logAudit(env.DB, request, { event: 'apartment_email_removed', role: r.sess.role, userLabel: r.sess.userLabel, apartmentId, success: true });
  return json({ ok: true });
};
