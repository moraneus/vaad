// POST /api/admin/reset { confirm: 'I-AGREE-TO-WIPE' } — clears all data (admin only).
// Also deletes files from the connected Google Drive folder.

import { json, error, readJSON } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { logAudit } from '../../lib/audit.js';
import { getAccessToken, listFolderFiles, deleteFile, getDriveStatus } from '../../lib/drive.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  if (body.confirm !== 'I-AGREE-TO-WIPE') return error('הפעולה לא אושרה', 400);
  const db = env.DB;

  // Best-effort: wipe Drive folder contents if connected
  try {
    const status = await getDriveStatus(db);
    if (status.connected && status.folderId) {
      const { accessToken, folderId } = await getAccessToken(db, env);
      const files = await listFolderFiles(accessToken, folderId);
      for (const f of files) await deleteFile(accessToken, f.id).catch(() => {});
    }
  } catch (_) { /* ignore — admin can clean up manually */ }

  await db.batch([
    db.prepare('DELETE FROM document_links'),
    db.prepare('DELETE FROM documents'),
    db.prepare('DELETE FROM expense_payments'),
    db.prepare('DELETE FROM expense_auto_extend'),
    db.prepare('DELETE FROM expense_default_method'),
    db.prepare('DELETE FROM expense_contact_link'),
    db.prepare('DELETE FROM expense_rates'),
    db.prepare('DELETE FROM expenses'),
    db.prepare('DELETE FROM contacts'),
    db.prepare('DELETE FROM payments'),
    db.prepare('DELETE FROM apartments'),
    db.prepare('DELETE FROM apartment_count_history'),
    db.prepare('DELETE FROM monthly_fee_history'),
    db.prepare('DELETE FROM sessions'),
    db.prepare('DELETE FROM login_attempts'),
    db.prepare('DELETE FROM audit_log'),
    db.prepare("DELETE FROM settings WHERE key NOT IN ('building_name')"),
    db.prepare("INSERT OR IGNORE INTO apartment_count_history (id, effective_from, count) VALUES ('seed-1', date('now'), 9)"),
    db.prepare("INSERT OR IGNORE INTO monthly_fee_history (id, effective_from, amount) VALUES ('seed-1', date('now'), 280)"),
  ]);

  await logAudit(env.DB, request, { event: 'system_reset', role: 'admin', userLabel: r.sess.userLabel, success: true });
  return json({ ok: true });
};
