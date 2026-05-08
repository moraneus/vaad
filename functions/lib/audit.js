// Audit logging + rate limiting (login attempts).

import { uid, clientIP, userAgent } from './util.js';

export async function logAudit(db, request, { event, role = null, userLabel = null, apartmentId = null, success = true, meta = null }) {
  await db.prepare(
    'INSERT INTO audit_log (id, event, role, user_label, apartment_id, success, ip, user_agent, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(uid('a-'), event, role, userLabel, apartmentId, success ? 1 : 0, clientIP(request), userAgent(request), meta ? JSON.stringify(meta) : null).run();
}

// Sliding window of N attempts per IP+bucket within window minutes.
export async function checkRateLimit(db, request, bucket, env) {
  const ip = clientIP(request);
  const max = Number(env.RATE_LIMIT_MAX || 5);
  const windowMin = Number(env.RATE_LIMIT_WINDOW_MIN || 5);
  const row = await db.prepare(
    `SELECT attempts,
            (julianday('now') - julianday(window_start)) * 24 * 60 AS age_min
     FROM login_attempts WHERE ip = ? AND bucket = ?`
  ).bind(ip, bucket).first();

  if (!row) return { allowed: true, remaining: max };
  if (row.age_min > windowMin) {
    // window expired, reset
    await db.prepare('DELETE FROM login_attempts WHERE ip = ? AND bucket = ?').bind(ip, bucket).run();
    return { allowed: true, remaining: max };
  }
  if (row.attempts >= max) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((windowMin - row.age_min) * 60)) };
  }
  return { allowed: true, remaining: max - row.attempts };
}

export async function recordFailedAttempt(db, request, bucket) {
  const ip = clientIP(request);
  const exists = await db.prepare('SELECT 1 FROM login_attempts WHERE ip = ? AND bucket = ?').bind(ip, bucket).first();
  if (exists) {
    await db.prepare('UPDATE login_attempts SET attempts = attempts + 1 WHERE ip = ? AND bucket = ?').bind(ip, bucket).run();
  } else {
    await db.prepare("INSERT INTO login_attempts (ip, bucket, attempts, window_start) VALUES (?, ?, 1, datetime('now'))").bind(ip, bucket).run();
  }
}

export async function clearAttempts(db, request, bucket) {
  await db.prepare('DELETE FROM login_attempts WHERE ip = ? AND bucket = ?').bind(clientIP(request), bucket).run();
}
