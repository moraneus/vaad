# Cost — Everything Is Free

[← back to README](../README.md) · [עברית](./he/cost.md)

Running this app for one building costs **zero shekels per month** when you stay within the documented setup. Here's the full picture of every external service the system touches and what each one charges:

## Cloudflare (the entire backend + hosting)

| Resource | Free tier | Your realistic usage |
|---|---|---|
| **Pages** (static hosting + custom domain) | Unlimited requests, unlimited bandwidth, 500 builds/month | Trivial — one build per `wrangler pages deploy` |
| **Pages Functions** (the `/api/...` server-side handlers) | 100,000 invocations/day, 10ms CPU per invocation (shared with Workers) | A typical committee makes < 1,000 requests/day |
| **D1** (the SQLite database) | 5 GB storage, 5,000,000 reads/day, 100,000 writes/day | This app stores < 10 MB and writes ~50 rows/day for one building |
| **Workers** (the standalone monthly-cron worker) | 100,000 requests/day, 10ms CPU/req | The cron runs once per month → 12 invocations per year |
| **Cron Triggers** | Free with Workers | One trigger, fires monthly |
| **Custom domain hookup** | Free for any domain you own (CF doesn't charge for the proxy) | Optional |

**The Cloudflare free tier is not a trial.** There's no time limit, no expiration, no "free for the first year" gotcha. As long as your usage stays under the daily limits, it stays free forever. If you ever did exceed a daily quota, Cloudflare returns HTTP 429 — it does **not** auto-charge you.

## Google services

| Service | Cost for you |
|---|---|
| **Google Cloud Console** (the OAuth client used by Drive + identity verification) | Free — registration only, no per-request fees for the OAuth flow itself |
| **Google Drive API** (used by the document-storage feature) | Free at this volume — there's a 1 billion-requests-per-day-per-project default quota |
| **Google Drive storage** | Uses the connected Google account's own free 15 GB quota — plenty for committee documents |

## Resend (optional, only if you want email features)

| Plan | Cost | What you'd use |
|---|---|---|
| Free tier | $0/month — **3,000 emails/month, 100/day** | Comfortably covers monthly reports + occasional broadcasts for any reasonably-sized building |

**Resend is now optional for everything.** Earlier versions of this app required Resend for the "forgot password" flow; the current architecture replaces that with a Google OAuth identity flow. Resend is now used only for tenant-facing email features (broadcasts to residents, monthly PDF report). If you skip Resend entirely, the system still runs end-to-end.

## When does it ever cost money?

Only if you choose to add either of these (both are optional and unrelated to the app):

1. **Custom domain registration** — if you want `vaad.<your-building>.com` instead of `<cf-pages-project>.pages.dev`, the registrar charges ~$10–15/year. The Cloudflare hookup itself is free.
2. **A domain you can verify with Resend** — only if you want emails to come from `vaad@<your-domain>.com` instead of `onboarding@resend.dev`. Same domain as #1 will work.

## One thing to leave alone

**Don't add a credit card to your Cloudflare account.** With no card on file, exceeding a daily quota simply returns 429 to clients — nothing gets charged. With a card on file, exceeding a quota would auto-upgrade you to a paid plan. For a single-building deployment this won't happen anyway, but the safe default is "no card."
