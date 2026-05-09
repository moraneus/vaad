// Vaad (building committee) members — shown in the "About" tab.
// Each member is linked to an existing person (owner or apartment-renter);
// the manual name/phone/email entry path has been retired in favour of a
// curated picker on the client. The vaad_members row still stores a
// snapshot of the person's name/phone/email at link time so the committee
// card renders even if the source entity is later deleted/renamed.
//
//   GET    /api/vaad-members            — list (any logged-in user, incl. tenants)
//   POST   /api/vaad-members            — create (admin) — body must include linkedKind+linkedId
//   PUT    /api/vaad-members?id=...     — update (admin)
//   DELETE /api/vaad-members?id=...     — delete (admin)

import { json, error, readJSON, pickStr, pickInt, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `id, name, role, phone, email, notes,
  display_order AS displayOrder, created_at AS createdAt, updated_at AS updatedAt`;

// Resolves the snapshot name/phone/email for a (kind, linkedId) pair from
// the source table. Returns { name, phone, email } or null if the source
// entity wasn't found.
async function resolveLinkedSnapshot(db, kind, linkedId) {
  if (kind === 'owner') {
    const row = await db.prepare(
      'SELECT name, phone, email FROM owners WHERE id = ?'
    ).bind(linkedId).first();
    return row || null;
  }
  if (kind === 'apartment') {
    const row = await db.prepare(
      // apartments.owner stores the renter's display name; apartments.phone is
      // the renter's phone. apartment_email is a separate opt-in table.
      `SELECT a.owner AS name, a.phone AS phone, ae.email AS email
         FROM apartments a
         LEFT JOIN apartment_email ae ON ae.apartment_id = a.id
        WHERE a.id = ?`
    ).bind(linkedId).first();
    return row || null;
  }
  return null;
}

// Upserts/clears the link row for a member.
async function writeMemberLink(db, memberId, kind, linkedId) {
  if (kind && linkedId) {
    await db.prepare(
      'INSERT INTO vaad_member_link (member_id, kind, linked_id) VALUES (?, ?, ?) ' +
      'ON CONFLICT(member_id) DO UPDATE SET kind = excluded.kind, linked_id = excluded.linked_id'
    ).bind(memberId, kind, linkedId).run();
  } else {
    await db.prepare('DELETE FROM vaad_member_link WHERE member_id = ?').bind(memberId).run();
  }
}

// Hydrates the GET response with linkedKind / linkedId from the link table.
async function loadMembers(db) {
  const rows = await db.prepare(
    `SELECT ${SAFE_FIELDS} FROM vaad_members ORDER BY display_order ASC, created_at ASC`
  ).all();
  const members = rows.results || [];
  if (!members.length) return members;
  const linkRows = await db.prepare(
    'SELECT member_id, kind, linked_id FROM vaad_member_link'
  ).all();
  const linkMap = new Map();
  for (const r of (linkRows.results || [])) {
    linkMap.set(r.member_id, { kind: r.kind, linkedId: r.linked_id });
  }
  for (const m of members) {
    const link = linkMap.get(m.id);
    m.linkedKind = link?.kind || null;
    m.linkedId = link?.linkedId || null;
  }
  return members;
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const members = await loadMembers(env.DB);
  return json({ members });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  // Required: linkedKind + linkedId. The picker enforces this on the client;
  // the server rejects requests without a valid pair.
  const linkedKind = pickStr(body.linkedKind, 16);
  const linkedId = pickStr(body.linkedId, 80);
  if (!['owner', 'apartment'].includes(linkedKind) || !linkedId) {
    return error('יש לבחור בעלים או דייר קיים', 400);
  }
  const snap = await resolveLinkedSnapshot(env.DB, linkedKind, linkedId);
  if (!snap) return error('המשתמש שנבחר לא נמצא', 404);
  const role = pickStr(body.role, 100);
  const notes = pickStr(body.notes, 1000);
  const displayOrder = pickInt(body.displayOrder) ?? 0;
  const name = (snap.name || '').trim() || 'חבר ועד';

  const id = uid('vm-');
  await env.DB.prepare(
    'INSERT INTO vaad_members (id, name, role, phone, email, notes, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, name, role || null, snap.phone || null, snap.email || null, notes || null, displayOrder).run();
  await writeMemberLink(env.DB, id, linkedKind, linkedId);
  await logAudit(env.DB, request, {
    event: 'vaad_member_created', role: 'admin', userLabel: r.sess.userLabel,
    meta: { name, role, linkedKind, linkedId }, success: true,
  });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM vaad_members WHERE id = ?`).bind(id).first();
  return json({ ...row, linkedKind, linkedId }, { status: 201 });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  // PUT can do two things:
  //   1. Re-pick the linked person — server re-snapshots name/phone/email.
  //   2. Update committee-only fields (role, displayOrder, notes) without
  //      changing the link.
  // The frontend always sends linkedKind + linkedId on edit (the picker is
  // pre-filled with the current link).
  const linkedKind = pickStr(body.linkedKind, 16);
  const linkedId = pickStr(body.linkedId, 80);
  if (!['owner', 'apartment'].includes(linkedKind) || !linkedId) {
    return error('יש לבחור בעלים או דייר קיים', 400);
  }
  const snap = await resolveLinkedSnapshot(env.DB, linkedKind, linkedId);
  if (!snap) return error('המשתמש שנבחר לא נמצא', 404);
  const role = pickStr(body.role, 100);
  const notes = pickStr(body.notes, 1000);
  const displayOrder = pickInt(body.displayOrder) ?? 0;
  const name = (snap.name || '').trim() || 'חבר ועד';

  await env.DB.prepare(
    `UPDATE vaad_members SET name = ?, role = ?, phone = ?, email = ?, notes = ?, display_order = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(name, role || null, snap.phone || null, snap.email || null, notes || null, displayOrder, id).run();
  await writeMemberLink(env.DB, id, linkedKind, linkedId);
  await logAudit(env.DB, request, { event: 'vaad_member_updated', role: 'admin', userLabel: r.sess.userLabel, success: true });
  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM vaad_members WHERE id = ?`).bind(id).first();
  return json({ ...row, linkedKind, linkedId });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM vaad_members WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'vaad_member_deleted', role: 'admin', userLabel: r.sess.userLabel, success: true });
  return json({ ok: true });
};
