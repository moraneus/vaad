# Operations: Updates, Custom Domain, Local Dev, Backup

[← back to README](../README.md) · [עברית](./he/operations.md)

## Updating an existing deployment

When you pull a new version of this repo:

```bash
# 1. Reapply the schema — all migrations are idempotent (CREATE IF NOT EXISTS).
npx wrangler d1 execute <your-d1-name> --remote --file=./schema.sql

# 2. Redeploy the static + functions bundle.
npx wrangler pages deploy ./public --project-name=<cf-pages-project> --commit-dirty=true

# 3. (Optional) Redeploy the cron Worker if the worker code or schedule changed.
cd <path-to-cron-worker>
npx wrangler deploy
```

The schema file uses `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` and `INSERT OR IGNORE` so re-running it on a populated database is safe.

`--commit-dirty=true` skips Wrangler's "uncommitted changes" warning — useful since `wrangler.toml` is gitignored locally.

**The cron Worker (step 3) handles two monthly jobs:**
- `auto-extend-monthly` — pushes `endDate` forward for opt-in monthly expenses on the 1st of each month
- `monthly-report` — generates and emails the monthly PDF report

You only need to redeploy step 3 when the worker file (`worker/cron-monthly-report.js`) or its schedule changes. Manual triggers are available for testing:

```bash
# Run both endpoints (same as the schedule fires)
curl -X POST -H "x-cron-secret: <YOUR_CRON_SECRET>" \
  https://<cf-cron-worker>.<cf-account-subdomain>.workers.dev/run

# Run only the auto-extend endpoint
curl -X POST -H "x-cron-secret: <YOUR_CRON_SECRET>" \
  https://<cf-cron-worker>.<cf-account-subdomain>.workers.dev/run-extend
```

## Custom domain

In the Cloudflare dashboard:

1. Pages → project `<cf-pages-project>` → **Custom domains** → **Set up a custom domain**.
2. Add your domain — Cloudflare provisions TLS automatically.
3. Update DNS at your registrar (CNAME → `<cf-pages-project>.pages.dev`).
4. **Important:** add **both** of these to the Authorized redirect URIs in Google Cloud Console (Credentials → your OAuth client). Without them, Drive connection and identity verification from the custom domain will fail:
   - `https://yourdomain.com/api/drive/auth-callback`
   - `https://yourdomain.com/api/auth/identity-callback`

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
