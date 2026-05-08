// POST /api/auth/2fa-setup-init — admin starts 2FA setup.
// Returns a fresh secret + otpauth URL for the user to scan / paste into their
// authenticator app. The secret is NOT yet stored — only on successful verify.

import { json, error } from '../../lib/util.js';
import { requireAdmin } from '../../lib/guard.js';
import { generateTotpSecret, otpauthUrl } from '../../lib/totp.js';
import { admin2FAEnabled } from '../../lib/admin2fa.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  if (await admin2FAEnabled(env.DB)) {
    return error('אימות דו-שלבי כבר מופעל. יש לכבות לפני הגדרה מחדש.', 400);
  }
  const secret = generateTotpSecret();
  const settings = await env.DB.prepare("SELECT value FROM settings WHERE key = 'building_name'").first();
  const issuer = (settings?.value || 'Vaad Bayit').slice(0, 60);
  const url = otpauthUrl({ secret, issuer, accountName: 'admin' });
  return json({ secret, otpauthUrl: url });
};
