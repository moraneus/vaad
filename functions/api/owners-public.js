// GET /api/owners-public — minimal public list for the owner login dropdown.
// Returns id + the apartment numbers each owner holds (so the owner can
// identify themselves without leaking their real name to the public). No
// sensitive fields exposed (no phone/email/notes/login_email/name).

import { json } from '../lib/util.js';

export const onRequestGet = async ({ env }) => {
  // GROUP_CONCAT surfaces all apartment numbers each owner holds, so the
  // owner can recognize themselves on the login screen via their apartments
  // instead of their personal name.
  const rows = await env.DB.prepare(
    `SELECT o.id,
            GROUP_CONCAT(a.number, ',') AS apartmentNumbers,
            CASE WHEN o.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword,
            CASE WHEN (o.login_email IS NULL OR o.login_email = '')
                  AND (orec.email IS NULL OR orec.email = '')
                 THEN 0 ELSE 1 END AS hasOauth
       FROM owners o
       LEFT JOIN owner_recovery orec ON orec.owner_id = o.id
       LEFT JOIN apartment_owner_link l ON l.owner_id = o.id
       LEFT JOIN apartments a ON a.id = l.apartment_id
      GROUP BY o.id
      ORDER BY o.created_at`
  ).all();
  const owners = (rows.results || []).map(r => ({
    id: r.id,
    hasPassword: !!r.hasPassword,
    hasOauth: !!r.hasOauth,
    apartmentNumbers: String(r.apartmentNumbers || '')
      .split(',')
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })),
  }));
  return json({ owners });
};
