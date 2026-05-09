// GET /api/owners-public — minimal public list for the owner login dropdown.
// Same shape concept as /api/apartments-public: id, name, hasPassword.
// No sensitive fields exposed (no phone/email/notes/login_email).

import { json } from '../lib/util.js';

export const onRequestGet = async ({ env }) => {
  // hasOauth = either owners.login_email OR owner_recovery.email is set.
  const rows = await env.DB.prepare(
    `SELECT o.id, o.name,
            CASE WHEN o.password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword,
            CASE WHEN (o.login_email IS NULL OR o.login_email = '')
                  AND (orec.email IS NULL OR orec.email = '')
                 THEN 0 ELSE 1 END AS hasOauth
       FROM owners o
       LEFT JOIN owner_recovery orec ON orec.owner_id = o.id
      ORDER BY o.name`
  ).all();
  return json({ owners: rows.results || [] });
};
