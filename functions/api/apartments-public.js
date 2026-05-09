// GET /api/apartments-public — minimal public list for the renter login dropdown.
// Returns ONLY renter-occupied apartments — owner-occupied apartments don't have
// a separate tenant login (the owner accesses them via the Owner tab).
// No sensitive data exposed. Returns id, number, owner (the renter's name as
// shown to admin), hasPassword (renter credentials), hasOwnerPassword
// (legacy PR-B per-apt owner credentials, unused by new flow but kept).

import { json } from '../lib/util.js';

export const onRequestGet = async ({ env }) => {
  // hasOauth = there's SOME verified Google email for this apartment renter:
  // either the renter's opt-in email (apartment_email.email — separate table)
  // OR the recovery email registered via Settings → Identity verification
  // (apartment_recovery.email). Note: the apartments table itself has no
  // email column — email opt-in lives in apartment_email.
  const rows = await env.DB.prepare(
    `SELECT a.id, a.number, a.owner,
            CASE WHEN a.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword,
            CASE WHEN ao.password_hash IS NULL THEN 0 ELSE 1 END AS hasOwnerPassword,
            CASE WHEN (ae.email IS NULL OR ae.email = '')
                  AND (ar.email IS NULL OR ar.email = '')
                 THEN 0 ELSE 1 END AS hasOauth,
            COALESCE(occ.occupant_type, 'owner') AS occupantType
       FROM apartments a
       LEFT JOIN apartment_owner_auth ao ON ao.apartment_id = a.id
       LEFT JOIN apartment_occupancy occ ON occ.apartment_id = a.id
       LEFT JOIN apartment_email ae ON ae.apartment_id = a.id
       LEFT JOIN apartment_recovery ar ON ar.apartment_id = a.id
      WHERE COALESCE(occ.occupant_type, 'owner') = 'renter'
      ORDER BY CAST(a.number AS INTEGER), a.number`
  ).all();
  return json({ apartments: rows.results });
};
