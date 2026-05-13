// D1 BLOB backend for document storage.
//
// Stores document bytes directly in the D1 database alongside the rest of
// the application data. The "lowest-friction" option:
//   - no R2 bucket, no credit-card-on-file
//   - no Google account, no OAuth dance
//   - works the moment D1 is provisioned (which it always is for this app)
//
// Practical per-document size cap of ~5 MB. The D1 binding loads the full
// row into memory on read, so very large files are inefficient — fine for
// ticket photos and receipt PDFs, less suited for big scans. Larger files
// should use R2 or Drive instead.

// D1 is always bound (the app can't run without it), but we still take the
// env so the call site reads the same as r2Available / driveStatus.
export function d1Available(env) {
  return !!env?.DB;
}

// Cap kept conservative — D1 row-size limits aren't formally documented,
// but ~1 MB used to be tight. Photos compressed by phones (1280px JPEG)
// land at ~200-500 KB so 5 MB gives plenty of headroom. Tunable via
// MAX_D1_DOC_SIZE_MB if you need to push it.
export function d1SizeLimit(env) {
  return Number(env?.MAX_D1_DOC_SIZE_MB || 5) * 1024 * 1024;
}

// Upsert the blob. `bytes` must be an ArrayBuffer or Uint8Array — D1's
// bind() accepts both and stores as a BLOB.
export async function d1Put(db, docId, bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  await db.prepare(
    "INSERT INTO document_d1_blobs (document_id, bytes, stored_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(document_id) DO UPDATE SET bytes = excluded.bytes, stored_at = datetime('now')"
  ).bind(docId, buf).run();
}

// Read the blob. Returns the raw ArrayBuffer; the caller wraps it in a
// Response.
export async function d1Get(db, docId) {
  const row = await db.prepare(
    'SELECT bytes FROM document_d1_blobs WHERE document_id = ?'
  ).bind(docId).first();
  if (!row) throw new Error('D1 blob not found');
  // D1 returns BLOBs as ArrayBuffer.
  return row.bytes;
}

export async function d1Delete(db, docId) {
  await db.prepare('DELETE FROM document_d1_blobs WHERE document_id = ?').bind(docId).run();
}
