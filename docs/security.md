# Security

[← back to README](../README.md) · [עברית](./he/security.md)

## Security model

| Layer                | Implementation                                                  |
|----------------------|------------------------------------------------------------------|
| Password hashing     | **PBKDF2-SHA256**, 100,000 iterations, random 16-byte salt      |
| Sessions             | `HttpOnly` + `Secure` + `SameSite=Lax` cookie, HMAC-signed, DB-backed row |
| Rate limiting        | 5 attempts / 5 minutes per IP+bucket (admin / per apartment / OAuth) |
| Security headers     | Strict CSP, `X-Frame-Options: DENY`, `Strict-Transport-Security`, `Referrer-Policy` |
| Audit log            | Every attempt logged with **real IP** from `CF-Connecting-IP`, User-Agent and timestamp |
| Server-side auth     | All sensitive endpoints validate session — cannot be bypassed via DevTools |
| Drive OAuth scope    | `drive.file` — app limited to files it created in `vaad-docs`   |
| Drive refresh token  | AES-GCM encrypted at rest in D1 (key derived from `SESSION_SECRET`) |
| Stashed passwords    | AES-GCM encrypted at rest with `SESSION_SECRET` so admin can re-display |
| 2FA (optional)       | RFC 6238 TOTP for the master admin; secret AES-GCM encrypted at rest; single-use backup codes |
| Dynamic role check   | `apartment_admins` membership re-evaluated on every request — no stale-role issues |

## ⚠️ What is **not** fully secure on its own

- **The default admin password `1234`** must be changed on first login. The change is auto-recorded in the audit log.
- **`SESSION_SECRET`** lives in Cloudflare's secret store — never in the repo. Rotating it invalidates all active sessions, the encrypted Drive refresh token (you'd need to reconnect Drive), and all stashed passwords.
- **Cloudflare account access** — anyone with access to your Cloudflare account can bypass app auth and read D1 directly. **Enable 2FA** on the Cloudflare account.
- **Google account access** — the admin's Google account access compromises the documents folder and (if used as the recovery account) the admin password. **Enable 2FA** on Google.

## ✅ What is secure

- Data cannot be read without a valid session (every endpoint validates).
- Passwords are never stored in plaintext as hashes — only PBKDF2 hashes. The encrypted "stash" used to re-display admin-set passwords is decryptable only with `SESSION_SECRET` from the live runtime.
- Real IP is captured by Cloudflare (no spoofing in logs).
- Drive documents are private — never publicly shared, only streamed through the authenticated server endpoint.
- The `drive.file` OAuth scope means the app **literally cannot access** anything else in your Drive. Even if compromised, it can only touch files in the `vaad-docs` folder.
- CSP blocks XSS even if HTML injection got through.
- Rate limiting reduces brute-force success.
- Tenants are read-only at both the UI and the API. Tenant write attempts return `403`.
- Sign-in with Google is blocked for the master admin when 2FA is enabled (single-factor OAuth would otherwise bypass the second factor).
