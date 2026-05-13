// GET    /api/documents/:id   — proxy stream from the per-row backend (R2 or Drive)
// PATCH  /api/documents/:id   — admin only; rename (sets display_name)
// DELETE /api/documents/:id   — admin only; deletes from the per-row backend then DB

import { json, error, readJSON } from '../../lib/util.js';
import { requireRead, requireAdmin } from '../../lib/guard.js';
import { logAudit } from '../../lib/audit.js';
import { downloadDoc, deleteDocBlob, resolveDocStorage } from '../../lib/storage.js';

export const onRequestGet = async ({ request, env, params }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const id = params.id;
  const meta = await resolveDocStorage(env.DB, id);
  if (!meta) return error('המסמך לא נמצא', 404);

  let res;
  try {
    res = await downloadDoc(env.DB, env, id);
  } catch (e) {
    return error(`קובץ אינו זמין: ${e.message}`, 502);
  }

  const headers = new Headers();
  headers.set('content-type', res.contentType || 'application/octet-stream');
  headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name || 'file')}`);
  headers.set('cache-control', 'private, max-age=300');
  if (res.contentLength) headers.set('content-length', String(res.contentLength));
  return new Response(res.body, { headers });
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
  const meta = await resolveDocStorage(env.DB, id);
  if (!meta) return error('המסמך לא נמצא', 404);

  // Best-effort blob delete on whichever backend owns the file. The DB row
  // gets removed regardless — a lingering R2 object or Drive file is far
  // less bad than a dangling DB reference (which would 404 forever).
  await deleteDocBlob(env.DB, env, id);

  await env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'document_deleted', role: 'admin', userLabel: r.sess.userLabel, meta: { id, storage: meta.storage }, success: true });
  return json({ ok: true });
};
