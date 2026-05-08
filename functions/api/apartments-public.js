// GET /api/apartments-public — minimal public list for the login dropdown.
// No sensitive data exposed. Returns only id, number, owner, hasPassword.

import { json } from '../lib/util.js';

export const onRequestGet = async ({ env }) => {
  const rows = await env.DB.prepare(
    `SELECT id, number, owner,
            CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword
     FROM apartments
     ORDER BY CAST(number AS INTEGER), number`
  ).all();
  return json({ apartments: rows.results });
};
