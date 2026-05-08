// Global middleware: security headers, prune expired sessions occasionally.

import { pruneExpiredSessions } from './lib/session.js';

export const onRequest = async (context) => {
  const { request, next, env } = context;

  // Best-effort cleanup (1% of requests)
  if (Math.random() < 0.01 && env.DB) {
    pruneExpiredSessions(env.DB).catch(() => {});
  }

  let response;
  try {
    response = await next();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'שגיאת שרת', detail: String(err?.message || err) }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  // Apply security headers to all responses
  const h = new Headers(response.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // CSP: tight; only self for scripts/styles. Allow inline styles (we use them) and inline event scripts disallowed.
  if (!h.has('Content-Security-Policy')) {
    h.set('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '));
  }
  // HSTS only on HTTPS (Cloudflare always provides it on production)
  const url = new URL(request.url);
  if (url.protocol === 'https:') h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
};
