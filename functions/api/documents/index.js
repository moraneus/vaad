// GET  /api/documents       — list metadata
// POST /api/documents       — upload to Google Drive

import { json, error, uid } from '../../lib/util.js';
import { requireRead, requireAdmin, requireSession } from '../../lib/guard.js';
import { logAudit } from '../../lib/audit.js';
import { getAccessToken, uploadFile, getDriveStatus } from '../../lib/drive.js';

// Tenants (and owner-tenants) may only upload documents in the context of
// a ticket they own that is still open. Returns the session row on success,
// or {error: Response} on failure.
async function authorizeUpload(env, request, targetType, targetId) {
  if (targetType === 'ticket' && targetId) {
    const r = await requireSession(env, request);
    if (r.error) return r;
    if (r.sess.role === 'admin') return r;
    const cur = await env.DB.prepare(
      'SELECT opened_by_kind AS k, opened_by_id AS oid, status FROM tickets WHERE id = ?'
    ).bind(targetId).first();
    if (!cur) return { error: error('פנייה לא נמצאה', 404) };
    if (cur.status !== 'open') return { error: error('הפנייה סגורה', 403) };
    const kind = r.sess.userKind === 'owner' ? 'owner'
              : (r.sess.userKind === 'tenant' ? 'apartment-tenant' : 'admin');
    const id = r.sess.ownerId || r.sess.apartmentId || null;
    if (cur.k !== kind || (cur.oid || null) !== id) {
      return { error: error('אין הרשאה לפנייה זו', 403) };
    }
    return r;
  }
  return requireAdmin(env, request);
}

const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
];

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  // Join document_meta to surface the admin-given display_name (falls back to
  // the original filename when no display name is set).
  const docs = await env.DB.prepare(
    `SELECT d.id, d.name, COALESCE(dm.display_name, d.name) AS displayName,
            d.mime_type AS mimeType, d.size, d.uploaded_at AS uploadedAt, d.uploaded_by AS uploadedBy
       FROM documents d
       LEFT JOIN document_meta dm ON dm.document_id = d.id
      ORDER BY d.uploaded_at DESC`
  ).all();
  const ids = docs.results.map(d => d.id);
  const placeholders = ids.map(() => '?').join(',');
  const links = ids.length ? (await env.DB.prepare(
    `SELECT document_id AS docId, target_type AS type, target_id AS targetId
     FROM document_links WHERE document_id IN (${placeholders})`
  ).bind(...ids).all()).results : [];
  // Infrastructure-expense links live in their own table — surface them under
  // the same `type` key the frontend already knows how to render.
  const infraLinks = ids.length ? (await env.DB.prepare(
    `SELECT document_id AS docId, expense_id AS targetId
     FROM infrastructure_expense_documents WHERE document_id IN (${placeholders})`
  ).bind(...ids).all()).results : [];
  // Per-payment expense docs — same pattern.
  const paymentLinks = ids.length ? (await env.DB.prepare(
    `SELECT document_id AS docId, payment_id AS targetId
     FROM expense_payment_documents WHERE document_id IN (${placeholders})`
  ).bind(...ids).all()).results : [];
  // Ticket attachments — same separate-table pattern.
  const ticketLinks = ids.length ? (await env.DB.prepare(
    `SELECT document_id AS docId, ticket_id AS targetId
     FROM ticket_documents WHERE document_id IN (${placeholders})`
  ).bind(...ids).all()).results : [];
  const linkMap = new Map();
  for (const l of links) {
    if (!linkMap.has(l.docId)) linkMap.set(l.docId, []);
    linkMap.get(l.docId).push({ type: l.type, targetId: l.targetId });
  }
  for (const l of infraLinks) {
    if (!linkMap.has(l.docId)) linkMap.set(l.docId, []);
    linkMap.get(l.docId).push({ type: 'infrastructure_expense', targetId: l.targetId });
  }
  for (const l of paymentLinks) {
    if (!linkMap.has(l.docId)) linkMap.set(l.docId, []);
    linkMap.get(l.docId).push({ type: 'expense_payment', targetId: l.targetId });
  }
  for (const l of ticketLinks) {
    if (!linkMap.has(l.docId)) linkMap.set(l.docId, []);
    linkMap.get(l.docId).push({ type: 'ticket', targetId: l.targetId });
  }
  for (const d of docs.results) d.links = linkMap.get(d.id) || [];
  return json({ documents: docs.results });
};

export const onRequestPost = async ({ request, env }) => {
  // Drive must be connected before we authenticate — saves a permission
  // check when the channel isn't usable anyway.
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

  // Permission depends on what the upload will attach to. Tickets allow
  // creator+open self-uploads; everything else stays admin-only.
  const targetType = form.get('targetType');
  const targetId = form.get('targetId');
  const r = await authorizeUpload(env, request, targetType, targetId);
  if (r.error) return r.error;

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

  // Optional admin-given display name. The form field is `displayName`; when
  // empty/absent we don't insert a meta row (the GET coalesce falls back to
  // documents.name).
  const displayName = (form.get('displayName') || '').toString().trim().slice(0, 200);
  if (displayName && displayName !== (file.name || '')) {
    await env.DB.prepare(
      'INSERT INTO document_meta (document_id, display_name, updated_at) VALUES (?, ?, datetime(\'now\'))'
    ).bind(id, displayName).run();
  }

  if (targetType && targetId) {
    if (['expense', 'payment'].includes(targetType)) {
      await env.DB.prepare('INSERT OR IGNORE INTO document_links (document_id, target_type, target_id) VALUES (?, ?, ?)')
        .bind(id, targetType, targetId).run();
    } else if (targetType === 'infrastructure_expense') {
      await env.DB.prepare('INSERT OR IGNORE INTO infrastructure_expense_documents (document_id, expense_id) VALUES (?, ?)')
        .bind(id, targetId).run();
    } else if (targetType === 'expense_payment') {
      await env.DB.prepare('INSERT OR IGNORE INTO expense_payment_documents (document_id, payment_id) VALUES (?, ?)')
        .bind(id, targetId).run();
    } else if (targetType === 'ticket') {
      await env.DB.prepare('INSERT OR IGNORE INTO ticket_documents (document_id, ticket_id) VALUES (?, ?)')
        .bind(id, targetId).run();
    }
  }

  await logAudit(env.DB, request, { event: 'document_uploaded', role: r.sess.role, userLabel: r.sess.userLabel, meta: { id, name: file.name, displayName: displayName || null, size: file.size, driveFileId, targetType, targetId }, success: true });
  return json({ id, name: file.name, displayName: displayName || file.name, size: file.size, mimeType: file.type }, { status: 201 });
};
