// POST /api/owners-reset-password — admin-only
// Body: { ownerId, newPassword? }
//
// Resets the owner's password. If newPassword is given (and passes the
// password policy), uses it; otherwise generates a random 8-char alphanumeric.
// Plaintext is returned ONCE in the response (initialPassword) for the admin
// to share with the owner. Hash is the only thing persisted.
//
// Side effect: kills all sessions for this owner so the old password can't
// be used to ride active sessions.

import { json, error, readJSON, pickStr } from '../lib/util.js';
import { requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';
import { generateRandomPassword, hashPassword, validatePassword } from '../lib/crypto.js';
import { stashPassword } from '../lib/password-stash.js';

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const ownerId = pickStr(body.ownerId, 80);
  if (!ownerId) return error('ownerId חסר', 400);

  const owner = await env.DB.prepare('SELECT id, name FROM owners WHERE id = ?').bind(ownerId).first();
  if (!owner) return error('בעלים לא נמצא', 404);

  let newPassword = pickStr(body.newPassword, 200);
  if (newPassword) {
    const v = validatePassword(newPassword);
    if (!v.ok) {
      return json({ error: 'הסיסמה לא עומדת במדיניות (8+ תווים, אות גדולה+קטנה, ספרה, סימול)', passwordPolicy: v }, { status: 400 });
    }
  } else {
    newPassword = generateRandomPassword(8);
  }
  const h = await hashPassword(newPassword, Number(env.PBKDF2_ITERATIONS || 100000));
  await env.DB.prepare(
    `UPDATE owners SET password_hash = ?, password_salt = ?, iterations = ?, password_set_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).bind(h.hash, h.salt, h.iterations, ownerId).run();
  await stashPassword(env.DB, env, 'owner', ownerId, newPassword);
  // Kill any active sessions for this owner.
  await env.DB.prepare(
    `DELETE FROM sessions WHERE id IN (SELECT session_id FROM session_owner WHERE owner_id = ?)`
  ).bind(ownerId).run();

  await logAudit(env.DB, request, { event: 'owner_password_reset', role: 'admin', userLabel: 'מנהל', meta: { ownerId, name: owner.name }, success: true });
  // Plaintext returned ONCE — never stored.
  return json({ ok: true, initialPassword: newPassword });
};
