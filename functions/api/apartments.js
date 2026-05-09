// GET    /api/apartments        — list (any logged-in user)
// POST   /api/apartments        — create (admin)
// PUT    /api/apartments?id=... — update (admin)
// DELETE /api/apartments?id=... — delete (admin)

import { json, error, readJSON, pickStr, isISODate, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';
import { generateRandomPassword, hashPassword } from '../lib/crypto.js';
import { stashPassword, wipePassword } from '../lib/password-stash.js';

// SAFE_FIELDS — joins owners (the new first-class entity) via apartment_owner_link.
// ownerId/ownerName/ownerPhone/ownerEmail are sourced from `owners` when a link
// exists; legacy apartment_occupancy.owner_* fields are kept for backwards
// compat (older rows might still have them populated even after migration).
const SAFE_FIELDS = `a.id, a.number, a.owner, a.phone, a.notes, a.active_from AS activeFrom,
  CASE WHEN a.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword,
  a.password_set_at AS passwordSetAt,
  CASE WHEN aa.apartment_id IS NULL THEN 0 ELSE 1 END AS isAdmin,
  ae.email AS email,
  COALESCE(occ.occupant_type, 'owner') AS occupantType,
  l.owner_id AS ownerId,
  COALESCE(o.name,  occ.owner_name)  AS ownerName,
  COALESCE(o.phone, occ.owner_phone) AS ownerPhone,
  COALESCE(o.email, occ.owner_email) AS ownerEmail`;

const FROM_CLAUSE = `FROM apartments a
  LEFT JOIN apartment_admins aa ON aa.apartment_id = a.id
  LEFT JOIN apartment_email ae ON ae.apartment_id = a.id
  LEFT JOIN apartment_occupancy occ ON occ.apartment_id = a.id
  LEFT JOIN apartment_owner_link l ON l.apartment_id = a.id
  LEFT JOIN owners o ON o.id = l.owner_id`;

// Validate occupant_type input. Returns one of 'owner' | 'renter'.
function pickOccupant(v) {
  const s = String(v || '').trim();
  return s === 'renter' ? 'renter' : 'owner';
}

// Upsert occupancy row. occupant_type only — owner_name/phone/email are
// deprecated (the source of truth is the `owners` table via apartment_owner_link).
// Kept here for backwards compat with old rows that still carry them.
async function saveOccupancy(db, apartmentId, body) {
  const occupantType = pickOccupant(body.occupantType);
  await db.prepare(
    `INSERT INTO apartment_occupancy (apartment_id, occupant_type, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(apartment_id) DO UPDATE SET
       occupant_type = excluded.occupant_type,
       updated_at = excluded.updated_at`
  ).bind(apartmentId, occupantType).run();
}

// Upsert apartment ↔ owner link. body.ownerId MUST point to an existing
// owner — the UI picker is the only sanctioned way to pick or create one.
// If a legacy caller still sends ownerName/Phone/Email (without ownerId),
// the helper falls back to inline-create — but logs a deprecation note.
async function saveOwnerLink(db, apartmentId, body) {
  let ownerId = pickStr(body.ownerId, 80);
  if (ownerId) {
    const owner = await db.prepare('SELECT id FROM owners WHERE id = ?').bind(ownerId).first();
    if (!owner) throw new Error('Owner not found: ' + ownerId);
  } else if (pickStr(body.ownerName, 200)) {
    // Legacy inline-create path. Only triggers if the caller explicitly
    // provided ownerName — never as a silent fallback from `body.owner`
    // (the resident field). This prevents the "creating an apartment via
    // the new dialog spawns a duplicate owner" bug.
    const name = pickStr(body.ownerName, 200);
    const phone = pickStr(body.ownerPhone, 30) || null;
    const email = pickStr(body.ownerEmail, 254) || null;
    ownerId = uid('own-');
    await db.prepare(
      'INSERT INTO owners (id, name, phone, email) VALUES (?, ?, ?, ?)'
    ).bind(ownerId, name, phone, email).run();
  } else {
    throw new Error('ownerId required');
  }
  await db.prepare(
    `INSERT INTO apartment_owner_link (apartment_id, owner_id, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(apartment_id) DO UPDATE SET
       owner_id = excluded.owner_id,
       updated_at = excluded.updated_at`
  ).bind(apartmentId, ownerId).run();
  return ownerId;
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const rows = await env.DB.prepare(
    `SELECT ${SAFE_FIELDS} ${FROM_CLAUSE} ORDER BY CAST(a.number AS INTEGER), a.number`
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

  // Tenant credentials are only created for renter-occupied apartments.
  // Owner-occupied apartments are accessed via the owner's own login (the
  // owner picks their name on the Owner tab and sees all their apartments).
  // When occupant_type='owner', apartment.password_hash stays NULL.
  const occupantType = pickOccupant(body.occupantType);
  let initialPassword = null;
  let h = null;
  if (occupantType === 'renter') {
    initialPassword = generateRandomPassword(8);
    h = await hashPassword(initialPassword, Number(env.PBKDF2_ITERATIONS || 100000));
  }

  const id = uid('apt-');
  try {
    if (h) {
      await env.DB.prepare(
        `INSERT INTO apartments (id, number, owner, phone, notes, active_from, password_hash, password_salt, iterations, password_set_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(id, number, owner || null, phone || null, notes || null, activeFrom, h.hash, h.salt, h.iterations).run();
    } else {
      await env.DB.prepare(
        'INSERT INTO apartments (id, number, owner, phone, notes, active_from) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(id, number, owner || null, phone || null, notes || null, activeFrom).run();
    }
  } catch (e) {
    if (String(e).includes('UNIQUE')) return error('מספר דירה כבר קיים במערכת', 409);
    throw e;
  }
  await saveOccupancy(env.DB, id, body);
  try { await saveOwnerLink(env.DB, id, body); }
  catch (e) { return error(String(e.message || e), 400); }
  // Stash plaintext (encrypted) for admin re-display. Only meaningful when a
  // password was generated (renter-occupied apartments).
  if (initialPassword) {
    await stashPassword(env.DB, env, 'apartment-tenant', id, initialPassword);
  }
  await logAudit(env.DB, request, { event: 'apartment_created', role: 'admin', userLabel: 'מנהל', meta: { number, occupantType }, success: true });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} ${FROM_CLAUSE} WHERE a.id = ?`).bind(id).first();
  return json({ ...row, initialPassword }, { status: 201 });
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
  await saveOccupancy(env.DB, id, body);
  // Owner link is only re-saved if the caller passes ownerId (or owner-fields
  // for inline create). Existing link is preserved when the body omits them.
  if (body.ownerId || body.ownerName || body.ownerPhone || body.ownerEmail) {
    try { await saveOwnerLink(env.DB, id, body); }
    catch (e) { return error(String(e.message || e), 400); }
  }
  await logAudit(env.DB, request, { event: 'apartment_updated', role: 'admin', userLabel: 'מנהל', success: true });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} ${FROM_CLAUSE} WHERE a.id = ?`).bind(id).first();
  return json(row);
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);

  // Capture the linked owner (if any) BEFORE deleting — the cascade on
  // apartment_owner_link wipes the link. We use this to report whether the
  // owner is now orphaned (no remaining apartments) so the frontend can offer
  // to delete them too.
  const linkedOwner = await env.DB.prepare(
    'SELECT owner_id AS ownerId FROM apartment_owner_link WHERE apartment_id = ?'
  ).bind(id).first();
  const ownerId = linkedOwner?.ownerId || null;

  await env.DB.prepare('DELETE FROM apartments WHERE id = ?').bind(id).run();

  let orphanedOwner = null;
  if (ownerId) {
    const remaining = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM apartment_owner_link WHERE owner_id = ?'
    ).bind(ownerId).first();
    if ((remaining?.n || 0) === 0) {
      const ownerRow = await env.DB.prepare('SELECT id, name FROM owners WHERE id = ?').bind(ownerId).first();
      if (ownerRow) orphanedOwner = { id: ownerRow.id, name: ownerRow.name };
    }
  }

  await logAudit(env.DB, request, { event: 'apartment_deleted', role: 'admin', userLabel: 'מנהל', meta: { id, orphanedOwnerId: orphanedOwner?.id || null }, success: true });
  return json({ ok: true, orphanedOwner });
};
