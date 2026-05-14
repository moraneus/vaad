// Storage dispatcher — picks the right backend for each document.
//
// New uploads use the "active provider" set in Settings. Existing documents
// always stay on the backend they were uploaded with — the per-row
// document_storage table records which one. Documents with no row default
// to 'drive' so legacy data created before this dispatcher existed keeps
// working without any backfill.
//
// Three backends supported:
//   - 'd1'    : bytes stored as BLOB in D1. Default. No setup, no third
//               party, no credit card. Best for small files (<5 MB).
//   - 'r2'    : Cloudflare R2 object storage. 10 GB free, zero egress.
//               Requires the DOCS_BUCKET binding + R2 enabled on the
//               Cloudflare account (which needs a payment method on file
//               for fraud-prevention purposes).
//   - 'drive' : Google Drive via OAuth (drive.file scope). 15 GB free per
//               Google account, depends on that account staying alive.

import * as drive from './drive.js';
import { r2Available, r2Put, r2Get, r2Delete, r2Key } from './r2.js';
import { d1Available, d1Put, d1Get, d1Delete, d1SizeLimit } from './d1-blob.js';
import { b2Available, b2Put, b2Get, b2Delete, b2Key, b2Status } from './b2.js';

// Reads (and validates) the configured active provider. Falls back to
// whichever one is actually available so a misconfiguration doesn't break
// uploads — the UI still shows the configured choice so the admin knows.
// Fallback order: configured → d1 (always present) → r2 → b2 → drive.
export async function getActiveProvider(db, env) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'storage_provider'").first();
  const choice = (row?.value || 'd1');
  if (choice === 'r2' && r2Available(env)) return 'r2';
  if (choice === 'd1' && d1Available(env)) return 'd1';
  if (choice === 'b2' && (await b2Available(env))) return 'b2';
  if (choice === 'drive') {
    const drv = await drive.getDriveStatus(db);
    if (drv.connected) return 'drive';
  }
  // Configured backend isn't available — pick anything that works.
  if (d1Available(env)) return 'd1';
  if (r2Available(env)) return 'r2';
  if (await b2Available(env)) return 'b2';
  const drv = await drive.getDriveStatus(db);
  if (drv.connected) return 'drive';
  return 'none';
}

// What does Settings → Storage look like right now?
export async function storageStatus(db, env) {
  const cfg = await db.prepare("SELECT value FROM settings WHERE key = 'storage_provider'").first();
  const drv = await drive.getDriveStatus(db);
  const b2 = await b2Status(env);
  return {
    configuredProvider: cfg?.value || 'd1',
    activeProvider: await getActiveProvider(db, env),
    d1: { available: d1Available(env) },
    r2: { available: r2Available(env) },
    b2: { available: b2.configured, bucketName: b2.bucketName, endpoint: b2.endpoint },
    drive: { connected: !!drv.connected, accountEmail: drv.accountEmail || null, folderId: drv.folderId || null },
  };
}

// True if at least one provider is usable. Endpoints gate uploads with
// this so we surface a clean 412 instead of a 500 mid-upload.
export async function hasAnyStorage(db, env) {
  return (await getActiveProvider(db, env)) !== 'none';
}

// Upload a file using the active provider. Returns the bookkeeping fields
// the documents endpoint persists alongside the row.
//
//   { storage: 'r2',    driveFileId: '',     r2Key: 'docs/2026-05/...' }
//   { storage: 'drive', driveFileId: '...',  r2Key: null }
//   { storage: 'd1',    driveFileId: '',     r2Key: null }
//
// `docId` is needed only for R2/D1 (it's the key/PK respectively).
export async function uploadDoc(db, env, docId, file) {
  const provider = await getActiveProvider(db, env);
  if (provider === 'r2') {
    const key = r2Key(docId, file.name);
    await r2Put(env, key, file, file.type);
    return { storage: 'r2', driveFileId: '', r2Key: key };
  }
  if (provider === 'd1') {
    const cap = d1SizeLimit(env);
    if (file.size > cap) {
      throw new Error(`קובץ גדול מהמותר לאחסון D1 (${Math.round(cap / 1024 / 1024)}MB). השתמש ב-R2 או Drive לקבצים גדולים יותר.`);
    }
    // D1 needs the bytes materialized — read the File body once. For very
    // large files this is the same RAM cost a Worker would pay anyway.
    const bytes = await file.arrayBuffer();
    await d1Put(db, docId, bytes);
    return { storage: 'd1', driveFileId: '', r2Key: null };
  }
  if (provider === 'b2') {
    const key = b2Key(docId, file.name);
    // b2Put returns "fileId|fileName" — we stash that in r2_key (used
    // generically as the "object reference" column) so b2Delete can
    // recover both pieces.
    const marker = await b2Put(env, key, file, file.type);
    return { storage: 'b2', driveFileId: '', r2Key: marker };
  }
  if (provider === 'drive') {
    const { accessToken, folderId } = await drive.getAccessToken(db, env);
    const fileId = await drive.uploadFile(accessToken, folderId, {
      name: file.name || 'file',
      mimeType: file.type,
      body: file,
    });
    return { storage: 'drive', driveFileId: fileId, r2Key: null };
  }
  throw new Error('שום ספק אחסון אינו זמין');
}

// Look up a document's storage details. Used by download + delete.
export async function resolveDocStorage(db, docId) {
  const row = await db.prepare(
    `SELECT d.id, d.name, d.mime_type AS mimeType, d.drive_file_id AS driveFileId,
            COALESCE(ds.provider, 'drive') AS storage,
            ds.r2_key AS r2Key
       FROM documents d
       LEFT JOIN document_storage ds ON ds.document_id = d.id
      WHERE d.id = ?`
  ).bind(docId).first();
  return row || null;
}

// Stream a document. Returns { body, contentType, contentLength } — the
// caller wraps this in a Response with whatever headers it wants.
export async function downloadDoc(db, env, docId) {
  const meta = await resolveDocStorage(db, docId);
  if (!meta) throw new Error('not found');
  if (meta.storage === 'r2') {
    const obj = await r2Get(env, meta.r2Key);
    return {
      body: obj.body,
      contentType: obj.httpMetadata?.contentType || meta.mimeType,
      contentLength: obj.size,
      meta,
    };
  }
  if (meta.storage === 'd1') {
    const bytes = await d1Get(db, docId);
    return {
      body: bytes,
      contentType: meta.mimeType,
      contentLength: bytes?.byteLength || null,
      meta,
    };
  }
  if (meta.storage === 'b2') {
    const res = await b2Get(env, meta.r2Key);
    return {
      body: res.body,
      contentType: res.headers.get('content-type') || meta.mimeType,
      contentLength: res.headers.get('content-length'),
      meta,
    };
  }
  const { accessToken } = await drive.getAccessToken(db, env);
  const res = await drive.downloadFile(accessToken, meta.driveFileId);
  return {
    body: res.body,
    contentType: res.headers.get('content-type') || meta.mimeType,
    contentLength: res.headers.get('content-length'),
    meta,
  };
}

// Best-effort delete from the per-row backend. We never throw on a missing
// upstream object — the DB row is the source of truth for whether the
// document still exists in the app's eyes.
export async function deleteDocBlob(db, env, docId) {
  const meta = await resolveDocStorage(db, docId);
  if (!meta) return;
  try {
    if (meta.storage === 'r2') {
      await r2Delete(env, meta.r2Key);
    } else if (meta.storage === 'd1') {
      await d1Delete(db, docId);
    } else if (meta.storage === 'b2') {
      await b2Delete(env, meta.r2Key);
    } else {
      const { accessToken } = await drive.getAccessToken(db, env);
      await drive.deleteFile(accessToken, meta.driveFileId);
    }
  } catch { /* swallow — caller will delete the row regardless */ }
}

// Persist the per-row storage metadata. Called from the documents POST
// after the row exists.
export async function recordDocStorage(db, docId, info) {
  // Drive is implicit — no row needed. Only insert when the upload landed
  // on a non-Drive backend.
  if (info.storage === 'drive') return;
  await db.prepare(
    'INSERT INTO document_storage (document_id, provider, r2_key) VALUES (?, ?, ?) ' +
    'ON CONFLICT(document_id) DO UPDATE SET provider = excluded.provider, r2_key = excluded.r2_key'
  ).bind(docId, info.storage, info.r2Key || null).run();
}
