// Backblaze B2 backend for document storage.
//
// Uses B2's native API (rather than the S3-compatible endpoint) because:
//   - Auth is simple HTTP Basic at the start — no SigV4 implementation
//     required in the Worker runtime.
//   - The /b2_get_upload_url + per-upload token model fits Workers cleanly.
//
// Storage shape:
//   - The application key + key ID are stored encrypted in `settings`
//     (b2_key_id_enc / b2_application_key_enc). Decrypted on each request
//     using the SESSION_SECRET-derived AES-GCM key — same pattern as Drive
//     and Resend.
//   - bucket_name + endpoint are plain (no secret value).
//   - Per-document metadata: r2_key holds "fileId|fileName" so we can
//     delete (B2 delete requires both pieces). No new column needed.

import { decryptString } from './crypto.js';

const ensureSecret = (env) => env.SESSION_SECRET || 'dev-only-secret-change-me-in-production-please-1234567890';

// Load + decrypt the B2 credentials. Returns null when nothing is stored
// or when the ciphertext can't be decrypted (e.g., SESSION_SECRET rotated).
async function loadConfig(env) {
  if (!env?.DB) return null;
  const rows = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('b2_key_id_enc', 'b2_key_id_iv', 'b2_application_key_enc', 'b2_application_key_iv', 'b2_bucket_name', 'b2_endpoint')"
  ).all();
  const m = {};
  for (const r of (rows.results || [])) m[r.key] = r.value || '';
  if (!m.b2_key_id_enc || !m.b2_application_key_enc || !m.b2_bucket_name) return null;
  try {
    const keyId = await decryptString(m.b2_key_id_enc, m.b2_key_id_iv, ensureSecret(env));
    const applicationKey = await decryptString(m.b2_application_key_enc, m.b2_application_key_iv, ensureSecret(env));
    return {
      keyId,
      applicationKey,
      bucketName: m.b2_bucket_name,
      endpoint: m.b2_endpoint || '',
    };
  } catch {
    return null;
  }
}

// True when an admin has stashed B2 credentials in settings.
export async function b2Available(env) {
  return !!(await loadConfig(env));
}

// Surface a small status object for the Settings UI — doesn't leak the key,
// just whether one is present + the bucket/endpoint the admin can verify.
export async function b2Status(env) {
  const cfg = await loadConfig(env);
  if (!cfg) return { configured: false, bucketName: '', endpoint: '' };
  return { configured: true, bucketName: cfg.bucketName, endpoint: cfg.endpoint };
}

// Authorize against B2 and return the per-request auth payload. Each call
// hits b2_authorize_account; the auth token is good for ~24h but we don't
// bother caching — the request cost is negligible and avoiding cache
// invalidation across Worker instances is much simpler.
async function authorize(cfg) {
  const credentials = btoa(`${cfg.keyId}:${cfg.applicationKey}`);
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    method: 'GET',
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) throw new Error(`B2 auth failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  // v3 response nests urls + (for bucket-restricted keys) the bucket
  // identity under apiInfo.storageApi. Surface those so callers can skip
  // b2_list_buckets when the key is already scoped to a bucket — that
  // path is the common one (Backblaze's UI restricts to a bucket by
  // default when you create an Application Key).
  const api = data.apiInfo?.storageApi || data;
  return {
    accountId: data.accountId,
    authorizationToken: data.authorizationToken,
    apiUrl: api.apiUrl,
    downloadUrl: api.downloadUrl,
    s3ApiUrl: api.s3ApiUrl,
    bucketId: api.bucketId || null,
    bucketName: api.bucketName || null,
  };
}

async function resolveBucketId(auth, bucketName) {
  // Fast path: the key is restricted to a specific bucket. The auth
  // response already carries the bucketId — list_buckets would also
  // return only that bucket, but skipping the round trip avoids the
  // "not found" gotcha when the user types a different name than the
  // key is bound to (we surface a clear error instead of a generic 404).
  if (auth.bucketId) {
    if (auth.bucketName && bucketName && auth.bucketName !== bucketName) {
      throw new Error(`המפתח מוגבל ל-bucket "${auth.bucketName}" — שמת "${bucketName}"`);
    }
    return auth.bucketId;
  }
  // Account-wide key: list buckets to find the one with the matching name.
  const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: auth.accountId, bucketName }),
  });
  if (!res.ok) throw new Error(`B2 list buckets failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const bucket = (data.buckets || []).find(b => b.bucketName === bucketName);
  if (!bucket) {
    throw new Error(`B2 bucket "${bucketName}" not found for this key (key may be account-wide but the bucket doesn't exist, or you typed the wrong name)`);
  }
  return bucket.bucketId;
}

async function sha1Hex(bytes) {
  const hash = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Build a tidy object key. Same shape as r2Key — year-month prefix so the
// bucket browser stays readable, original filename appended for grep-ability.
export function b2Key(docId, originalName) {
  const d = new Date();
  const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const safe = (originalName || 'file').replace(/[\\/]/g, '_').slice(0, 80);
  return `docs/${yearMonth}/${docId}-${safe}`;
}

// Upload a file. Returns the storage marker string "fileId|fileName" which
// downstream code writes into document_storage.r2_key (column reused as
// a generic "object reference" — see file header).
export async function b2Put(env, key, body, mimeType) {
  const cfg = await loadConfig(env);
  if (!cfg) throw new Error('B2 not configured');
  const auth = await authorize(cfg);
  const bucketId = await resolveBucketId(auth, cfg.bucketName);

  // Reusable upload URL — B2's upload flow requires a fresh token per upload
  // (good for one file). For many files we'd reuse but we do one-at-a-time.
  const upRes = await fetch(`${auth.apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId }),
  });
  if (!upRes.ok) throw new Error(`B2 get_upload_url failed: ${upRes.status} ${(await upRes.text()).slice(0, 200)}`);
  const up = await upRes.json();

  // Materialize the bytes — needed for SHA1 + Content-Length.
  const bytes = body instanceof Uint8Array
    ? body
    : body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : new Uint8Array(await body.arrayBuffer());
  const sha1 = await sha1Hex(bytes);

  const res = await fetch(up.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: up.authorizationToken,
      // B2 wants the file name percent-encoded in this header.
      'X-Bz-File-Name': encodeURIComponent(key),
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'X-Bz-Content-Sha1': sha1,
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`B2 upload failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  // Encode "fileId|fileName" so b2Delete can recover both pieces later.
  return `${data.fileId}|${key}`;
}

// Stream a file's bytes back. The /file/<bucket>/<name> endpoint accepts
// the global authorizationToken from b2_authorize_account — no separate
// per-download token needed for private buckets.
export async function b2Get(env, marker) {
  const cfg = await loadConfig(env);
  if (!cfg) throw new Error('B2 not configured');
  const auth = await authorize(cfg);
  const key = parseMarker(marker).fileName;
  const url = `${auth.downloadUrl}/file/${encodeURIComponent(cfg.bucketName)}/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: auth.authorizationToken } });
  if (!res.ok) throw new Error(`B2 download failed: ${res.status}`);
  return res;
}

// Best-effort delete. B2 distinguishes "hide" vs "delete file version" —
// we issue the version delete so the bytes go away (relevant when the
// bucket is in lifecycle-keep-all mode). 404 is fine.
export async function b2Delete(env, marker) {
  const cfg = await loadConfig(env);
  if (!cfg) return;
  const { fileId, fileName } = parseMarker(marker);
  if (!fileId || !fileName) return;
  const auth = await authorize(cfg);
  const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_delete_file_version`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, fileName }),
  });
  if (!res.ok && res.status !== 404) {
    const text = (await res.text()).slice(0, 200);
    // B2 returns 400 with "not_found" code for missing files — same intent
    // as 404, treat it the same.
    if (!text.includes('not_found')) throw new Error(`B2 delete failed: ${res.status} ${text}`);
  }
}

function parseMarker(marker) {
  if (!marker) return { fileId: '', fileName: '' };
  const i = marker.indexOf('|');
  if (i < 0) return { fileId: '', fileName: marker };
  return { fileId: marker.slice(0, i), fileName: marker.slice(i + 1) };
}

// Used by the settings page to verify newly-entered credentials by doing a
// real round trip (auth + list buckets). Returns true on success, throws
// otherwise so the caller can surface the underlying B2 error message.
export async function b2VerifyConfig({ keyId, applicationKey, bucketName }) {
  const auth = await authorize({ keyId, applicationKey });
  await resolveBucketId(auth, bucketName);
  return true;
}
