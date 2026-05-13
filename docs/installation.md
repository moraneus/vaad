# Installation Guide

[← back to README](../README.md) · [עברית](./he/installation.md)

> Total time: ~15 minutes. No prior Cloudflare/GCP experience required.

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

This repo follows a **template + local-override** pattern for the three files that hold deployment-specific values:

| Committed to git (template) | Your local copy (gitignored) |
|---|---|
| `wrangler.example.toml` | `wrangler.toml` |
| `worker/wrangler.example.toml` | `worker/wrangler.toml` |
| `package.example.json` | `package.json` |

**Why:** the templates contain placeholders (`YOUR_D1_NAME`, `your-cf-pages-project`, `REPLACE_WITH_YOUR_D1_DATABASE_ID`, …). After cloning, you copy each template to its real filename and fill in your own Cloudflare values. Your local files are gitignored so your real D1 database UUID and project names never get pushed to a public repository.

**One-time setup after cloning:**

```bash
cp wrangler.example.toml          wrangler.toml
cp worker/wrangler.example.toml   worker/wrangler.toml
cp package.example.json           package.json
# now edit each of the three copies with your real values (see the walkthrough below)
```

If you ever need to change the templates themselves (rare — only if you add a new var or script), edit the `.example.*` file and commit that.

## Quick reference (experienced users)

For someone who already knows Cloudflare and Google Cloud:

```bash
git clone https://github.com/moraneus/vaad.git vaad && cd vaad
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
npx wrangler pages deploy ./public --project-name=<cf-pages-project>      # redeploy with secrets
# Open the URL → log in as admin (1234) → change password → connect Drive → fill in settings
```

If anything in the above is unfamiliar, follow the detailed walkthrough below.

---

## Detailed installation walkthrough

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
git clone https://github.com/moraneus/vaad.git vaad
cd vaad

# Create your local config files from the committed templates.
# These three files are gitignored — your real values stay on your machine.
cp wrangler.example.toml         wrangler.toml
cp worker/wrangler.example.toml  worker/wrangler.toml
cp package.example.json          package.json

npm install
```

**Why the `cp` commands?** The committed `*.example.*` files contain placeholders (`YOUR_D1_NAME`, `REPLACE_WITH_YOUR_D1_DATABASE_ID`, `your-cf-pages-project`, etc.). You'll fill in your real Cloudflare values in the copied files in the next steps. Because `wrangler.toml`, `worker/wrangler.toml`, and `package.json` are listed in `.gitignore`, your real D1 database UUID and project names will not be pushed to the public repo.

> **Important:** every time you change a deployment-related value (D1 name, Pages project name, Worker name), edit your **local** `wrangler.toml` / `package.json` — never the `.example.*` files (those are the public template).

**Verify:** `ls` shows `public/`, `functions/`, `schema.sql`, and your freshly created `wrangler.toml`. `npm install` finishes without errors.

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
3. Replace the placeholder `REPLACE_WITH_YOUR_D1_DATABASE_ID` with that value.
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

**What this does:** Creates all the tables (apartments, owners, payments, expenses, sessions, audit_log, reminders, receipts, …) and seeds initial values. The schema is fully idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`) — running it again is safe and is exactly how you'll apply future updates.

### Step 4.5 — (Optional) Create the R2 bucket for larger document storage

Document storage supports **three backends** — pick whichever you prefer in Settings → אחסון מסמכים after first login. Existing documents always stay on whichever backend they were uploaded with, so switching is safe.

| Backend | Free tier | Setup | Per-doc cap | Notes |
|---------|-----------|-------|-------------|-------|
| **Cloudflare D1** (default) | 5 GB total | none — works immediately | ~5 MB | Bytes stored as BLOBs in the same D1 already running the app. **No credit card required.** Best for small files. |
| **Cloudflare R2** | 10 GB / month + zero egress | bucket + R2 enabled in dashboard | up to 20 MB | Requires a payment method on file (even though free tier is $0). Best for larger files. |
| **Google Drive** | 15 GB per account | OAuth (Step 6 + Step 9) | up to 20 MB | Depends on the Google account staying healthy. |

The **default is D1** — it works the second the schema is applied, no extra steps. If you want R2 too (recommended for larger files), do this now:

```bash
npx wrangler r2 bucket create vaad-docs
```

If you get `Please enable R2 through the Cloudflare Dashboard`: open https://dash.cloudflare.com → R2 Object Storage → click **Purchase R2**. You'll be asked for a payment method but the free tier is $0; if you'd rather not provide a card, skip R2 and let D1 (and optionally Drive) handle storage.

(The bucket name `vaad-docs` is referenced from `wrangler.toml` under the `DOCS_BUCKET` binding. Pick a different name if you like, just keep them in sync.)

If you skip R2, comment out (or remove) the `[[r2_buckets]]` block in `wrangler.toml` — otherwise the deploy step will fail trying to bind a nonexistent bucket.

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

### Step 6 — Google Cloud Console: OAuth setup *(optional — only if you want Drive as a storage backend or "Sign in with Google" recovery)*

> 💡 You can skip this step if you're happy with R2 as your only document backend and don't need the "Sign in with Google" admin password recovery flow. Everything else (the main login, 2FA, email broadcasts, etc.) works without Google.

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
4. **Save and continue** → **Scopes**.
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
   - `https://<cf-pages-project>.pages.dev/api/auth/identity-callback` — for verifying the recovery Google account, password reset, and "sign in with Google"
   - `http://localhost:8787/api/drive/auth-callback` *(only if you'll run the app locally)*
   - `http://localhost:8787/api/auth/identity-callback` *(only if you'll run the app locally)*
5. Click **Create**.
6. A dialog pops up with **Client ID** and **Client secret**. **Copy both** — you'll paste them in Step 7.

**Common issues**
- *"redirect_uri_mismatch"* later: the URI registered must match exactly — `https` vs `http`, no trailing slash, exact host.
- *"Access blocked"* during consent: the user is not in your Test users list (step 6.3).

### Step 7 — Set Cloudflare secrets

Cloudflare secrets are encrypted environment variables only the runtime can read.

#### 7.1 SESSION_SECRET

Used to sign session cookies *and* to encrypt the Drive refresh token + 2FA TOTP secret + admin-stashed passwords at rest. Must be long and random.

```bash
openssl rand -base64 48 | npx wrangler pages secret put SESSION_SECRET --project-name=<cf-pages-project>
```

> ⚠️ Do not reuse across environments. Do not commit. Rotating it logs everyone out, invalidates the encrypted Drive refresh token (you'll have to reconnect Drive), and invalidates stashed passwords (admin would need to reset them).

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
should list `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

### Step 8 — First login

1. Open `https://<cf-pages-project>.pages.dev` in your browser.
2. On the login screen, switch to the **מנהל** (Admin) tab.
3. Default password is `1234`. Click **התחברות** (Login).
4. You're now logged in as admin. **Note:** the *Change admin password* button in Settings is **disabled until you verify a Google account for password recovery** (Step 8.5).

> **Why is identity verification mandatory before changing the password?**
> If you change the admin password and later forget it, there must be a way to recover. This system uses **Google itself as the recovery channel**: you register a Google account here, and if you ever forget the password, you click "Forgot password?" → "Sign in with Google" → if Google authenticates the same account → you're allowed to set a new password. **No email is ever sent**, so this works on day one without Resend, without a verified domain.

### Step 8.5 — Verify identity with Google (mandatory)

Open **הגדרות (Settings)** → scroll to the **אבטחה וסיסמאות (Security & Passwords)** section. You'll see a card titled **"אימות זהות לאיפוס סיסמה" (Identity verification for password recovery)**.

1. Click **"אימות זהות עם Google" (Verify identity with Google)**.
2. You're redirected to Google's account chooser.
3. Pick the Gmail account that should serve as your **recovery account**. **Choose carefully** — this is the only account that can later reset the admin password.
4. Click **Allow** for the basic profile + email scopes.
5. You're redirected back. The card now shows **"מאומת" (Verified)** with the registered email.
6. The *Change admin password* button below is now enabled.

### Step 9 (Optional) — Connect Google Drive as an alternate storage backend

> 💡 R2 is already the default and works out of the box. Connect Drive only if you want it as an alternative (or as your *only* backend, in which case skip Step 4.5 and switch the active provider to Drive once connected).

If you want to upload to a private Drive folder instead of (or in addition to) R2, connect Drive now.

1. Still in Settings, scroll to **אינטגרציות (Integrations) → אחסון מסמכים (Document storage)** and **Google Drive** → click **חיבור Google Drive (Connect Google Drive)**.
2. **You may pick a different Google account here than the one used in Step 8.5** — the recovery and Drive accounts can differ.
3. Click **Allow** to grant the `drive.file` scope (only files this app creates).
4. The Drive card shows **"מחובר" (Connected)**.
5. If you want Drive to be the active backend for *new* uploads, pick its radio in the **אחסון מסמכים** card. Existing R2-stored documents stay on R2 — only fresh uploads change.

**Verify:** open Drive in another tab — there's a new folder named **`vaad-docs`**.

### Step 9.5 — Change the admin password (mandatory)

Return to **הגדרות → אבטחה וסיסמאות**:

1. Click **שינוי סיסמת מנהל** (Change admin password).
2. Enter `1234` as the current password and choose a strong new one (at least 4 characters; longer is better).
3. Submit.

If you ever forget the new password, use the **שכחת סיסמה?** (Forgot password?) link on the login screen.

### Step 10 — Initial building setup

Now fill in the actual data so the system reflects your building.

#### 10.1 Building info
**Settings → General** — building name, address, save.

#### 10.2 Financial setup
**Settings → Financial setup** — opening balance, management start date.

#### 10.3 Apartment count + monthly fee history
Same screen, scroll down: number of apartments and monthly fee, both with date history.

#### 10.4 About tab
**About** — bank details, committee members, free-form notes.

#### 10.5 Add apartments
**Apartments → + Add apartment** for each unit. Choose owner-occupied or rented; if rented, link to or create the owner.

#### 10.6 Tell residents how to log in
Send each resident the site URL and the password the admin generated for them (visible from **Settings → Tenant passwords → eye icon** on the password manager).

### Step 11 (Optional) — Promote a tenant to admin

To give a co-chair full admin rights without sharing the master password:

1. **Settings → Tenant passwords → "הפוך למנהל"** next to their row.
2. Done — the apartment-admin role takes effect immediately for that apartment's session, including for the apartment's owner if it's owner-occupied.

To revoke: same screen → **"הסר הרשאת מנהל"**. Their active sessions are killed immediately (both apartment and owner sessions).

---

## Troubleshooting installation issues

### Server error (5xx) on first login due to PBKDF2 CPU limit

If you see a styled "Server error" page when trying to log in for the first time after a fresh install — and the audit log records show the request timed out — your `PBKDF2_ITERATIONS` value is set high enough to exceed Cloudflare Workers' free-tier CPU budget per request (10ms).

The repo template sets `PBKDF2_ITERATIONS = "100000"` by default, which fits comfortably under the budget. If you (or a previous version of the template) bumped it up to `"200000"` or higher, lower it back to `"100000"` and redeploy:

```bash
cd <path-to-project>
sed -i '' 's/PBKDF2_ITERATIONS = "200000"/PBKDF2_ITERATIONS = "100000"/' wrangler.toml
# Redeploy so Pages picks up the change
npx wrangler pages deploy ./public --project-name=<cf-pages-project> --commit-dirty=true
```

(macOS uses `sed -i ''`; Linux uses `sed -i` without the `''`.)

`--commit-dirty=true` tells Wrangler to skip the warning about uncommitted changes — useful when you only edited the local-gitignored `wrangler.toml` and don't have a clean working tree.

After the redeploy, login should succeed. 100,000 PBKDF2 iterations is still well above the OWASP minimum recommendation for SHA-256 (which is 600,000 for offline attack scenarios — but in our model the attacker would need access to D1, in which case they can already read your data directly, so the ratio of cost-to-defense argues for the lower number on the constrained Workers CPU budget).

### Sign-in with Google returns to a Google 404 page

Causes, in decreasing order of likelihood:
- A whitespace/newline character snuck into `GOOGLE_CLIENT_ID` (Cloudflare Pages env vars sometimes get pasted with trailing whitespace). Re-enter the secret with `wrangler pages secret put GOOGLE_CLIENT_ID ...`.
- The OAuth client was deleted/disabled in Google Cloud Console.
- Browser hit a stale cached redirect — try a private window.

### "redirect_uri_mismatch"

The URI registered in Google Cloud Console must match exactly — `https` vs `http`, no trailing slash, exact host. Add both `…/api/drive/auth-callback` and `…/api/auth/identity-callback` for **every** origin you'll use (production domain, custom domain, `localhost:8787` for local dev).

### "Access blocked: this app's request is invalid"

The Google account you're picking is not in your Test users list. Add it under **APIs & Services → OAuth consent screen → Test users**.
