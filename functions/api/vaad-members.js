// Vaad (building committee) members — shown in the "About" tab.
//   GET    /api/vaad-members            — list (any logged-in user, incl. tenants)
//   POST   /api/vaad-members            — create (admin)
//   PUT    /api/vaad-members?id=...     — update (admin)
//   DELETE /api/vaad-members?id=...     — delete (admin)

import { json, error, readJSON, pickStr, pickInt, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `id, name, role, phone, email, notes,
  display_order AS displayOrder, created_at AS createdAt, updated_at AS updatedAt`;

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const rows = await env.DB.prepare(
    `SELECT ${SAFE_FIELDS} FROM vaad_members ORDER BY display_order ASC, created_at ASC`
  ).all();
  return json({ members: rows.results });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const name = pickStr(body.name, 200).trim();
  if (!name) return error('יש להזין שם', 400);
  const role = pickStr(body.role, 100);
  const phone = pickStr(body.phone, 30);
  const email = pickStr(body.email, 200);
  const notes = pickStr(body.notes, 1000);
  const displayOrder = pickInt(body.displayOrder) ?? 0;

  const id = uid('vm-');
  await env.DB.prepare(
    'INSERT INTO vaad_members (id, name, role, phone, email, notes, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, name, role || null, phone || null, email || null, notes || null, displayOrder).run();
  await logAudit(env.DB, request, { event: 'vaad_member_created', role: 'admin', userLabel: r.sess.userLabel, meta: { name, role }, success: true });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM vaad_members WHERE id = ?`).bind(id).first();
  return json(row, { status: 201 });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const name = pickStr(body.name, 200).trim();
  if (!name) return error('יש להזין שם', 400);
  const role = pickStr(body.role, 100);
  const phone = pickStr(body.phone, 30);
  const email = pickStr(body.email, 200);
  const notes = pickStr(body.notes, 1000);
  const displayOrder = pickInt(body.displayOrder) ?? 0;

  await env.DB.prepare(
    `UPDATE vaad_members SET name = ?, role = ?, phone = ?, email = ?, notes = ?, display_order = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(name, role || null, phone || null, email || null, notes || null, displayOrder, id).run();
  await logAudit(env.DB, request, { event: 'vaad_member_updated', role: 'admin', userLabel: r.sess.userLabel, success: true });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM vaad_members WHERE id = ?`).bind(id).first();
  return json(row);
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM vaad_members WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'vaad_member_deleted', role: 'admin', userLabel: r.sess.userLabel, success: true });
  return json({ ok: true });
};
