// Cryptographic helpers — PBKDF2 password hashing + HMAC for session tokens.
// Uses Web Crypto API (available in Cloudflare Workers).

const ENC = new TextEncoder();
const DEC = new TextDecoder();

const b64 = {
  encode: (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode: (str) => {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

export function randomToken(bytes = 24) {
  return b64.encode(randomBytes(bytes));
}

// Constant-time string compare
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function hashPassword(password, iterations = 100000, saltBytes = null) {
  const salt = saltBytes || randomBytes(16);
  const key = await crypto.subtle.importKey('raw', ENC.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return {
    hash: b64.encode(bits),
    salt: b64.encode(salt),
    iterations,
  };
}

export async function verifyPassword(password, expectedHash, saltB64, iterations) {
  if (!password || !expectedHash || !saltB64) return false;
  const salt = b64.decode(saltB64);
  const { hash } = await hashPassword(password, iterations, salt);
  return safeEqual(hash, expectedHash);
}

// HMAC-SHA256 — used to sign session tokens. The token is opaque to the client;
// we only check its integrity. The session row is the source of truth.
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', ENC.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signToken(payloadStr, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, ENC.encode(payloadStr));
  return `${b64.encode(ENC.encode(payloadStr))}.${b64.encode(sig)}`;
}

export async function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return null;
  const key = await hmacKey(secret);
  const sig = b64.decode(sigB64);
  const payload = b64.decode(payloadB64);
  const ok = await crypto.subtle.verify('HMAC', key, sig, payload);
  if (!ok) return null;
  try { return JSON.parse(DEC.decode(payload)); } catch { return null; }
}

export const base64url = b64;

// AES-GCM encrypt/decrypt for storing OAuth refresh tokens. Key derived from
// SESSION_SECRET via PBKDF2 (so changing the secret invalidates Drive auth).
async function deriveAesKey(secret, salt = 'vaad-aes-v1') {
  const baseKey = await crypto.subtle.importKey('raw', ENC.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: ENC.encode(salt), iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptString(plain, secret) {
  const key = await deriveAesKey(secret);
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ENC.encode(plain));
  return { ciphertext: b64.encode(ciphertext), iv: b64.encode(iv) };
}

export async function decryptString(ciphertextB64, ivB64, secret) {
  const key = await deriveAesKey(secret);
  const ct = b64.decode(ciphertextB64);
  const iv = b64.decode(ivB64);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return DEC.decode(plain);
}
