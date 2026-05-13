// GET /api/storage/status — admin view of which backends are usable and
// which one new uploads currently land in. Drives the Settings UI card.

import { json } from '../../lib/util.js';
import { requireRead } from '../../lib/guard.js';
import { storageStatus } from '../../lib/storage.js';

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  return json(await storageStatus(env.DB, env));
};
