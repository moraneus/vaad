// POST /api/auth/2fa-disable  { password, code }
// Requires both the admin password AND a valid TOTP/backup code to disable
// 2FA. This prevents an attacker who only has session access from turning it
// off without the second factor.

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { verifyPassword } from '../../lib/crypto.js';
import { verifyAdmin2FACode, disableAdmin2FA, admin2FAEnabled } from '../../lib/admin2fa.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  if (!(await admin2FAEnabled(env.DB))) {
    return error('אימות דו-שלבי אינו פעיל', 400);
  }
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const password = pickStr(body.password, 200);
  const code = pickStr(body.code, 20);
  if (!password || !code) return error('שדות חובה חסרים', 400);

  // Verify admin password
  const row = await env.DB.prepare('SELECT password_hash AS h, password_salt AS s, iterations AS i FROM admin_auth WHERE id = 1').first();
  if (!row || !(await verifyPassword(password, row.h, row.s, row.i))) {
    return error('סיסמת מנהל שגויה', 401);
  }
  // Verify TOTP / backup code
  const codeOk = await verifyAdmin2FACode(env.DB, env, code);
  if (!codeOk.ok) return error('הקוד שגוי או כבר נוצל', 401);

  await disableAdmin2FA(env.DB);
  await logAudit(env.DB, request, { event: 'admin_2fa_disabled', role: 'admin', userLabel: r.sess.userLabel || 'מנהל', success: true });
  return json({ ok: true });
};
