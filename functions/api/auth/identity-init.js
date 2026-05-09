// POST /api/auth/identity-init
// Body: { purpose: 'register' | 'replace' | 'reset', apartmentId? }
//
// Returns: { url } — Google OAuth consent URL the client redirects to.
//
// Purposes:
//   register: first-time identity verification. Requires a logged-in session.
//             Scope is determined automatically:
//               - master admin (role='admin' AND no apartmentId) → scope='master'
//               - apartment user (apartmentId set, any role) → scope='apartment:<id>'
//   replace : same as register but for changing an existing recovery account.
//   reset   : anonymous "forgot password". Body must include apartmentId for a
//             tenant reset; omit it for a master admin reset.
//             Rate-limited per IP.

import { json, error, uid, readJSON, pickStr } from '../../lib/util.js';
import { loadSession } from '../../lib/session.js';
import { buildIdentityAuthURL } from '../../lib/identity-oauth.js';
import { logAudit, checkRateLimit, recordFailedAttempt } from '../../lib/audit.js';

const VALID_PURPOSES = new Set(['register', 'replace', 'reset']);

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return error('Google OAuth client not configured. Admin must set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', 412);
  }

  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const purpose = String(body?.purpose || '').trim();
  const bodyApartmentId = pickStr(body?.apartmentId, 80);
  if (!VALID_PURPOSES.has(purpose)) return error('מטרה לא חוקית', 400);

  let scope;       // 'master' or 'apartment:<id>'
  let userLabel;   // for audit log

  // Optional userKind in body distinguishes 'tenant' (default) from 'owner'
  // when scoping to an apartment. Determines which recovery row is
  // touched/checked: apartment_recovery vs apartment_owner_recovery.
  const bodyUserKind = String(body?.userKind || '').trim();
  const targetUserKind = bodyUserKind === 'owner' ? 'owner' : 'tenant';

  if (purpose === 'register' || purpose === 'replace') {
    const sess = await loadSession(db, request, env);
    if (!sess) return error('יש להתחבר תחילה', 401);
    if (sess.ownerId) {
      // First-class owner session (PR E) — scope to the owner entity.
      scope = `owner:${sess.ownerId}`;
      userLabel = sess.userLabel || `owner:${sess.ownerId}`;
    } else if (sess.apartmentId) {
      // Apartment user — recovery is per-apartment AND per-credential-kind.
      // For register/replace, the scope is determined by the session's own
      // userKind (so an owner-session can only register the owner's recovery,
      // and a renter-session can only register the renter's).
      const sessionKind = sess.userKind === 'owner' ? 'owner' : 'tenant';
      scope = sessionKind === 'owner' ? `apartment_owner:${sess.apartmentId}` : `apartment:${sess.apartmentId}`;
      userLabel = sess.userLabel || `apt:${sess.apartmentId}`;
    } else if (sess.role === 'admin') {
      scope = 'master';
      userLabel = 'מנהל';
    } else {
      return error('אין הרשאה', 403);
    }
  } else {
    // 'reset' — anonymous. Rate-limit per IP.
    const rl = await checkRateLimit(db, request, 'identity-reset', env);
    if (!rl.allowed) {
      await logAudit(db, request, { event: 'identity_reset_rate_limited', role: 'admin', userLabel: 'מנהל', success: false });
      return error('יותר מדי בקשות. נסה שוב מאוחר יותר.', 429, { retryAfterSec: rl.retryAfterSec });
    }
    await recordFailedAttempt(db, request, 'identity-reset');
    const bodyOwnerId = pickStr(body?.ownerId, 80);
    const bodyOwnerLoginEmail = pickStr(body?.ownerLoginEmail, 254).trim().toLowerCase();
    if (bodyOwnerId || bodyOwnerLoginEmail) {
      // First-class owner reset. Prefer ownerId (from the new picker UI);
      // fall back to login_email lookup for backwards compat.
      let owner;
      if (bodyOwnerId) {
        owner = await db.prepare('SELECT id FROM owners WHERE id = ?').bind(bodyOwnerId).first();
      } else {
        owner = await db.prepare('SELECT id FROM owners WHERE LOWER(login_email) = ?').bind(bodyOwnerLoginEmail).first();
      }
      if (!owner) return error('בקשה לא תקינה', 400);
      scope = `owner:${owner.id}`;
      userLabel = `owner:${owner.id}`;
    } else if (bodyApartmentId) {
      // Apartment reset — verify the apartment exists (don't leak via different
      // error messages — a non-existent apartment returns the same 200 path).
      const apt = await db.prepare('SELECT id FROM apartments WHERE id = ?').bind(bodyApartmentId).first();
      if (!apt) {
        // Generic-looking error to avoid enumeration.
        return error('בקשה לא תקינה', 400);
      }
      // Scope picks tenant-vs-owner credential set.
      scope = targetUserKind === 'owner' ? `apartment_owner:${bodyApartmentId}` : `apartment:${bodyApartmentId}`;
      userLabel = `apt:${bodyApartmentId}${targetUserKind === 'owner' ? ' (בעלים)' : ''}`;
    } else {
      scope = 'master';
      userLabel = 'מנהל';
    }
  }

  const url = new URL(request.url);
  const redirectURI = `${url.origin}/api/auth/identity-callback`;
  const state = uid('id-');

  await db.prepare('INSERT INTO identity_oauth_state (state, purpose, scope) VALUES (?, ?, ?)')
    .bind(state, purpose, scope).run();
  // Best-effort prune of expired state nonces (older than 30 minutes)
  db.prepare("DELETE FROM identity_oauth_state WHERE datetime(created_at) < datetime('now', '-30 minutes')").run().catch(() => {});

  await logAudit(db, request, {
    event: 'identity_oauth_started',
    role: scope === 'master' ? 'admin' : 'tenant',
    userLabel, success: true, meta: { purpose, scope },
  });
  return json({ url: buildIdentityAuthURL(env, redirectURI, state) });
};
