// Contacts CRUD.

import { json, error, readJSON, pickStr, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const FIELDS = 'id, company, name, role, phone, email, notes';

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const rows = await env.DB.prepare(`SELECT ${FIELDS} FROM contacts ORDER BY company COLLATE NOCASE`).all();
  return json({ contacts: rows.results });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const company = pickStr(body.company, 200).trim();
  if (!company) return error('שם החברה חסר', 400);
  const id = uid('c-');
  await env.DB.prepare('INSERT INTO contacts (id, company, name, role, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, company, pickStr(body.name, 200) || null, pickStr(body.role, 100) || null, pickStr(body.phone, 30) || null, pickStr(body.email, 200) || null, pickStr(body.notes, 1000) || null).run();
  await logAudit(env.DB, request, { event: 'contact_created', role: 'admin', userLabel: 'מנהל', meta: { company }, success: true });
  return json(await env.DB.prepare(`SELECT ${FIELDS} FROM contacts WHERE id = ?`).bind(id).first(), { status: 201 });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const company = pickStr(body.company, 200).trim();
  if (!company) return error('שם החברה חסר', 400);
  await env.DB.prepare('UPDATE contacts SET company = ?, name = ?, role = ?, phone = ?, email = ?, notes = ? WHERE id = ?')
    .bind(company, pickStr(body.name, 200) || null, pickStr(body.role, 100) || null, pickStr(body.phone, 30) || null, pickStr(body.email, 200) || null, pickStr(body.notes, 1000) || null, id).run();
  return json(await env.DB.prepare(`SELECT ${FIELDS} FROM contacts WHERE id = ?`).bind(id).first());
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(id).run();
  return json({ ok: true });
};
