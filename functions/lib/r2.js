// Cloudflare R2 backend for document storage.
//
// R2 is the default storage provider — free for the first 10 GB (way more
// than a vaad ever uses), with zero egress fees. Pages Functions get a
// direct binding (env.DOCS_BUCKET) so there's no auth dance, no tokens
// to refresh, no external account to keep healthy.
//
// Set up by adding this to wrangler.toml:
//
//   [[r2_buckets]]
//   binding = "DOCS_BUCKET"
//   bucket_name = "vaad-docs"
//
// `wrangler r2 bucket create vaad-docs` once, then deploy.

// True when an R2 bucket is bound to this deployment.
export function r2Available(env) {
  return !!env?.DOCS_BUCKET;
}

// Builds a tidy key like `docs/2026-05/d-abc123-original.pdf`. The
// year-month prefix is purely cosmetic; R2 doesn't need a hierarchy but
// it makes the bucket browser readable. Filename is appended for the same
// reason — operators can grep keys by name when investigating.
export function r2Key(docId, originalName) {
  const d = new Date();
  const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Strip path separators so we never accidentally create deeper folders.
  const safe = (originalName || 'file').replace(/[\\/]/g, '_').slice(0, 80);
  return `docs/${yearMonth}/${docId}-${safe}`;
}

// Upload a file. `body` may be a Blob, ArrayBuffer, Uint8Array, or
// ReadableStream — R2 accepts all of them.
export async function r2Put(env, key, body, mimeType) {
  await env.DOCS_BUCKET.put(key, body, {
    httpMetadata: { contentType: mimeType || 'application/octet-stream' },
  });
}

// Fetch a file. Returns the R2 object whose `.body` is a ReadableStream
// that the caller can pass straight into a Response.
export async function r2Get(env, key) {
  const obj = await env.DOCS_BUCKET.get(key);
  if (!obj) throw new Error('R2 object not found');
  return obj;
}

// Best-effort delete. R2 returns 200 for both "deleted" and "wasn't there"
// — we don't need to distinguish.
export async function r2Delete(env, key) {
  await env.DOCS_BUCKET.delete(key);
}
