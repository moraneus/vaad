// POST /api/settings/storage { provider: 'r2' | 'drive' }
// Admin-only: switch which backend NEW uploads use. Existing documents
// keep the backend they were uploaded with — the dispatcher reads per-row
// metadata.

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { logAudit } from '../../lib/audit.js';
import { r2Available } from '../../lib/r2.js';
import { d1Available } from '../../lib/d1-blob.js';
import { getDriveStatus } from '../../lib/drive.js';
import { storageStatus } from '../../lib/storage.js';

const VALID = new Set(['r2', 'drive', 'd1']);

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const provider = pickStr(body.provider, 16);
  if (!VALID.has(provider)) return error('provider לא תקף', 400);

  // Refuse to switch to a backend that isn't actually wired up — surfaces
  // the misconfiguration immediately instead of failing on the next upload.
  if (provider === 'r2' && !r2Available(env)) {
    return error('R2 לא מוגדר — חסר binding בשם DOCS_BUCKET ב-wrangler.toml', 412);
  }
  if (provider === 'd1' && !d1Available(env)) {
    // Shouldn't happen in practice — D1 is required to run the app — but
    // belt-and-braces in case the binding is missing for some reason.
    return error('D1 לא זמין', 412);
  }
  if (provider === 'drive') {
    const drv = await getDriveStatus(env.DB);
    if (!drv.connected) return error('Google Drive לא מחובר — חבר אותו תחילה', 412);
  }

  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('storage_provider', ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  ).bind(provider).run();
  await logAudit(env.DB, request, { event: 'storage_provider_changed', role: 'admin', userLabel: r.sess.userLabel, meta: { provider }, success: true });
  return json(await storageStatus(env.DB, env));
};
