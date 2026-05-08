# Vaad Bayit · Building Committee Management

[Hebrew · עברית](./README.he.md)

A secure, bilingual (English / Hebrew) building-committee management system — track income, expenses, monthly/yearly reports, contacts, documents, reminders, and printable receipts. Hebrew RTL or English LTR with a one-click language switch.

Runs on **Cloudflare** (Pages + Functions + D1) with documents stored in the admin's **Google Drive**. Free for typical building usage.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Pages — static frontend                         │
│  ./public/  · vanilla JS, RTL/LTR aware, i18n               │
└──────────────────┬──────────────────────────────────────────┘
                   │  fetch /api/*  (cookie session)
┌──────────────────▼──────────────────────────────────────────┐
│  Cloudflare Pages Functions  ./functions/api/                │
│  • auth (login, logout, change-password, reset-apartment)    │
│  • CRUD (apartments, payments, expenses, contacts, audit)    │
│  • adjustments + adjustment-payments (per-apartment debts)   │
│  • reminders, vaad-members, receipts                         │
│  • documents (proxy to Google Drive)                         │
│  • drive (OAuth init / callback / status / disconnect)       │
└──────┬───────────────────────────────┬──────────────────────┘
       │                               │
┌──────▼──────────────────┐   ┌────────▼──────────────────────┐
│  Cloudflare D1 (SQLite) │   │   Google Drive (admin's)      │
│  • application tables   │   │   folder: vaad-docs            │
│  • sessions, audit log  │   │   • PDF / image documents      │
│  • PBKDF2 hashes        │   │   • OAuth scope: drive.file    │
│  • encrypted Drive token│   │     (cannot see other files)   │
└─────────────────────────┘   └────────────────────────────────┘
```

## Features

- **Dashboard** — at-a-glance monthly / yearly numbers, 12-month trend chart, current bank balance.
- **Income tracking** — apartment × month grid with paid / partial / unpaid status; per-payment ledger; charge payments included as income. Both the **expected** and **paid** amounts are inline-editable per cell — overriding the expected amount for a single (apartment, month) cell flows automatically into all projection totals; a per-row delta badge shows debt or credit when the paid amount differs from the expected.
- **Expenses** — three types (monthly recurring, annual, one-off) with rate history, attachments, and per-period derived status (`In progress` / `Done`).
- **Per-apartment charges & credits** — manual debit/credit entries (e.g., past dues, refunds) that affect the outstanding balance independently of monthly fees, with their own payment ledger.
- **Receipts** — printable receipts (saved as PDF via the browser print dialog) with a stable, globally-running serial number. Same apartment + same month always returns the same receipt.
- **Reminders** — persistent reminders with lead time. Show up in a header bell, in a login modal, or attached to specific expenses (contract renewals etc.).
- **About tab** — bank details for transfers + committee members + free-form notes. Visible to tenants for quick reference.
- **Reports** — monthly / yearly · cash-flow vs accounting view · CSV export · print to PDF.
- **Audit log** — every login, mutation, password change, and reset is logged with real client IP.
- **Document storage** — uploads streamed through Pages Functions to Google Drive; the browser never sees the OAuth token.
- **Two-factor auth (2FA)** — optional TOTP for the master admin (Google Authenticator / Authy / 1Password). Includes single-use backup codes.
- **Email notifications** — opt-in per apartment. Admin can broadcast a custom message to all subscribed residents, or send the monthly report. Powered by Resend (free tier, 3,000 emails / month).
- **Automated monthly reports** — optional standalone Cloudflare Worker triggers the email report on the 1st of each month.

## Languages

The interface ships in **Hebrew** (default) and **English** with a built-in toggle in the header (and on the login screen). Layout direction switches automatically (RTL for Hebrew, LTR for English). The choice is saved in `localStorage` per browser. Currency, dates, numbers, and month names are all locale-aware.

## Roles

There are three effective roles, all derived from the `sessions.role` field on the server:

- **Master admin** — signs in via the global admin password (default `1234` on first install). Full access to everything in the system.
- **Apartment admin** — an apartment promoted to admin by an existing admin (Settings → Tenant passwords → "Make admin"). Signs in with the apartment's own password and gets the same privileges as the master admin.
- **Tenant (resident)** — read-only access to dashboard, income, expenses, reports, the About tab, and the option to download receipts for their own apartment. Tenants can change their own password but cannot modify any data.

All write endpoints require `requireAdmin` on the server. Tenants who try to call them get a `403 — אין הרשאה`.

## Security

| Layer                | Implementation                                                  |
|----------------------|------------------------------------------------------------------|
| Password hashing     | **PBKDF2-SHA256**, 100,000 iterations, random 16-byte salt      |
| Sessions             | `HttpOnly` + `Secure` + `SameSite=Lax` cookie, HMAC-signed, DB-backed row |
| Rate limiting        | 5 attempts / 5 minutes per IP+bucket (admin / per apartment)    |
| Security headers     | Strict CSP, `X-Frame-Options: DENY`, `Strict-Transport-Security`, `Referrer-Policy` |
| Audit log            | Every attempt logged with **real IP** from `CF-Connecting-IP`, User-Agent and timestamp |
| Server-side auth     | All sensitive endpoints validate session — cannot be bypassed via DevTools |
| Drive OAuth scope    | `drive.file` — app limited to files it created in `vaad-docs`   |
| Drive refresh token  | AES-GCM encrypted at rest in D1 (key derived from `SESSION_SECRET`) |

---

## Placeholders used in this guide

The commands below use these placeholders — substitute with your own values:

| Placeholder | What it is | Example |
|---|---|---|
| `<cf-pages-project>` | Cloudflare Pages project name (you choose this when you first deploy) | `building-mgmt` |
| `<your-d1-name>` | Cloudflare D1 database name (you choose when running `d1 create`) | `building-mgmt-db` |
| `<cf-cron-worker>` | Cloudflare Worker name for the monthly cron | `building-mgmt-cron` |
| `<path-to-project>` | Local path to the cloned repo on your machine | `~/Projects/building-mgmt` |
| `<path-to-cron-worker>` | Local path to the (sibling) cron worker directory | `~/Projects/building-mgmt-cron` |
| `<cron-worker-dir>` | The folder name of the sibling cron worker directory | `building-mgmt-cron` |
| `<cf-account-subdomain>` | Your Cloudflare workers.dev subdomain (printed on first Worker deploy) | `your-account-name` |

**Recommendation:** keep the placeholders consistent across your terminal sessions — pick once, use everywhere. The guide assumes the same `<cf-pages-project>` value is reused for all `--project-name=...` flags.

## Configuration files: `.example` template pattern

This repo follows a **template + local-override** pattern for the three files
that hold deployment-specific values:

| Committed to git (template) | Your local copy (gitignored) |
|---|---|
| `wrangler.example.toml` | `wrangler.toml` |
| `worker/wrangler.example.toml` | `worker/wrangler.toml` |
| `package.example.json` | `package.json` |

**Why:** the templates contain placeholders (`YOUR_D1_NAME`, `your-cf-pages-project`,
`REPLACE_WITH_YOUR_D1_DATABASE_ID`, …). After cloning, you copy each template to
its real filename and fill in your own Cloudflare values. Your local files are
gitignored so your real D1 database UUID and project names never get pushed to
a public repository.

**One-time setup after cloning:**

```bash
cp wrangler.example.toml          wrangler.toml
cp worker/wrangler.example.toml   worker/wrangler.toml
cp package.example.json           package.json
# now edit each of the three copies with your real values (see the walkthrough below)
```

If you ever need to change the templates themselves (rare — only if you add a
new var or script), edit the `.example.*` file and commit that.

## Quick reference (experienced users)

For someone who already knows Cloudflare and Google Cloud:

```bash
git clone <repo> vaad && cd vaad
# 1. Create your local config from the templates
cp wrangler.example.toml         wrangler.toml
cp worker/wrangler.example.toml  worker/wrangler.toml
cp package.example.json          package.json
npm install
# 2. Pick a Pages project name + a D1 name; replace placeholders in the three files above
npx wrangler login
npx wrangler d1 create <your-d1-name>                                   # → copy database_id into wrangler.toml
npx wrangler d1 execute <your-d1-name> --remote --file=./schema.sql
npx wrangler pages deploy ./public --project-name=<cf-pages-project>     # → outputs production URL
# Register OAuth client in Google Cloud Console with that URL (see Step 6 below)
openssl rand -base64 48 | npx wrangler pages secret put SESSION_SECRET    --project-name=<cf-pages-project>
npx wrangler pages secret put GOOGLE_CLIENT_ID                            --project-name=<cf-pages-project>
npx wrangler pages secret put GOOGLE_CLIENT_SECRET                        --project-name=<cf-pages-project>
npx wrangler pages deploy ./public --project-name=<cf-pages-project>              # redeploy with secrets
# Open the URL → log in as admin (1234) → change password → connect Drive → fill in settings
```

If anything in the above is unfamiliar, follow the detailed walkthrough below.

---

## Detailed installation walkthrough

> Total time: ~15 minutes. No prior Cloudflare/GCP experience required.

### Prerequisites

Before you start, make sure you have:

- A **Cloudflare account** (free — sign up at https://cloudflare.com/sign-up).
- A **Google account** that will own the document folder. The admin's email — preferably a dedicated one for the building.
- **Node.js 18+** and npm. Verify with:
  ```bash
  node --version    # should print v18.x or higher
  npm --version
  ```
- **Git** installed.
- A terminal / command line on your machine.

### Step 1 — Clone the repo, create your local config, install dependencies

```bash
git clone <your-repo-url> vaad
cd vaad

# Create your local config files from the committed templates.
# These three files are gitignored — your real values stay on your machine.
cp wrangler.example.toml         wrangler.toml
cp worker/wrangler.example.toml  worker/wrangler.toml
cp package.example.json          package.json

npm install
```

**Why the `cp` commands?** The committed `*.example.*` files contain placeholders
(`YOUR_D1_NAME`, `REPLACE_WITH_YOUR_D1_DATABASE_ID`, `your-cf-pages-project`, etc.).
You'll fill in your real Cloudflare values in the copied files in the next steps.
Because `wrangler.toml`, `worker/wrangler.toml`, and `package.json` are listed in
`.gitignore`, your real D1 database UUID and project names will not be pushed to
the public repo.

> **Important:** every time you change a deployment-related value (D1 name, Pages
> project name, Worker name), edit your **local** `wrangler.toml` / `package.json`
> — never the `.example.*` files (those are the public template).

**Verify:** `ls` shows `public/`, `functions/`, `schema.sql`, and your freshly created `wrangler.toml`. `npm install` finishes without errors. The only required dev dependency is `wrangler`.

### Step 2 — Authenticate to Cloudflare

```bash
npx wrangler login
```

This opens your default browser to log into Cloudflare. After approving, return to the terminal — Wrangler stores the token locally for future calls.

**Verify:**
```bash
npx wrangler whoami
```
should print your Cloudflare email and account ID.

**Common issues**
- *"Could not open browser"* — copy the URL printed in the terminal and open it manually.
- *"User not found"* — sign up at https://cloudflare.com first, then retry `wrangler login`.

### Step 3 — Create the D1 database

```bash
npx wrangler d1 create <your-d1-name>
```

**Expected output:**
```
✅ Successfully created DB '<your-d1-name>' in region <your-region>
[[d1_databases]]
binding = "DB"
database_name = "<your-d1-name>"
database_id = "abc123-def456-..."
```

**Action required:**
1. Copy the `database_id` value (the long random string).
2. Open `wrangler.toml` in your editor.
3. Replace the placeholder `REPLACE_WITH_YOUR_D1_DATABASE_ID` with that value:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "<your-d1-name>"
   database_id = "abc123-def456-..."
   ```
4. Save the file.

**Verify:**
```bash
npx wrangler d1 list
```
should show `<your-d1-name>` in the list.

### Step 4 — Apply the database schema

```bash
npx wrangler d1 execute <your-d1-name> --remote --file=./schema.sql
```

**What this does:** Creates all the tables (apartments, payments, expenses, sessions, audit_log, reminders, receipts, …) and seeds initial values (sentinel admin password, default building name, default fee, default apartment count).

**Expected output:** A list of executed queries, all showing ✅, no errors. The schema is fully idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`) — running it again is safe and is exactly how you'll apply future updates.

**Verify:**
```bash
npx wrangler d1 execute <your-d1-name> --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```
should list ~20 tables including `apartments`, `payments`, `expenses`, `receipts`, `sessions`, `audit_log`, etc.

### Step 5 — Initial deployment (no secrets yet)

We need to deploy first to get a public URL — Google's OAuth setup needs the URL.

```bash
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
```

**Expected output:**
```
🌍  Uploading... (X/X)
✨ Deployment complete!
   https://<random-id>.<cf-pages-project>.pages.dev
```

The stable, permanent URL is **`https://<cf-pages-project>.pages.dev`** (without the random ID). Copy it — you'll paste it into Google Cloud Console next.

**Verify:** Open `https://<cf-pages-project>.pages.dev` in your browser. You should see the login screen in Hebrew. Don't try to log in yet — secrets aren't configured.

### Step 6 — Google Cloud Console: OAuth setup

This step gives the app permission to talk to Google Drive on your behalf. Free for personal use.

#### 6.1 Create a Google Cloud project

1. Go to https://console.cloud.google.com.
2. Click the project picker at the top → **New Project**.
3. Name it `Vaad Bayit` (or anything).
4. Click **Create** and wait a few seconds for it to provision.
5. Switch into the new project from the picker.

#### 6.2 Enable the Drive API

1. In the left sidebar (≡): **APIs & Services → Library**.
2. Search for "Google Drive API".
3. Click the result → **Enable**.

#### 6.3 Configure the OAuth consent screen

1. Sidebar → **APIs & Services → OAuth consent screen**.
2. **User Type:** select **External** → **Create**.
3. App information page:
   - **App name:** `Vaad Bayit` (this is what users see during consent).
   - **User support email:** your email.
   - **Developer contact email:** your email.
   - The rest (logo, homepage, privacy policy) is optional — leave blank.
4. **Save and continue** → you land on **Scopes**.
5. Click **Add or remove scopes**, search for and check:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/userinfo.email`
6. Click **Update** → **Save and continue**.
7. **Test users** page → click **+ Add users** → enter the Gmail address that will own the building's documents folder. **Add the email of every admin who will connect Drive.**
8. **Save and continue** → **Back to dashboard**.

> The app stays in **Testing** mode — that's fine for personal/family use. Only test users can authenticate; everyone else hits "Access blocked: app not verified". Publishing the app would require Google's verification process, which isn't needed for a building committee.

#### 6.4 Create OAuth client credentials

1. Sidebar → **APIs & Services → Credentials → + Create credentials → OAuth client ID**.
2. **Application type:** **Web application**.
3. **Name:** `Vaad Bayit Web`.
4. **Authorized redirect URIs** — click **+ Add URI** and add **all** of the URIs below (exact match required, one per line):
   - `https://<cf-pages-project>.pages.dev/api/drive/auth-callback` — for connecting Google Drive (document storage)
   - `https://<cf-pages-project>.pages.dev/api/auth/identity-callback` — for verifying the recovery Google account and for "forgot password" (no Drive permissions)
   - `http://localhost:8787/api/drive/auth-callback` *(only if you'll run the app locally)*
   - `http://localhost:8787/api/auth/identity-callback` *(only if you'll run the app locally)*
5. Click **Create**.
6. A dialog pops up with **Client ID** and **Client secret**. **Copy both** — you'll paste them in Step 7. (You can re-open this dialog later from Credentials → your OAuth client.)

**Common issues**
- *"redirect_uri_mismatch"* later: the URI registered must match exactly — `https` vs `http`, no trailing slash, exact host.
- *"Access blocked"* during consent: the user is not in your Test users list (step 6.3).

### Step 7 — Set Cloudflare secrets

Cloudflare secrets are encrypted environment variables only the runtime can read.

#### 7.1 SESSION_SECRET

Used to sign session cookies *and* to encrypt the Drive refresh token at rest. Must be long and random.

```bash
openssl rand -base64 48 | npx wrangler pages secret put SESSION_SECRET --project-name=<cf-pages-project>
```

> ⚠️ Do not reuse across environments. Do not commit. Rotating it logs everyone out and invalidates the encrypted Drive refresh token (you'll have to reconnect Drive from the Settings UI).

#### 7.2 GOOGLE_CLIENT_ID

```bash
npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name=<cf-pages-project>
```

When prompted, paste the **Client ID** copied from Step 6.4 and press Enter.

#### 7.3 GOOGLE_CLIENT_SECRET

```bash
npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name=<cf-pages-project>
```

When prompted, paste the **Client Secret** copied from Step 6.4 and press Enter.

#### 7.4 Redeploy with the new secrets

```bash
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
```

Pages Functions only see secrets after a fresh deployment.

**Verify:**
```bash
npx wrangler pages secret list --project-name=<cf-pages-project>
```
should list `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (names only — values are not shown).

### Step 8 — First login

1. Open `https://<cf-pages-project>.pages.dev` in your browser.
2. On the login screen, switch to the **מנהל** (Admin) tab.
3. Default password is `1234`. Click **התחברות** (Login).
4. You're now logged in as admin. **Note:** the *Change admin password* button in Settings is **disabled until you verify a Google account for password recovery** (Step 8.5). This is by design — see the box below.

> **Why is identity verification mandatory before changing the password?**
> If you change the admin password and later forget it, there must be a way to
> recover. This system uses **Google itself as the recovery channel**: you
> register a Google account here, and if you ever forget the password, you
> click "Forgot password?" → "Sign in with Google" → if Google authenticates
> the same account → you're allowed to set a new password. **No email is ever
> sent**, so this works on day one without Resend, without a verified domain,
> without anything besides the Google OAuth client you already have.

### Step 8.5 — Verify identity with Google (mandatory)

Open **הגדרות (Settings)** → scroll to the **אבטחה וסיסמאות (Security & Passwords)** section. You'll see a new card titled **"אימות זהות לאיפוס סיסמה" (Identity verification for password recovery)** at the top.

1. Click **"אימות זהות עם Google" (Verify identity with Google)**.
2. You're redirected to Google's account chooser.
3. Pick the Gmail account that should serve as your **recovery account**. **Choose carefully** — this is the only account that can later reset the admin password. A dedicated building Gmail is recommended over a personal one. (This account does **not** have to be the same as the one you'll use for Drive — see the optional Step 9.)
4. Click **Allow** for the basic profile + email scopes (no Drive permissions are requested in this step).
5. You're redirected back. The card now shows **"מאומת" (Verified)** with the registered email.
6. The *Change admin password* button below is now enabled.

**Verify:** in **הגדרות → אבטחה וסיסמאות** the identity card is green and lists your address. The *שינוי סיסמת מנהל* button no longer shows the warning callout.

**Common issues**
- *"Error 400: redirect_uri_mismatch"* — the redirect URI in Google Cloud doesn't match `/api/auth/identity-callback` for your Pages origin. Add `https://<cf-pages-project>.pages.dev/api/auth/identity-callback` to **Authorized redirect URIs** in your OAuth client (Step 6.4).
- *"Access blocked: this app's request is invalid"* — your Gmail isn't a test user. Add it in Step 6.3.

### Step 9 (Optional) — Connect Google Drive for document storage

If you want to upload receipts, expense scans, or other documents to a private Drive folder, connect Drive now. Otherwise you can skip this — the rest of the system (apartments, payments, expenses, monthly fees, audit log, password recovery) works fully without it.

1. Still in Settings, scroll to **אינטגרציות (Integrations) → Google Drive** → click **חיבור Google Drive (Connect Google Drive)**.
2. You're redirected to Google's consent screen.
3. **You may pick a different Google account here than the one used in Step 8.5** — for example, register a personal Gmail as the recovery account and a shared building Gmail for document storage. The two are completely independent.
4. Click **Allow** to grant the `drive.file` scope (only files this app creates — nothing else in your Drive is accessible).
5. You're redirected back. The Drive card shows **"מחובר" (Connected)**.

**Verify:** open Drive in another tab — there's a new folder named **`vaad-docs`**. All future document uploads will land there.

**Common issues** are the same as Step 8.5 (redirect URI / test user).

### Step 9.5 — Change the admin password (mandatory)

Return to **הגדרות → אבטחה וסיסמאות**:

1. Click **שינוי סיסמת מנהל** (Change admin password) — it should be enabled, with a small note below it showing your recovery Google account.
2. Enter `1234` as the current password and choose a strong new one (at least 4 characters; longer is better).
3. Submit. The change is logged in the audit log.

If you ever forget the new password, use the **שכחת סיסמה?** (Forgot password?) link on the login screen — you'll be redirected to Google to sign in with the recovery account, and on a successful match you'll land directly on a page where you can choose a new password. **No Resend, no transactional email, no domain verification needed for this flow.**

### Step 10 — Initial building setup

Now fill in the actual data so the system reflects your building.

#### 10.1 Building info

**Settings → General**
- **שם הבניין** (building name)
- **כתובת** (address)
- **Save**

#### 10.2 Financial setup

**Settings → Financial setup**
- **יתרת פתיחה** (Opening balance) — the bank account balance on the day you start using the system.
- **תאריך התחלת ניהול** (Management start date) — apartment debts and the cumulative bank balance count from this date forward; everything before is considered settled by the opening balance.

#### 10.3 Apartment count + monthly fee history

Same screen, scroll down:
- **מספר דירות בבניין** — how many apartments are paying. The history lets you change this over time (e.g., a new floor was added).
- **דמי ועד חודשיים** — fee per apartment per month, also with date history.

#### 10.4 About tab

**About**
- **פרטי בנק** — bank name, branch, account number, account holder, IBAN, notes. Tenants will see this for transfers.
- **חברי ועד הבית** — name, role, phone, email per committee member.
- **הסבר כללי** — free-form text the tenants will see (meeting times, contact policy, etc.).

#### 10.5 Add apartments

**Apartments → + הוספת דירה (Add apartment)** for each unit:
- Number, owner name, phone (optional), notes (optional), active-from date.

#### 10.6 Tell residents how to log in

Send each resident:
1. The site URL (e.g. `https://<cf-pages-project>.pages.dev` or your custom domain).
2. Choose **דייר / דירה** (Tenant) on the login screen.
3. Pick their apartment number from the dropdown.
4. They'll be asked to set a personal password on the first login.

If they forget the password, you can reset it from **Settings → Tenant passwords → Reset**.

### Step 11 (Optional) — Promote a tenant to admin

If you want a co-chair to also have full admin rights without sharing the master password:

1. The tenant must have logged in at least once (so they have a password).
2. **Settings → Tenant passwords → "הפוך למנהל"** next to their row.
3. Done — the next time they sign in via the apartment login flow, they get full admin role automatically. Their session label shows e.g. `5 (מנהל)` so you can tell them apart in the audit log.

To revoke: same screen → **"הסר הרשאת מנהל"**. Their active sessions are killed immediately.

---

## Optional setup: 2FA, email & monthly cron

These three add-ons are independent — you can enable any subset.

### Two-factor authentication (2FA) for the master admin

1. Sign in as admin and go to **Settings → Security & passwords → Two-factor auth → Enable 2FA**.
2. The dialog shows a Base32 secret + an `otpauth://` URL. Open Google Authenticator (or Authy / 1Password / Microsoft Authenticator) on your phone and add an account *manually* by pasting the secret.
3. Type the 6-digit code the app shows and click **Verify & enable**.
4. **Save the backup codes shown next** — they're emergency codes for when you lose your phone, and they're only displayed once.
5. From now on, admin login requires the password **and** a fresh code from the app.

To disable 2FA, you'll need both your admin password *and* a current code (or a backup code) — this prevents an attacker who only stole your session from turning it off.

> Apartment-admins (apartments promoted to admin) currently use only password-based login. 2FA enrollment is per-system, not per-user, so it protects the master admin only.

### Email notifications via Resend (free tier)

Sign up at [resend.com](https://resend.com) — the free tier gives you 3,000 emails / month, more than enough for a building.

> ⚠️ **Important — you need your own domain for production email.**
>
> Resend (like every reputable transactional email service) requires the sender address to live on a domain you've verified. **You cannot send from `@gmail.com`, `@outlook.com`, or any other provider's domain you don't own** — Resend will reject the request with `validation_error: domain not verified`.
>
> Three paths forward:
>
> 1. **Skip email entirely.** Everything in the system still works without it; you just lose the email features (monthly report, broadcasts, password recovery). See "Without email" below.
> 2. **Test with `onboarding@resend.dev`.** This is Resend's default sender. You can use it without owning a domain, but it will **only** deliver to the email address you signed up with. Useful to verify the wiring works; not useful in production where you need to email your residents.
> 3. **Buy a cheap domain (~$10/year).** Easiest long-term path. Recommended registrars: Cloudflare Registrar (at-cost, integrates with your account), Porkbun, Namecheap. A `.com` is roughly $10/year; some TLDs like `.online`, `.xyz`, `.site` go as low as $1–3/year on first-year deals.

#### 1. Create an API key

In the Resend dashboard → **API keys → Create API key** → copy the value (`re_...`).

#### 2. Add a sender — pick one of three modes

**(a) Default sandbox sender (testing only):**
Use `onboarding@resend.dev`. No setup required. Limited to delivering to your Resend account's email.

**(b) Your own verified domain (production):**
- In Resend dashboard → **Domains → Add Domain** → enter your domain.
- Resend gives you 3–4 DNS records (SPF, DKIM, DMARC). Add them at your registrar's DNS panel.
- Wait 5–30 minutes for verification. Resend's status will turn green.
- Now you can send from any address on that domain, e.g. `vaad@yourdomain.co.il`.

**(c) Subdomain on someone else's domain (free workaround):**
If a friend/family has a domain, ask for a subdomain (e.g. `vaad.theirdomain.co.il`). They add the DNS records, you verify it on Resend.

#### Common pitfalls

- **`The domain gmail.com is not verified`** — you set `EMAIL_FROM=you@gmail.com`. Gmail/Outlook/Hotmail addresses cannot be senders. Switch to (a) or (b) above.
- **`The domain example.com is not verified`** — verification timed out or DNS records were entered wrong. Check Resend dashboard → Domains for the exact status and re-check DNS at your registrar.
- **Email not arriving** — check spam folder. Add the sender address to your contacts. For long-term deliverability, set up DMARC alignment (Resend has a one-click guide).

#### 3. Add the secrets to Cloudflare

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

#### 4. Verify it works

Sign in as admin → **Settings → Integrations → Email notifications → Send test email**. If it lands in your inbox, you're done.

#### 5. Tell residents how to subscribe

Each tenant opts in to email updates **on their first login** (a checkbox on the password-creation step). Existing tenants can subscribe later from **Settings → Email updates → Subscribe to email updates**, or have the admin enter their email when adding/editing the apartment in **Apartments → ✏️ → Email for updates**.

The admin can:
- **Send a monthly report** (manually) — Settings → Integrations → Send monthly report. Picks the previous month by default.
- **Send a custom broadcast** — Settings → Integrations → Email all residents. Free-form subject + body.

Every email includes a footer with anti-spam text and instructions to unsubscribe. Israeli anti-spam law and GDPR-equivalent — store the consent date (we do, automatically).

### Automated monthly cron

If you want the monthly report to send automatically on the 1st of each month, deploy a tiny standalone Cloudflare Worker. **Cloudflare Pages Functions don't support scheduled triggers**, so we use a Worker as a thin scheduler that calls the Pages endpoint via a shared secret.

#### 1. Create a shared secret

```bash
openssl rand -base64 32
# Copy the output — you'll paste it twice (Pages + Worker).
```

#### 2. Set it on the Pages project

```bash
cd <path-to-project>
npx wrangler pages secret put CRON_SECRET --project-name=<cf-pages-project>
# Paste the value from step 1
npx wrangler pages deploy ./public --project-name=<cf-pages-project>  # redeploy to pick up the secret
```

#### 3. Deploy the Worker (sibling directory recommended)

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

#### 4. Test manually (optional)

Find your `workers.dev` subdomain — it's printed in the deploy output, or visible in the Cloudflare dashboard under **Workers & Pages → <cf-cron-worker>**. Then:

```bash
curl -X POST \
  -H "x-cron-secret: <YOUR_CRON_SECRET>" \
  https://<cf-cron-worker>.<your-cf-subdomain>.workers.dev/run
```

| Response | Meaning |
|---|---|
| `{"ok":true,"sent":N,"year":Y,"month":M}` | 🎉 working — that's how many residents got the email |
| `{"error":"אין דיירים שרשומים לקבלת מיילים"}` | Pipeline OK, no opted-in residents yet — the cron will wait until someone subscribes |
| `{"error":"Forbidden"}` | `CRON_SECRET` doesn't match between Pages and the Worker — re-set both with the same value |
| `{"error":"שירות האימייל לא הוגדר..."}` | `RESEND_API_KEY` / `EMAIL_FROM` aren't set on Pages |
| `{"error":"Resend batch: 403 — ... domain ... is not verified"}` | `EMAIL_FROM` points to a domain you haven't verified on Resend. Use `onboarding@resend.dev` for testing, or verify your own domain. See "Email notifications via Resend" above. |

> **Without the Cron Worker**, everything still works — you'll just need to click **Send monthly report** manually each month.

### Admin password recovery

If the master admin forgets their password, recovery is done via **Google OAuth** — the user signs in to the Google account that was registered as the recovery account in Step 8.5, and on a successful match they land directly on a page where they can choose a new password. **No email is ever sent.**

**Requirements** — recovery works as long as:
- A recovery Google account has been registered (Settings → Security → Identity verification).
- The Google OAuth client is configured (which it already is from Step 6).

**That's it.** No Resend. No verified domain. No outgoing-email plumbing. The flow runs end-to-end on a fresh deploy that never touched email at all.

**Flow:**
1. On the login screen, switch to the **Admin** tab.
2. Click **"Forgot password?"** under the password field.
3. A small modal explains the flow. Click **"Sign in with Google"**.
4. Google's account chooser opens. Sign in with the recovery account from Step 8.5.
5. Google redirects back. If the email matches, you land immediately on the new-password form. If it doesn't match (someone else's Google account), you get a polite error.
6. Choose a new password and save.

**Side effects on successful reset:**
- All active admin sessions are killed (any open tab gets logged out).
- **Two-factor auth is disabled** if it was on. Rationale: someone who lost their password has often lost their authenticator too — disabling 2FA prevents permanent lockout. The admin can re-enable 2FA from Settings after signing in.

**Replacing the recovery account:**
Settings → Security → "Change recovery account" runs the same OAuth flow with `purpose=replace`. The current recovery email is replaced **only after the new Google account is successfully verified**. Available only while logged in as admin.

**Anti-abuse:**
The "Forgot password" endpoint is rate-limited per IP (5 requests / 5 min). A mismatched Google account is logged in the audit log under `identity_reset_mismatch` so you can see attempts.

**If recovery is unavailable:**
You only get into this state if you cleared the recovery account (or never registered one). Fallback: reset the admin password directly in D1:

```bash
# Wipe the existing hash so the next login goes through the "first install"
# path and accepts password "1234":
npx wrangler d1 execute <your-d1-name> --remote --command \
  "UPDATE admin_auth SET password_hash = 'NEEDS_INIT', password_salt = 'NEEDS_INIT' WHERE id = 1"
```

After running this, log in with `1234`, re-verify a recovery account in Settings, and then change the password.

### Without email (Resend)

The system is **fully usable without Resend**, including all critical admin features. If you don't want to set up Resend / a domain:

- **What still works:** every admin and tenant feature in the UI — payments, expenses, reports, receipts, reminders, the About tab, password change, password **recovery** (Google OAuth), 2FA.
- **What you lose:** monthly report email, admin broadcast to tenants, tenant email opt-in.

In other words: Resend is purely an enhancement for *outgoing tenant communications*. Nothing on the admin's critical path requires it.

The corresponding Settings buttons (Test email / Email all residents / Send monthly report) will show `שירות האימייל לא הוגדר` if clicked. No crash, just a clear message.

---

## Updating an existing deployment

When you pull a new version of this repo:

```bash
# 1. Reapply the schema — all migrations are idempotent (CREATE IF NOT EXISTS).
npx wrangler d1 execute <your-d1-name> --remote --file=./schema.sql

# 2. Redeploy the static + functions bundle.
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
```

The schema file uses `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` and `INSERT OR IGNORE` so re-running it on a populated database is safe.

---

## Custom domain

In the Cloudflare dashboard:

1. Pages → project `<cf-pages-project>` → **Custom domains** → **Set up a custom domain**.
2. Add your domain — Cloudflare provisions TLS automatically.
3. Update DNS at your registrar (CNAME → `<cf-pages-project>.pages.dev`).
4. **Important:** add **both** of these to the Authorized redirect URIs in Google Cloud Console (Credentials → your OAuth client). Without them, Drive connection and identity verification from the custom domain will fail:
   - `https://yourdomain.com/api/drive/auth-callback`
   - `https://yourdomain.com/api/auth/identity-callback`

---

## Local development

For local OAuth to work, set the Google credentials in a `.dev.vars` file (Wrangler reads it automatically; **do not commit** it):

```bash
# .dev.vars
SESSION_SECRET=any-random-string-for-local
GOOGLE_CLIENT_ID=...your-client-id...
GOOGLE_CLIENT_SECRET=...your-client-secret...
```

```bash
# Initialize the local D1 (one-time)
npm run db:init:local

# Start the dev server
npm run dev
# → http://127.0.0.1:8787
```

`wrangler pages dev` uses Miniflare — a local Cloudflare emulator with simulated D1 (state under `.wrangler/state/`). Make sure both `http://localhost:8787/api/drive/auth-callback` and `http://localhost:8787/api/auth/identity-callback` are in your Google OAuth redirect URIs.

---

## Backup & restore

### Database backup

```bash
mkdir -p backups
npx wrangler d1 export <your-d1-name> --remote --output=./backups/$(date +%Y%m%d).sql
```

### Documents

The documents *are* in your Google Drive — that's the backup. They survive even if you wipe the D1 database. To re-link them after a D1 wipe you'd need to re-upload through the app (the `documents` table tracks Drive file IDs).

### Restore D1

```bash
npx wrangler d1 execute <your-d1-name> --remote --file=./backups/snapshot.sql
```

---

## Cost — everything is free

Running this app for one building costs **zero shekels per month** when you stay within the documented setup. Here's the full picture of every external service the system touches and what each one charges:

### Cloudflare (the entire backend + hosting)

| Resource | Free tier | Your realistic usage |
|---|---|---|
| **Pages** (static hosting + custom domain) | Unlimited requests, unlimited bandwidth, 500 builds/month | Trivial — one build per `wrangler pages deploy` |
| **Pages Functions** (the `/api/...` server-side handlers) | 100,000 invocations/day, 10ms CPU per invocation (shared with Workers) | A typical committee makes < 1,000 requests/day |
| **D1** (the SQLite database) | 5 GB storage, 5,000,000 reads/day, 100,000 writes/day | This app stores < 10 MB and writes ~50 rows/day for one building |
| **Workers** (the standalone monthly-cron worker) | 100,000 requests/day, 10ms CPU/req | The cron runs once per month → 12 invocations per year |
| **Cron Triggers** | Free with Workers | One trigger, fires monthly |
| **Custom domain hookup** | Free for any domain you own (CF doesn't charge for the proxy) | Optional |

**The Cloudflare free tier is not a trial.** There's no time limit, no expiration, no "free for the first year" gotcha. As long as your usage stays under the daily limits, it stays free forever. If you ever did exceed a daily quota, Cloudflare returns HTTP 429 — it does **not** auto-charge you.

### Google services

| Service | Cost for you |
|---|---|
| **Google Cloud Console** (the OAuth client used by Drive + identity verification) | Free — registration only, no per-request fees for the OAuth flow itself |
| **Google Drive API** (used by the document-storage feature) | Free at this volume — there's a 1 billion-requests-per-day-per-project default quota |
| **Google Drive storage** | Uses the connected Google account's own free 15 GB quota — plenty for committee documents |

### Resend (optional, only if you want email features)

| Plan | Cost | What you'd use |
|---|---|---|
| Free tier | $0/month — **3,000 emails/month, 100/day** | Comfortably covers monthly reports + occasional broadcasts for any reasonably-sized building |

**Resend is now optional for everything.** Earlier versions of this app required Resend for the "forgot password" flow; the current architecture replaces that with a Google OAuth identity flow (see [Admin password recovery](#admin-password-recovery)). Resend is now used only for tenant-facing email features (broadcasts to residents, monthly PDF report). If you skip Resend entirely, the system still runs end-to-end — see [Without email (Resend)](#without-email-resend).

### When does it ever cost money?

Only if you choose to add either of these (both are optional and unrelated to the app):

1. **Custom domain registration** — if you want `vaad.<your-building>.com` instead of `<cf-pages-project>.pages.dev`, the registrar charges ~$10–15/year. The Cloudflare hookup itself is free.
2. **A domain you can verify with Resend** — only if you want emails to come from `vaad@<your-domain>.com` instead of `onboarding@resend.dev`. Same domain as #1 will work.

### One thing to leave alone

**Don't add a credit card to your Cloudflare account.** With no card on file, exceeding a daily quota simply returns 429 to clients — nothing gets charged. With a card on file, exceeding a quota would auto-upgrade you to a paid plan. For a single-building deployment this won't happen anyway, but the safe default is "no card."

---

## Security notes

### ⚠️ What is **not** fully secure on its own

- **The default admin password `1234`** must be changed on first login. The change is auto-recorded in the audit log.
- **`SESSION_SECRET`** lives in Cloudflare's secret store — never in the repo. Rotating it invalidates all active sessions **and** the encrypted Drive refresh token (you'd need to reconnect Drive).
- **Cloudflare account access** — anyone with access to your Cloudflare account can bypass app auth and read D1 directly. **Enable 2FA** on the Cloudflare account.
- **Google account access** — the admin's Google account access compromises the documents folder. **Enable 2FA** on Google.

### ✅ What is secure

- Data cannot be read without a valid session (every endpoint validates).
- Passwords are never stored in plaintext — only PBKDF2 hashes.
- Real IP is captured by Cloudflare (no spoofing in logs).
- Drive documents are private — never publicly shared, only streamed through the authenticated server endpoint.
- The `drive.file` OAuth scope means the app **literally cannot access** anything else in your Drive. Even if compromised, it can only touch files in the `vaad-docs` folder.
- CSP blocks XSS even if HTML injection got through.
- Rate limiting reduces brute-force success.
- Tenants are read-only at both the UI and the API. Tenant write attempts return `403`.

---

## Project structure

```
vaad/
├── public/                        # static frontend deployed to Pages
│   ├── index.html
│   └── assets/
│       ├── css/
│       └── js/
│           ├── i18n.js            # EN + HE dictionaries, dir attribute
│           ├── app.js             # bootstrap & routing
│           ├── api.js             # fetch wrapper + in-memory cache
│           ├── store.js           # state cache & mutators
│           ├── ui.js              # shell, modal, toast, language toggle, bell
│           ├── utils.js           # formatters, dates, html escape
│           ├── calc.js            # accounting / cash-flow math
│           └── views/             # dashboard, apartments, expenses, reminders,
│                                  # about, receipt, reports, settings, …
├── functions/                     # Cloudflare Pages Functions
│   ├── _middleware.js             # security headers + CSP + session prune
│   ├── lib/                       # crypto, session, audit, util, guard, drive
│   └── api/
│       ├── auth/                  # login, logout, me, change-password, reset-apartment
│       ├── drive/                 # auth-init, auth-callback, status, disconnect
│       ├── settings/              # count-history, fee-history
│       ├── documents/             # proxy upload/download/delete via Drive
│       ├── admin/                 # reset
│       └── *.js                   # apartments, payments, expenses, contacts,
│                                  # apartment-adjustments, adjustment-payments,
│                                  # reminders, receipts, vaad-members,
│                                  # apartment-admin, audit, …
├── schema.sql                     # D1 schema — fully idempotent
├── wrangler.toml
├── package.json
└── README.md / README.he.md
```

---

## Roadmap ideas

- **2FA for admin** — TOTP (Google Authenticator) using `otplib`
- **Tenant notifications** — webhook to WhatsApp / SMS on overdue payments
- **Two-step migration** to Postgres + Hyperdrive if the project outgrows D1

## License

Open source. No warranty. Use at your own risk.
