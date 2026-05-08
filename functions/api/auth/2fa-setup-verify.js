// POST /api/auth/2fa-setup-verify  { secret, code }
// Verifies the user's 6-digit TOTP against the new secret. On success: encrypts
// and stores the secret, marks 2FA enabled, generates and returns backup codes
// (this is the only time they're shown — store them then).

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { verifyTotp, generateBackupCodes } from '../../lib/totp.js';
import { saveAdmin2FASetup, admin2FAEnabled } from '../../lib/admin2fa.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  if (await admin2FAEnabled(env.DB)) {
    return error('אימות דו-שלבי כבר מופעל', 400);
  }
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const secret = pickStr(body.secret, 64).toUpperCase().replace(/\s+/g, '');
  const code = pickStr(body.code, 10).replace(/\s+/g, '');
  if (!secret || !code) return error('שדות חובה חסרים', 400);

  const ok = await verifyTotp(secret, code);
  if (!ok) return error('הקוד שגוי. ודא שהזמן בטלפון מסונכרן ושהזנת את הקוד הנוכחי.', 401);

  const backupCodes = generateBackupCodes(8);
  await saveAdmin2FASetup(env.DB, env, secret, backupCodes);
  await logAudit(env.DB, request, { event: 'admin_2fa_enabled', role: 'admin', userLabel: r.sess.userLabel || 'מנהל', success: true });
  return json({ ok: true, backupCodes });
};
