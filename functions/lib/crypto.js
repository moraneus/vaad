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

// Random password meant for one-time admin-to-user sharing. Uses an
// unambiguous alphanumeric alphabet (no 0/O/1/I/l) — easy to read aloud or
// type. NOT meant for long-term use; the user is expected to change it via
// the policy-enforced change-password flow on first login.
const PW_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateRandomPassword(length = 8) {
  const arr = randomBytes(length);
  let pw = '';
  for (let i = 0; i < length; i++) pw += PW_ALPHABET[arr[i] % PW_ALPHABET.length];
  return pw;
}

// Password policy validation. Used by the backend to enforce on user-set
// passwords (change-password) and by the frontend's real-time validator.
// Returns one boolean per rule plus an `ok` aggregate so the UI can show
// each rule's pass/fail state.
//
// Rules (admin-typed initial passwords get the same checks; the
// machine-generated random password is exempt because it's a single-use
// initial value, not a user choice).
export const PASSWORD_RULES = {
  minLength: 8,
};
export function validatePassword(pw) {
  const s = String(pw || '');
  const r = {
    length: s.length >= PASSWORD_RULES.minLength,
    upper:  /[A-Z]/.test(s),
    lower:  /[a-z]/.test(s),
    digit:  /\d/.test(s),
    symbol: /[^A-Za-z0-9]/.test(s),
  };
  r.ok = r.length && r.upper && r.lower && r.digit && r.symbol;
  return r;
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
