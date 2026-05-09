// GET    /api/documents/:id   — proxy stream from Google Drive
// PATCH  /api/documents/:id   — admin only; rename (sets display_name)
// DELETE /api/documents/:id   — admin only; deletes from Drive then DB

import { json, error, readJSON } from '../../lib/util.js';
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

export const onRequestPatch = async ({ request, env, params }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = params.id;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const doc = await env.DB.prepare('SELECT id FROM documents WHERE id = ?').bind(id).first();
  if (!doc) return error('המסמך לא נמצא', 404);

  const displayName = String(body?.displayName || '').trim().slice(0, 200);
  if (!displayName) {
    // Empty / cleared → drop the meta row so the GET coalesce falls back to filename.
    await env.DB.prepare('DELETE FROM document_meta WHERE document_id = ?').bind(id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO document_meta (document_id, display_name, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(document_id) DO UPDATE SET
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`
    ).bind(id, displayName).run();
  }
  await logAudit(env.DB, request, { event: 'document_renamed', role: 'admin', userLabel: r.sess.userLabel, meta: { id, displayName: displayName || null }, success: true });
  return json({ ok: true, displayName: displayName || null });
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
