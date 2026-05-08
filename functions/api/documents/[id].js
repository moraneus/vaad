// GET    /api/documents/:id   — proxy stream from Google Drive
// DELETE /api/documents/:id   — admin only; deletes from Drive then DB

import { json, error } from '../../lib/util.js';
import { requireRead, requireAdmin } from '../../lib/guard.js';
import { logAudit } from '../../lib/audit.js';
import { getAccessToken, downloadFile, deleteFile } from '../../lib/drive.js';

export const onRequestGet = async ({ request, env, params }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const id = params.id;
  const doc = await env.DB.prepare('SELECT id, name, mime_type AS mimeType, drive_file_id AS driveFileId FROM documents WHERE id = ?').bind(id).first();
  if (!doc) return error('המסמך לא נמצא', 404);

  let driveRes;
  try {
    const { accessToken } = await getAccessToken(env.DB, env);
    driveRes = await downloadFile(accessToken, doc.driveFileId);
  } catch (e) {
    return error(`קובץ אינו זמין ב-Drive: ${e.message}`, 502);
  }

  const headers = new Headers();
  headers.set('content-type', doc.mimeType || 'application/octet-stream');
  headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.name || 'file')}`);
  headers.set('cache-control', 'private, max-age=300');
  // Pass through content-length if Drive provided one
  const cl = driveRes.headers.get('content-length');
  if (cl) headers.set('content-length', cl);
  return new Response(driveRes.body, { headers });
};

export const onRequestDelete = async ({ request, env, params }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = params.id;
  const doc = await env.DB.prepare('SELECT drive_file_id AS driveFileId FROM documents WHERE id = ?').bind(id).first();
  if (!doc) return error('המסמך לא נמצא', 404);

  // Try to delete from Drive — best effort, even if it fails we still remove the DB row
  try {
    const { accessToken } = await getAccessToken(env.DB, env);
    await deleteFile(accessToken, doc.driveFileId);
  } catch (e) {
    // Log but proceed
    await logAudit(env.DB, request, { event: 'document_drive_delete_failed', role: 'admin', userLabel: r.sess.userLabel, meta: { id, error: e.message }, success: false });
  }

  await env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'document_deleted', role: 'admin', userLabel: r.sess.userLabel, meta: { id }, success: true });
  return json({ ok: true });
};
