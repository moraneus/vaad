// GET /api/auth/identity-status
//
// Returns recovery info for the CURRENT logged-in user:
//   - master admin (role='admin' AND no apartmentId) → admin_recovery
//   - apartment renter (apartmentId set, userKind='tenant') → apartment_recovery
//   - apartment owner  (apartmentId set, userKind='owner')  → apartment_owner_recovery
//
// Shape: { registered, email, verifiedAt, scope, apartmentId?, userKind? }

import { json, error } from '../../lib/util.js';
import { loadSession } from '../../lib/session.js';

export const onRequestGet = async ({ request, env }) => {
  const db = env.DB;
  const sess = await loadSession(db, request, env);
  if (!sess) return error('יש להתחבר תחילה', 401);

  if (sess.ownerId) {
    const row = await db.prepare(
      'SELECT email, verified_at AS verifiedAt FROM owner_recovery WHERE owner_id = ?'
    ).bind(sess.ownerId).first();
    return json({
      registered: !!row?.email,
      email: row?.email || null,
      verifiedAt: row?.verifiedAt || null,
      scope: 'owner',
      ownerId: sess.ownerId,
    });
  }

  if (sess.apartmentId) {
    const userKind = sess.userKind === 'owner' ? 'owner' : 'tenant';
    const tableName = userKind === 'owner' ? 'apartment_owner_recovery' : 'apartment_recovery';
    const row = await db.prepare(
      `SELECT email, verified_at AS verifiedAt FROM ${tableName} WHERE apartment_id = ?`
    ).bind(sess.apartmentId).first();
    return json({
      registered: !!row?.email,
      email: row?.email || null,
      verifiedAt: row?.verifiedAt || null,
      scope: 'apartment',
      apartmentId: sess.apartmentId,
      userKind,
    });
  }

  if (sess.role === 'admin') {
    const row = await db.prepare(
      'SELECT email, verified_at AS verifiedAt FROM admin_recovery WHERE id = 1'
    ).first();
    return json({
      registered: !!row?.email,
      email: row?.email || null,
      verifiedAt: row?.verifiedAt || null,
      scope: 'master',
    });
  }

  return error('אין הרשאה', 403);
};
