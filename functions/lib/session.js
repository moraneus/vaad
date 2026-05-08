// Session management — HttpOnly cookie + DB-backed sessions table.
// The cookie carries a signed (HMAC) opaque token; the row in `sessions` is authoritative.

import { signToken, verifyToken, randomToken } from './crypto.js';
import { uid, clientIP, userAgent } from './util.js';

const COOKIE_NAME = 'vaad_session';

function ttlMs(env) {
  const hours = Number(env.SESSION_TTL_HOURS || 12);
  return hours * 60 * 60 * 1000;
}

function cookieAttributes(env, maxAgeSec, isLocal) {
  // SameSite=Lax + HttpOnly + Secure (over HTTPS, which Cloudflare always provides on prod)
  const attrs = [
    `${env.COOKIE_NAME || COOKIE_NAME}=`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${maxAgeSec}`,
  ];
  if (!isLocal) attrs.splice(3, 0, 'Secure');
  return attrs;
}

export function setCookie(response, env, value, maxAgeSec, request) {
  const isLocal = new URL(request.url).hostname === 'localhost' || new URL(request.url).hostname === '127.0.0.1';
  const attrs = cookieAttributes(env, maxAgeSec, isLocal);
  attrs[0] = `${env.COOKIE_NAME || COOKIE_NAME}=${value}`;
  response.headers.append('Set-Cookie', attrs.join('; '));
}

export function clearCookie(response, env, request) {
  setCookie(response, env, '', 0, request);
}

export function readCookie(request, env) {
  const name = env.COOKIE_NAME || COOKIE_NAME;
  const raw = request.headers.get('Cookie') || '';
  const m = raw.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function ensureSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  // Local fallback. In production, deployer must set SESSION_SECRET via wrangler.
  return 'dev-only-secret-change-me-in-production-please-1234567890';
}

export async function createSession(db, { role, apartmentId = null, userLabel }, env, request) {
  const id = uid('s-');
  const expiresAt = new Date(Date.now() + ttlMs(env)).toISOString();
  await db.prepare(
    'INSERT INTO sessions (id, role, apartment_id, user_label, expires_at, last_seen_ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, role, apartmentId, userLabel, expiresAt, clientIP(request), userAgent(request)).run();
  const secret = await ensureSecret(env);
  const token = await signToken(JSON.stringify({ sid: id, exp: expiresAt }), secret);
  return { id, token, expiresAt };
}

export async function loadSession(db, request, env) {
  const cookie = readCookie(request, env);
  if (!cookie) return null;
  const secret = await ensureSecret(env);
  const payload = await verifyToken(cookie, secret);
  if (!payload || !payload.sid) return null;
  const row = await db.prepare(
    'SELECT id, role, apartment_id AS apartmentId, user_label AS userLabel, expires_at AS expiresAt FROM sessions WHERE id = ?'
  ).bind(payload.sid).first();
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(row.id).run();
    return null;
  }
  // Touch last seen (best effort, no await on critical path)
  db.prepare('UPDATE sessions SET last_seen_at = datetime(\'now\'), last_seen_ip = ?, user_agent = ? WHERE id = ?')
    .bind(clientIP(request), userAgent(request), row.id).run().catch(() => {});
  return row;
}

export async function destroySession(db, request, env) {
  const cookie = readCookie(request, env);
  if (!cookie) return;
  const secret = await ensureSecret(env);
  const payload = await verifyToken(cookie, secret);
  if (payload?.sid) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(payload.sid).run();
  }
}

// Periodic cleanup — cheap to call from any request.
export async function pruneExpiredSessions(db) {
  await db.prepare("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')").run();
}
