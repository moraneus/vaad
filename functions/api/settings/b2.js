// Admin-only endpoint to manage Backblaze B2 credentials.
//
// Mirrors the Resend endpoint pattern: keys are stored encrypted (AES-GCM
// with the SESSION_SECRET-derived key) so they're never readable outside
// this server. The activation flow does a real round trip to B2 — auth
// + list-buckets — so a bad key or wrong bucket name surfaces immediately.
//
// Actions:
//   - 'save'   { keyId, applicationKey, bucketName, endpoint }
//                store encrypted, then verify against B2
//   - 'remove' { }    wipe credentials

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { logAudit } from '../../lib/audit.js';
import { encryptString } from '../../lib/crypto.js';
import { b2VerifyConfig, b2Status } from '../../lib/b2.js';

async function writeSetting(db, key, value) {
  await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
    .bind(key, value).run();
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  return json(await b2Status(env));
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const action = pickStr(body.action, 30);
  const db = env.DB;

  if (action === 'save') {
    const keyId = pickStr(body.keyId, 200).trim();
    const applicationKey = pickStr(body.applicationKey, 200).trim();
    const bucketName = pickStr(body.bucketName, 100).trim();
    const endpoint = pickStr(body.endpoint, 200).trim();
    if (!keyId || !applicationKey || !bucketName) {
      return error('שדות חסרים: keyId, applicationKey, bucketName', 400);
    }

    // Round-trip the credentials against B2 BEFORE we persist anything,
    // so the admin sees a clear error (bad key / wrong bucket / missing
    // bucket permission) instead of silently storing a broken config.
    try {
      await b2VerifyConfig({ keyId, applicationKey, bucketName });
    } catch (err) {
      return error(`אימות מול Backblaze נכשל: ${err.message || err}`, 400);
    }

    const secret = env.SESSION_SECRET || 'dev-only-secret-change-me-in-production-please-1234567890';
    const encId = await encryptString(keyId, secret);
    const encKey = await encryptString(applicationKey, secret);
    await writeSetting(db, 'b2_key_id_enc', encId.ciphertext);
    await writeSetting(db, 'b2_key_id_iv', encId.iv);
    await writeSetting(db, 'b2_application_key_enc', encKey.ciphertext);
    await writeSetting(db, 'b2_application_key_iv', encKey.iv);
    await writeSetting(db, 'b2_bucket_name', bucketName);
    await writeSetting(db, 'b2_endpoint', endpoint);

    await logAudit(db, request, { event: 'b2_configured', role: 'admin', userLabel: r.sess.userLabel, meta: { bucketName }, success: true });
    return json({ ok: true, ...(await b2Status(env)) });
  }

  if (action === 'remove') {
    await writeSetting(db, 'b2_key_id_enc', '');
    await writeSetting(db, 'b2_key_id_iv', '');
    await writeSetting(db, 'b2_application_key_enc', '');
    await writeSetting(db, 'b2_application_key_iv', '');
    await writeSetting(db, 'b2_bucket_name', '');
    await writeSetting(db, 'b2_endpoint', '');
    await logAudit(db, request, { event: 'b2_removed', role: 'admin', userLabel: r.sess.userLabel, success: true });
    return json({ ok: true, ...(await b2Status(env)) });
  }

  return error('פעולה לא תקפה', 400);
};
