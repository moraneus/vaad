// GET  /api/documents       — list metadata
// POST /api/documents       — upload to Google Drive

import { json, error, uid } from '../../lib/util.js';
import { requireRead, requireAdmin } from '../../lib/guard.js';
import { logAudit } from '../../lib/audit.js';
import { getAccessToken, uploadFile, getDriveStatus } from '../../lib/drive.js';

const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
];

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const docs = await env.DB.prepare(
    'SELECT id, name, mime_type AS mimeType, size, uploaded_at AS uploadedAt, uploaded_by AS uploadedBy FROM documents ORDER BY uploaded_at DESC'
  ).all();
  const ids = docs.results.map(d => d.id);
  const links = ids.length ? (await env.DB.prepare(
    `SELECT document_id AS docId, target_type AS type, target_id AS targetId
     FROM document_links WHERE document_id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all()).results : [];
  const linkMap = new Map();
  for (const l of links) {
    if (!linkMap.has(l.docId)) linkMap.set(l.docId, []);
    linkMap.get(l.docId).push({ type: l.type, targetId: l.targetId });
  }
  for (const d of docs.results) d.links = linkMap.get(d.id) || [];
  return json({ documents: docs.results });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;

  // Drive must be connected
  const status = await getDriveStatus(env.DB);
  if (!status.connected) return error('יש לחבר את Google Drive בהגדרות לפני העלאת מסמכים', 412);

  const ct = request.headers.get('content-type') || '';
  if (!ct.startsWith('multipart/form-data')) return error('יש לשלוח multipart/form-data', 400);
  const maxBytes = Number(env.MAX_DOC_SIZE_MB || 20) * 1024 * 1024;
  const cl = Number(request.headers.get('content-length') || 0);
  if (cl > maxBytes) return error(`קובץ גדול מהמותר (${env.MAX_DOC_SIZE_MB || 20}MB)`, 413);

  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return error('קובץ חסר', 400);
  if (file.size > maxBytes) return error('קובץ גדול מהמותר', 413);
  if (!ALLOWED_MIME.includes(file.type)) return error('סוג קובץ לא מורשה (תמונות או PDF בלבד)', 415);

  const id = uid('doc-');

  let driveFileId;
  try {
    const { accessToken, folderId } = await getAccessToken(env.DB, env);
    driveFileId = await uploadFile(accessToken, folderId, {
      name: file.name || 'file',
      mimeType: file.type,
      body: file,
    });
  } catch (e) {
    return error(`Google Drive upload failed: ${e.message}`, 502);
  }

  await env.DB.prepare(
    'INSERT INTO documents (id, name, mime_type, size, drive_file_id, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, file.name || 'file', file.type, file.size, driveFileId, r.sess.userLabel || null).run();

  const targetType = form.get('targetType');
  const targetId = form.get('targetId');
  if (targetType && targetId && ['expense', 'payment'].includes(targetType)) {
    await env.DB.prepare('INSERT OR IGNORE INTO document_links (document_id, target_type, target_id) VALUES (?, ?, ?)')
      .bind(id, targetType, targetId).run();
  }

  await logAudit(env.DB, request, { event: 'document_uploaded', role: 'admin', userLabel: r.sess.userLabel, meta: { id, name: file.name, size: file.size, driveFileId }, success: true });
  return json({ id, name: file.name, size: file.size, mimeType: file.type }, { status: 201 });
};
