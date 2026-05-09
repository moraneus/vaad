// GET    /api/owners        — list (any logged-in)
// POST   /api/owners        — create (admin)
// PUT    /api/owners?id=... — update (admin)
// DELETE /api/owners?id=... — delete (admin) — only when no apartments are linked

import { json, error, readJSON, pickStr, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';
import { generateRandomPassword, hashPassword, validatePassword } from '../lib/crypto.js';
import { stashPassword } from '../lib/password-stash.js';

const SAFE_FIELDS = `o.id, o.name, o.phone, o.email, o.login_email AS loginEmail,
  o.notes, o.created_at AS createdAt, o.updated_at AS updatedAt,
  CASE WHEN o.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword,
  o.password_set_at AS passwordSetAt,
  (SELECT COUNT(*) FROM apartment_owner_link l WHERE l.owner_id = o.id) AS apartmentCount,
  CASE WHEN EXISTS(SELECT 1 FROM owner_admins WHERE owner_id = o.id) THEN 1 ELSE 0 END AS isAdmin`;

// Reads the multi-phone rows for one or many owners. Returns a Map keyed by
// owner_id whose value is an ordered array of { id, label, phone }.
async function loadPhonesByOwner(db, ownerIds) {
  if (!ownerIds.length) return new Map();
  const placeholders = ownerIds.map(() => '?').join(',');
  const res = await db.prepare(
    `SELECT id, owner_id AS ownerId, phone, label, sort_order AS sortOrder
       FROM owner_phones
      WHERE owner_id IN (${placeholders})
      ORDER BY owner_id, sort_order, created_at`
  ).bind(...ownerIds).all();
  const byOwner = new Map();
  for (const row of (res.results || [])) {
    const arr = byOwner.get(row.ownerId) || [];
    arr.push({ id: row.id, phone: row.phone, label: row.label || '' });
    byOwner.set(row.ownerId, arr);
  }
  return byOwner;
}

// Replaces all owner_phones rows for `ownerId` with the given array.
// Each entry: { phone, label }. Empty/whitespace phones are skipped.
async function replacePhones(db, ownerId, phones) {
  await db.prepare('DELETE FROM owner_phones WHERE owner_id = ?').bind(ownerId).run();
  if (!Array.isArray(phones) || !phones.length) return;
  let order = 0;
  for (const p of phones) {
    const phone = String(p?.phone || '').trim().slice(0, 30);
    if (!phone) continue;
    const label = String(p?.label || '').trim().slice(0, 80) || null;
    await db.prepare(
      'INSERT INTO owner_phones (id, owner_id, phone, label, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).bind(uid('phn-'), ownerId, phone, label, order++).run();
  }
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const rows = await env.DB.prepare(
    `SELECT ${SAFE_FIELDS} FROM owners o ORDER BY o.name`
  ).all();
  const owners = rows.results || [];
  const phonesMap = await loadPhonesByOwner(env.DB, owners.map(o => o.id));
  for (const o of owners) o.phones = phonesMap.get(o.id) || [];
  return json({ owners });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const name = pickStr(body.name, 200).trim();
  const phone = pickStr(body.phone, 30);
  const email = pickStr(body.email, 254);
  const loginEmail = pickStr(body.loginEmail, 254).trim().toLowerCase();
  const notes = pickStr(body.notes, 1000);
  if (!name) return error('יש להזין שם בעלים', 400);

  // Initial password — admin-typed (validated against policy) OR
  // auto-generated random 8-char alphanumeric. Hash is stored; plaintext is
  // returned ONCE in the response so the admin can hand it to the owner.
  let initialPassword = pickStr(body.initialPassword, 200);
  if (initialPassword) {
    const v = validatePassword(initialPassword);
    if (!v.ok) {
      return json({ error: 'הסיסמה לא עומדת במדיניות (8+ תווים, אות גדולה+קטנה, ספרה, סימול)', passwordPolicy: v }, { status: 400 });
    }
  } else {
    initialPassword = generateRandomPassword(8);
  }
  const h = await hashPassword(initialPassword, Number(env.PBKDF2_ITERATIONS || 100000));

  // Multi-phone payload (optional). When supplied, supersedes the legacy
  // single `phone` field — the first entry becomes the legacy `phone` for
  // backwards compat with display sites that haven't moved over yet.
  const phones = Array.isArray(body.phones) ? body.phones : null;
  const primaryPhone = phones?.find(p => String(p?.phone || '').trim())?.phone || phone;

  const id = uid('own-');
  try {
    await env.DB.prepare(
      `INSERT INTO owners (id, name, phone, email, login_email, notes, password_hash, password_salt, iterations, password_set_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(id, name, primaryPhone || null, email || null, loginEmail || null, notes || null, h.hash, h.salt, h.iterations).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return error('כתובת מייל לכניסה כבר בשימוש', 409);
    throw e;
  }
  if (phones) await replacePhones(env.DB, id, phones);
  // Stash plaintext for admin re-display.
  await stashPassword(env.DB, env, 'owner', id, initialPassword);
  await logAudit(env.DB, request, { event: 'owner_created', role: 'admin', userLabel: 'מנהל', meta: { id, name }, success: true });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM owners o WHERE o.id = ?`).bind(id).first();
  const phonesMap = await loadPhonesByOwner(env.DB, [id]);
  return json({ ...row, phones: phonesMap.get(id) || [], initialPassword }, { status: 201 });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const name = pickStr(body.name, 200).trim();
  const phone = pickStr(body.phone, 30);
  const email = pickStr(body.email, 254);
  const loginEmail = pickStr(body.loginEmail, 254).trim().toLowerCase();
  const notes = pickStr(body.notes, 1000);
  if (!name) return error('יש להזין שם בעלים', 400);

  // Multi-phone: when `phones` is in the body, replace all owner_phones rows
  // and use the first non-empty phone as the legacy `owners.phone` value.
  const phones = Array.isArray(body.phones) ? body.phones : null;
  const primaryPhone = phones?.find(p => String(p?.phone || '').trim())?.phone || phone;

  try {
    await env.DB.prepare(
      "UPDATE owners SET name = ?, phone = ?, email = ?, login_email = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(name, primaryPhone || null, email || null, loginEmail || null, notes || null, id).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return error('כתובת מייל לכניסה כבר בשימוש', 409);
    throw e;
  }
  if (phones) await replacePhones(env.DB, id, phones);
  await logAudit(env.DB, request, { event: 'owner_updated', role: 'admin', userLabel: 'מנהל', meta: { id }, success: true });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM owners o WHERE o.id = ?`).bind(id).first();
  const phonesMap = await loadPhonesByOwner(env.DB, [id]);
  return json({ ...row, phones: phonesMap.get(id) || [] });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  // Refuse deletion if the owner still holds apartments — admin must reassign first.
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM apartment_owner_link WHERE owner_id = ?').bind(id).first();
  if ((used?.n || 0) > 0) {
    return error('לא ניתן למחוק בעלים שיש בבעלותו דירות. העבר את הדירות לבעלים אחר ונסה שוב.', 409);
  }
  await env.DB.prepare('DELETE FROM owners WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'owner_deleted', role: 'admin', userLabel: 'מנהל', meta: { id }, success: true });
  return json({ ok: true });
};
