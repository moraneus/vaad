// GET    /api/apartments        — list (any logged-in user)
// POST   /api/apartments        — create (admin)
// PUT    /api/apartments?id=... — update (admin)
// DELETE /api/apartments?id=... — delete (admin)

import { json, error, readJSON, pickStr, isISODate, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `a.id, a.number, a.owner, a.phone, a.notes, a.active_from AS activeFrom,
  CASE WHEN a.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword,
  a.password_set_at AS passwordSetAt,
  CASE WHEN aa.apartment_id IS NULL THEN 0 ELSE 1 END AS isAdmin,
  ae.email AS email`;

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const rows = await env.DB.prepare(
    `SELECT ${SAFE_FIELDS} FROM apartments a
       LEFT JOIN apartment_admins aa ON aa.apartment_id = a.id
       LEFT JOIN apartment_email ae ON ae.apartment_id = a.id
     ORDER BY CAST(a.number AS INTEGER), a.number`
  ).all();
  return json({ apartments: rows.results });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const number = pickStr(body.number, 20).trim();
  if (!number) return error('יש להזין מספר דירה', 400);
  const owner = pickStr(body.owner, 200);
  const phone = pickStr(body.phone, 30);
  const notes = pickStr(body.notes, 1000);
  const activeFrom = isISODate(body.activeFrom) ? body.activeFrom : null;

  const id = uid('apt-');
  try {
    await env.DB.prepare('INSERT INTO apartments (id, number, owner, phone, notes, active_from) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, number, owner || null, phone || null, notes || null, activeFrom).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return error('מספר דירה כבר קיים במערכת', 409);
    throw e;
  }
  await logAudit(env.DB, request, { event: 'apartment_created', role: 'admin', userLabel: 'מנהל', meta: { number }, success: true });
  const row = await env.DB.prepare(
    `SELECT ${SAFE_FIELDS} FROM apartments a
       LEFT JOIN apartment_admins aa ON aa.apartment_id = a.id
       LEFT JOIN apartment_email ae ON ae.apartment_id = a.id
      WHERE a.id = ?`
  ).bind(id).first();
  return json(row, { status: 201 });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const number = pickStr(body.number, 20).trim();
  if (!number) return error('יש להזין מספר דירה', 400);
  const owner = pickStr(body.owner, 200);
  const phone = pickStr(body.phone, 30);
  const notes = pickStr(body.notes, 1000);
  const activeFrom = isISODate(body.activeFrom) ? body.activeFrom : null;
  try {
    await env.DB.prepare('UPDATE apartments SET number = ?, owner = ?, phone = ?, notes = ?, active_from = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .bind(number, owner || null, phone || null, notes || null, activeFrom, id).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return error('מספר דירה כבר קיים במערכת', 409);
    throw e;
  }
  await logAudit(env.DB, request, { event: 'apartment_updated', role: 'admin', userLabel: 'מנהל', success: true });
  const row = await env.DB.prepare(
    `SELECT ${SAFE_FIELDS} FROM apartments a
       LEFT JOIN apartment_admins aa ON aa.apartment_id = a.id
       LEFT JOIN apartment_email ae ON ae.apartment_id = a.id
      WHERE a.id = ?`
  ).bind(id).first();
  return json(row);
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM apartments WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'apartment_deleted', role: 'admin', userLabel: 'מנהל', meta: { id }, success: true });
  return json({ ok: true });
};
