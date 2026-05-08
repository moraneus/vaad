// GET    /api/audit — admin only, returns recent audit entries
// DELETE /api/audit — admin only, clears the log

import { json, error } from '../lib/util.js';
import { requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

export const onRequestGet = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const url = new URL(request.url);
  const limit = Math.min(500, Number(url.searchParams.get('limit') || 100));
  const rows = await env.DB.prepare(
    `SELECT id, ts, event, role, user_label AS userLabel, apartment_id AS apartmentId, success, ip, user_agent AS userAgent, meta
     FROM audit_log ORDER BY ts DESC LIMIT ?`
  ).bind(limit).all();
  return json({ entries: rows.results });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  await env.DB.prepare('DELETE FROM audit_log').run();
  await logAudit(env.DB, request, { event: 'audit_cleared', role: 'admin', userLabel: 'מנהל', success: true });
  return json({ ok: true });
};
