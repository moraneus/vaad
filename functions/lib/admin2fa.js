// Admin 2FA helpers: load the 2FA row, encrypt/decrypt the TOTP secret with
// SESSION_SECRET, and verify a user-supplied code (TOTP or backup).

import { encryptString, decryptString } from './crypto.js';
import { verifyTotp, hashBackupCode } from './totp.js';

export async function loadAdmin2FA(db) {
  const row = await db.prepare(
    'SELECT totp_enabled AS totpEnabled, totp_secret_encrypted AS enc, totp_secret_iv AS iv, backup_codes_json AS codesJson, totp_activated_at AS activatedAt FROM admin_2fa WHERE id = 1'
  ).first();
  if (!row) return { totpEnabled: 0 };
  return row;
}

export async function admin2FAEnabled(db) {
  const r = await loadAdmin2FA(db);
  return !!r.totpEnabled;
}

// Save a freshly-set-up 2FA: encrypt the secret, store hashed backup codes.
export async function saveAdmin2FASetup(db, env, plainSecret, plainBackupCodes) {
  const { ciphertext, iv } = await encryptString(plainSecret, env.SESSION_SECRET);
  const codes = await Promise.all(
    plainBackupCodes.map(async (c) => ({ hash: await hashBackupCode(c), used_at: null })),
  );
  await db.prepare(
    `UPDATE admin_2fa
        SET totp_secret_encrypted = ?, totp_secret_iv = ?, totp_enabled = 1,
            totp_activated_at = datetime('now'), backup_codes_json = ?,
            updated_at = datetime('now')
      WHERE id = 1`
  ).bind(ciphertext, iv, JSON.stringify(codes)).run();
}

export async function disableAdmin2FA(db) {
  await db.prepare(
    `UPDATE admin_2fa
        SET totp_secret_encrypted = NULL, totp_secret_iv = NULL,
            totp_enabled = 0, totp_activated_at = NULL,
            backup_codes_json = NULL, updated_at = datetime('now')
      WHERE id = 1`
  ).run();
}

// Verify a 6-digit TOTP code OR a backup code. Returns:
//   { ok: true,  type: 'totp' }   on TOTP success
//   { ok: true,  type: 'backup', remaining: N }  on backup success
//   { ok: false }                  on failure (invalid/used)
export async function verifyAdmin2FACode(db, env, userCode) {
  const row = await loadAdmin2FA(db);
  if (!row.totpEnabled) return { ok: false };

  // Try TOTP first
  if (row.enc && row.iv) {
    const secret = await decryptString(row.enc, row.iv, env.SESSION_SECRET).catch(() => null);
    if (secret && await verifyTotp(secret, userCode)) {
      return { ok: true, type: 'totp' };
    }
  }

  // Fallback: maybe it's a backup code
  const inputHash = await hashBackupCode(userCode);
  let codes = [];
  try { codes = JSON.parse(row.codesJson || '[]'); } catch {}
  const idx = codes.findIndex(c => c.hash === inputHash && !c.used_at);
  if (idx >= 0) {
    codes[idx].used_at = new Date().toISOString();
    await db.prepare('UPDATE admin_2fa SET backup_codes_json = ?, updated_at = datetime(\'now\') WHERE id = 1')
      .bind(JSON.stringify(codes)).run();
    const remaining = codes.filter(c => !c.used_at).length;
    return { ok: true, type: 'backup', remaining };
  }

  return { ok: false };
}
