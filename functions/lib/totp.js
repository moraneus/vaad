// TOTP (RFC 6238) — Time-based One-Time Passwords using HMAC-SHA1.
// Pure Web Crypto, no third-party deps. Compatible with Google Authenticator,
// Authy, 1Password, Bitwarden, and any other RFC 6238 client.
//
// Constants are RFC 6238 defaults:
//   step = 30 seconds, digits = 6, algorithm = SHA-1.

import { randomBytes } from './crypto.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';   // RFC 4648 base32

// ---- Base32 encode / decode (RFC 4648) ----

function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  const out = [];
  let bits = 0, value = 0;
  for (const c of clean) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ---- TOTP core ----

// Compute the 6-digit TOTP at the given epoch-millis (default = now).
async function totpAt(secretBase32, epochMs) {
  const counter = Math.floor(epochMs / 1000 / 30);
  // Counter as 8-byte big-endian
  const counterBuf = new ArrayBuffer(8);
  const view = new DataView(counterBuf);
  // High 32 bits effectively zero for current Unix time (won't overflow until year 2106)
  view.setUint32(0, Math.floor(counter / 0x100000000), false);
  view.setUint32(4, counter >>> 0, false);

  const keyBytes = base32Decode(secretBase32);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, counterBuf);
  const sig = new Uint8Array(sigBuf);

  // Dynamic truncation per RFC 4226 §5.3
  const offset = sig[sig.length - 1] & 0x0f;
  const truncated = ((sig[offset] & 0x7f) << 24)
    | ((sig[offset + 1] & 0xff) << 16)
    | ((sig[offset + 2] & 0xff) << 8)
    | (sig[offset + 3] & 0xff);
  return String(truncated % 1_000_000).padStart(6, '0');
}

// Verify a code with ±1 step tolerance (acceptable clock skew of ~30s either way).
export async function verifyTotp(secretBase32, userCode) {
  const code = String(userCode || '').replace(/\s+/g, '').padStart(6, '0');
  if (!/^\d{6}$/.test(code)) return false;
  const now = Date.now();
  for (const offset of [0, -30_000, 30_000]) {
    const expected = await totpAt(secretBase32, now + offset);
    if (timingSafeEqual(expected, code)) return true;
  }
  return false;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---- Secret generation + otpauth URL ----

// Generate a 20-byte (160-bit) random secret as base32 — RFC 6238 recommended.
export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

// Build the standard otpauth:// URL that authenticator apps can scan or import.
// Reference: https://github.com/google/google-authenticator/wiki/Key-Uri-Format
export function otpauthUrl({ secret, issuer = 'Vaad Bayit', accountName = 'admin' }) {
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---- Backup codes ----

// Generate `count` random codes. Each code is 8 chars, alphanumeric uppercase
// (no I/O/0/1 to reduce ambiguity). Returns the plain codes for one-time
// display to the user.
export function generateBackupCodes(count = 8) {
  const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const out = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8);
    let s = '';
    for (let j = 0; j < 8; j++) s += ALPH[bytes[j] % ALPH.length];
    out.push(s.slice(0, 4) + '-' + s.slice(4, 8));    // formatted as XXXX-XXXX
  }
  return out;
}

export async function hashBackupCode(code) {
  const normalized = String(code || '').replace(/[\s-]/g, '').toUpperCase();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
