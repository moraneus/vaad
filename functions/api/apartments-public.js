// GET /api/apartments-public — public list for the apartment login dropdown.
// Returns EVERY apartment (renter-occupied AND owner-occupied) so the admin
// model "all logins live under one tab" works on the client. Each row carries
// the flags the login UI needs to render the right role toggle and password
// prompt:
//   - hasPassword          → renter (apartments.password_hash) is set
//   - hasOwnerAccountPwd   → first-class owner (owners.password_hash) is set
//   - ownerId              → linked first-class owner; the client uses this
//                            to call mode='owner' on submit
//   - hasOauth             → some Google email is registered for this apt
//                            (renter-side opt-in or recovery)
//   - hasOwnerOauth        → ditto for the linked owner (login_email or recovery)
//   - occupantType         → 'owner' or 'renter' (drives default role)
// Identifies apartments by number only — never leaks the resident's name in
// this public response.

import { json } from '../lib/util.js';

export const onRequestGet = async ({ env }) => {
  const rows = await env.DB.prepare(
    `SELECT a.id, a.number,
            CASE WHEN a.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword,
            CASE WHEN ao.password_hash IS NULL THEN 0 ELSE 1 END AS hasOwnerPassword,
            CASE WHEN (ae.email IS NULL OR ae.email = '')
                  AND (ar.email IS NULL OR ar.email = '')
                 THEN 0 ELSE 1 END AS hasOauth,
            COALESCE(occ.occupant_type, 'owner') AS occupantType,
            l.owner_id AS ownerId,
            CASE WHEN o.password_hash IS NULL THEN 0 ELSE 1 END AS hasOwnerAccountPwd,
            CASE WHEN (o.login_email IS NULL OR o.login_email = '')
                  AND (orec.email IS NULL OR orec.email = '')
                 THEN 0 ELSE 1 END AS hasOwnerOauth
       FROM apartments a
       LEFT JOIN apartment_owner_auth ao ON ao.apartment_id = a.id
       LEFT JOIN apartment_occupancy occ ON occ.apartment_id = a.id
       LEFT JOIN apartment_email ae ON ae.apartment_id = a.id
       LEFT JOIN apartment_recovery ar ON ar.apartment_id = a.id
       LEFT JOIN apartment_owner_link l ON l.apartment_id = a.id
       LEFT JOIN owners o ON o.id = l.owner_id
       LEFT JOIN owner_recovery orec ON orec.owner_id = o.id
      ORDER BY CAST(a.number AS INTEGER), a.number`
  ).all();
  return json({ apartments: rows.results });
};
