// HTTP helpers + common utilities for Pages Functions.

export const json = (data, init = {}) => new Response(JSON.stringify(data), {
  status: init.status || 200,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    ...(init.headers || {}),
  },
});

export const error = (message, status = 400, extra = {}) => json({ error: message, ...extra }, { status });

export const uid = (prefix = '') => {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  let h = '';
  for (let i = 0; i < arr.length; i++) h += arr[i].toString(16).padStart(2, '0');
  return `${prefix}${Date.now().toString(36)}-${h}`;
};

export const clientIP = (request) => request.headers.get('CF-Connecting-IP')
  || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
  || 'unknown';

export const userAgent = (request) => request.headers.get('User-Agent') || '';

export async function readJSON(request, max = 256 * 1024) {
  const cl = Number(request.headers.get('content-length') || 0);
  if (cl > max) throw new Error('payload too large');
  try { return await request.json(); }
  catch { throw new Error('invalid JSON'); }
}

export const pickStr = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
export const pickNum = (v) => (v == null || v === '' ? null : Number(v));
export const pickInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

export const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
