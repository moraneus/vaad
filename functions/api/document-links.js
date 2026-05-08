// POST   /api/document-links { documentId, targetType, targetId }
// DELETE /api/document-links?documentId=...&targetType=...&targetId=...

import { json, error, readJSON, pickStr } from '../lib/util.js';
import { requireAdmin } from '../lib/guard.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const documentId = pickStr(body.documentId, 80);
  const targetType = pickStr(body.targetType, 16);
  const targetId = pickStr(body.targetId, 80);
  if (!documentId || !['expense', 'payment'].includes(targetType) || !targetId) return error('שדות חסרים', 400);
  await env.DB.prepare('INSERT OR IGNORE INTO document_links (document_id, target_type, target_id) VALUES (?, ?, ?)').bind(documentId, targetType, targetId).run();
  return json({ ok: true });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const u = new URL(request.url).searchParams;
  await env.DB.prepare('DELETE FROM document_links WHERE document_id = ? AND target_type = ? AND target_id = ?')
    .bind(u.get('documentId'), u.get('targetType'), u.get('targetId')).run();
  return json({ ok: true });
};
