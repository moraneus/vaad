// Admin-visible password stash. Stores user passwords AES-GCM-encrypted with
// SESSION_SECRET so the admin can re-display them on demand (instead of the
// once-only model). The PBKDF2 hash in apartments/owners is still the
// authoritative authentication artefact — this is for admin visibility only.
//
// Lifecycle:
//   - Stashed on every admin-driven set/reset (apartment create, owners
//     create, reset endpoints).
//   - Wiped when the user self-changes their password via change-password
//     (the new password is private to the user).
//   - Wiped when the apartment / owner row is deleted (via app code; D1 has
//     no FKs from this table since scope is polymorphic).

import { encryptString, decryptString } from './crypto.js';

function ensureSecret(env) {
  return env.SESSION_SECRET || 'dev-only-secret-change-me-in-production-please-1234567890';
}

export async function stashPassword(db, env, scope, scopeId, plaintext) {
  if (!plaintext) return;
  const enc = await encryptString(plaintext, ensureSecret(env));
  await db.prepare(
    `INSERT INTO user_password_secrets (scope, scope_id, ciphertext, iv, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(scope, scope_id) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       iv = excluded.iv,
       updated_at = excluded.updated_at`
  ).bind(scope, scopeId, enc.ciphertext, enc.iv).run();
}

export async function revealPassword(db, env, scope, scopeId) {
  const row = await db.prepare(
    'SELECT ciphertext AS ct, iv, updated_at AS updatedAt FROM user_password_secrets WHERE scope = ? AND scope_id = ?'
  ).bind(scope, scopeId).first();
  if (!row) return null;
  try {
    const plaintext = await decryptString(row.ct, row.iv, ensureSecret(env));
    return { plaintext, updatedAt: row.updatedAt };
  } catch {
    // Stash unreadable (e.g., SESSION_SECRET rotated) — treat as missing.
    return null;
  }
}

export async function wipePassword(db, scope, scopeId) {
  await db.prepare(
    'DELETE FROM user_password_secrets WHERE scope = ? AND scope_id = ?'
  ).bind(scope, scopeId).run();
}
