# Optional Setup: 2FA, Email, Cron, Password Recovery

[← back to README](../README.md) · [עברית](./he/optional-setup.md)

These add-ons are independent — you can enable any subset.

## Two-factor authentication (2FA) for the master admin

1. Sign in as admin and go to **Settings → Security & passwords → Two-factor auth → Enable 2FA**.
2. The dialog shows a Base32 secret + an `otpauth://` URL. Open Google Authenticator (or Authy / 1Password / Microsoft Authenticator) on your phone and add an account *manually* by pasting the secret.
3. Type the 6-digit code the app shows and click **Verify & enable**.
4. **Save the backup codes shown next** — they're emergency codes for when you lose your phone, and they're only displayed once.
5. From now on, admin login requires the password **and** a fresh code from the app.

To disable 2FA, you'll need both your admin password *and* a current code (or a backup code) — this prevents an attacker who only stole your session from turning it off.

> Apartment-admins (apartments promoted to admin) currently use only password-based login. 2FA enrollment is per-system, not per-user, so it protects the master admin only. Sign-in with Google is **blocked for the master admin** while 2FA is enabled (single-factor OAuth would otherwise bypass the second factor).

## Email notifications via Resend (free tier)

Sign up at [resend.com](https://resend.com) — the free tier gives you 3,000 emails / month.

> ⚠️ **Important — you need your own domain for production email.**
>
> Resend (like every reputable transactional email service) requires the sender address to live on a domain you've verified. **You cannot send from `@gmail.com`, `@outlook.com`, or any other provider's domain you don't own**.
>
> Three paths forward:
> 1. **Skip email entirely.** Everything in the system still works without it.
> 2. **Test with `onboarding@resend.dev`.** Resend's default sender. Only delivers to your Resend account email.
> 3. **Buy a cheap domain (~$10/year).** Cloudflare Registrar, Porkbun, Namecheap.

### 1. Create an API key

In the Resend dashboard → **API keys → Create API key** → copy the value (`re_...`).

### 2. Add a sender — pick one of three modes

**(a) Default sandbox sender (testing only):** Use `onboarding@resend.dev`. No setup. Limited to delivering to your Resend account's email.

**(b) Your own verified domain (production):**
- In Resend → **Domains → Add Domain** → enter your domain.
- Resend gives you 3–4 DNS records (SPF, DKIM, DMARC). Add them at your registrar.
- Wait 5–30 minutes for verification.
- Now you can send from any address on that domain, e.g. `vaad@yourdomain.co.il`.

**(c) Subdomain on someone else's domain (free workaround):** ask a friend with a domain for a subdomain, e.g. `vaad.theirdomain.co.il`.

### 3. Add the secrets to Cloudflare

```bash
cd <path-to-project>
npx wrangler pages secret put RESEND_API_KEY --project-name=<cf-pages-project>
# Paste the re_... key

npx wrangler pages secret put EMAIL_FROM --project-name=<cf-pages-project>
# Paste your verified sender, e.g. vaad@yourdomain.co.il
# (or onboarding@resend.dev for initial testing)

# Optional: customize the displayed sender name (defaults to "Vaad Bayit")
npx wrangler pages secret put EMAIL_FROM_NAME --project-name=<cf-pages-project>
# Paste e.g. "ועד הבית של רחוב הרצל 5"

# Redeploy so the new secrets are picked up
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
```

### 4. Verify it works

Sign in as admin → **Settings → Integrations → Email notifications → Send test email**. If it lands in your inbox, you're done.

### 5. Tell residents how to subscribe

Each tenant opts in to email updates from **Settings → Email updates → Subscribe to email updates**, or have the admin enter their email when adding/editing the apartment.

The admin can:
- **Send a monthly report** (manually) — Settings → Integrations → Send monthly report.
- **Send a custom broadcast** — Settings → Integrations → Email all residents.

Every email includes anti-spam footer and unsubscribe instructions; we record the consent date automatically.

### Common pitfalls

- **`The domain gmail.com is not verified`** — you set `EMAIL_FROM=you@gmail.com`. Switch to (a) or (b) above.
- **`The domain example.com is not verified`** — DNS verification is incomplete. Check Resend dashboard → Domains.
- **Email not arriving** — check spam folder.

## Automated monthly cron

A standalone Cloudflare Worker fires once a month and runs **two** monthly housekeeping jobs by calling Pages endpoints with a shared secret:

1. **Auto-extend monthly expenses** — for every monthly expense the admin opted into "auto-extend", the Worker pushes its `endDate` forward to the last day of the new month. This way one row stays the source of truth for an ongoing expense and rolls itself over.
2. **Monthly email report** — generates and emails the PDF report to opted-in residents via Resend.

**Cloudflare Pages Functions don't support scheduled triggers**, so we use a Worker as a thin scheduler. Both jobs share the same `CRON_SECRET`.

### 1. Create a shared secret

```bash
openssl rand -base64 32
# Copy the output — you'll paste it twice (Pages + Worker).
```

### 2. Set it on the Pages project

```bash
cd <path-to-project>
npx wrangler pages secret put CRON_SECRET --project-name=<cf-pages-project>
# Paste the value from step 1
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
```

### 3. Deploy the Worker (sibling directory recommended)

Wrangler 4.x walks up from the cwd looking for a `wrangler.toml`. Since the Pages project has its own at the project root, the cleanest setup is to keep the cron Worker in a sibling directory:

```bash
mv <path-to-project>/worker <path-to-cron-worker>
cd <path-to-cron-worker>
ls
# cron-monthly-report.js  wrangler.toml

npx wrangler secret put CRON_SECRET
# Paste the SAME value as in step 2

npx wrangler secret put PAGES_ORIGIN
# Paste your production URL, e.g. https://<cf-pages-project>.pages.dev
# (no trailing slash; use your custom domain if you set one)

npx wrangler deploy
```

Look for `schedule: 0 8 1 * *` in the deploy output — that's the cron firing on the 1st of every month at 08:00 UTC (≈ 11:00 Israel time).

### 4. Test manually (optional)

The Worker exposes two manual triggers (both authenticated with the same `x-cron-secret`):

```bash
# /run — fires both jobs (same as the schedule)
curl -X POST -H "x-cron-secret: <YOUR_CRON_SECRET>" \
  https://<cf-cron-worker>.<cf-account-subdomain>.workers.dev/run

# /run-extend — fires only the auto-extend job (useful when verifying that flow alone)
curl -X POST -H "x-cron-secret: <YOUR_CRON_SECRET>" \
  https://<cf-cron-worker>.<cf-account-subdomain>.workers.dev/run-extend
```

| Response | Meaning |
|---|---|
| `{"extend":{"status":200,"body":"..."},"report":{"status":200,"body":"..."}}` | both jobs ran — see each `body` for details |
| `{"ok":true,"extended":N,"target":"YYYY-MM-DD"}` (from `/run-extend`) | N monthly expenses had their endDate pushed forward to that date |
| `{"ok":true,"sent":N,"year":Y,"month":M}` | monthly email report sent to N residents |
| `{"error":"אין דיירים שרשומים לקבלת מיילים"}` | Pipeline OK, no opted-in residents yet |
| `{"error":"Forbidden"}` | `CRON_SECRET` doesn't match between Pages and the Worker |
| `{"error":"שירות האימייל לא הוגדר..."}` | `RESEND_API_KEY` / `EMAIL_FROM` aren't set on Pages |
| `{"error":"Resend batch: 403 — ... domain ... is not verified"}` | `EMAIL_FROM` points to an unverified domain |

> **Without the Cron Worker**, both jobs are still manual: the admin clicks **Send monthly report** each month from Settings, and they manually edit `endDate` on monthly expenses (or extend it well into the future) instead of relying on auto-extend.

## Password recovery (master admin AND every apartment / owner)

The recovery system is **per-user**, not shared:

- The **master admin** registers their own Google account.
- **Each apartment** (renter, apartment-admin) registers its own — different from the master admin's, and different from any other apartment's.
- **Each first-class owner** registers their own — independent of any apartment they own.

Recovery is done via **Google OAuth** — the user signs in to the Google account they registered, and on a successful match they land directly on a page to choose a new password. **No email is ever sent.**

**Requirements:** the user already verified a Google account in Settings → Security → Identity verification, and the Google OAuth client is configured.

### Flow — master admin

1. On the login screen, **Admin** tab.
2. Click **"Forgot password?"** under the password field.
3. Click **"Sign in with Google"** in the modal.
4. Sign in with the recovery account.
5. On a match → land on the new-password form. On a mismatch → polite error.

### Flow — apartment / owner

1. On the login screen, **Tenant** or **Owner** tab.
2. Pick the apartment / owner from the dropdown — a "**Forgot password?**" link appears.
3. Click it, then **"Sign in with Google"**.
4. Sign in with the Google account that was registered for this apartment / owner.
5. On a match → land on the new-password form for that user only.

### Side effects on successful reset

- Master admin reset: all active master-admin sessions are killed; **two-factor auth is disabled** (rationale: someone who lost their password has often lost their authenticator too — disabling 2FA prevents permanent lockout; can be re-enabled later).
- Apartment / owner reset: only that user's sessions are killed.

### Replacing a recovery account

Settings → Security → "Change recovery account" runs OAuth with `purpose=replace`. The current recovery account is replaced **only after the new Google account is successfully verified**.

### Anti-abuse

The reset endpoint is rate-limited per IP (5 requests / 5 min). A mismatched Google account is logged in the audit log under `identity_reset_mismatch`.

### If recovery is unavailable for the master admin

You only get into this state if you cleared the recovery account (or never registered one). Fallback: reset the master admin password directly in D1:

```bash
# Wipe the existing hash so the next login goes through "first install":
npx wrangler d1 execute <your-d1-name> --remote --command \
  "UPDATE admin_auth SET password_hash = 'NEEDS_INIT', password_salt = 'NEEDS_INIT' WHERE id = 1"
```

After running this, log in with `1234`, re-verify a recovery account in Settings, and then change the password.

### If a tenant can't recover their apartment password

The master admin can reset any apartment's password from **Settings → Tenant passwords → Reset**. The new password is shown to the admin via the password manager.

## Without email (Resend)

The system is **fully usable without Resend**, including all critical admin features:

- **What still works:** every admin and tenant feature in the UI — payments, expenses, reports, receipts, reminders, the About tab, password change, password **recovery** (Google OAuth), 2FA.
- **What you lose:** monthly report email, admin broadcast to tenants, tenant email opt-in.

The corresponding Settings buttons (Test email / Email all residents / Send monthly report) will show `שירות האימייל לא הוגדר` if clicked. No crash, just a clear message.
