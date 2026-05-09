# Vaad Bayit · Building Committee Management

[Hebrew · עברית](./README.he.md)

A secure, bilingual (English / Hebrew) building-committee management system — track income, expenses, monthly/yearly reports, contacts, documents, reminders, and printable receipts. Hebrew RTL or English LTR with a one-click language switch.

Runs on **Cloudflare** (Pages + Functions + D1) with documents stored in the admin's **Google Drive**. Free for typical building usage.

---

## What's in this repo

- `public/` — static frontend (vanilla JS, RTL/LTR, i18n)
- `functions/` — Cloudflare Pages Functions (REST API + auth + Drive proxy)
- `worker/` — optional standalone Worker for the monthly cron (auto-extend monthly expenses + monthly email report)
- `schema.sql` — D1 database schema (idempotent — re-run on every deploy)
- `docs/` — full documentation (English) · `docs/he/` — Hebrew

## Highlights

A taste of what's inside (full list in [docs/features.md](./docs/features.md)):

- **Income** — apartment × month grid, inline edit of expected/paid, bulk-mark-paid for many apartments at once, CSV/PDF export by month/year/custom range.
- **Expenses** — three types (monthly / annual / one-off), inline payment ledger per monthly expense, default payment method per expense, opt-in **auto-extend** that pushes the end date forward each month via a cron Worker, date-range filtering, CSV/PDF export.
- **Reports** — monthly, yearly, or custom-range aggregated reports with cash-flow vs accounting modes (with hover tooltips explaining when each matters); CSV + browser-print PDF.
- **Owners** — first-class entity holding multiple apartments under one login, multi-phone with optional labels (e.g., "spouse" / "son"), sortable list (by apartment number or name).
- **Apartments** — number is enforced as digits-only on both client and server; replace renter / replace owner without losing financial history.
- **Documents** — uploaded to the admin's Google Drive (drive.file scope only), attachable to expenses, payments, *and* infrastructure expenses.
- **Auth** — admin-generated initial passwords (kept encrypted, re-displayable), bulk initial-password set, sign-in-with-Google for residents and admin, password recovery via Google OAuth, optional TOTP 2FA for the master admin.

## Documentation

| Topic | Read it in |
|---|---|
| **Architecture** — diagram, roles, project structure, owner/renter model | [docs/architecture.md](./docs/architecture.md) |
| **Features** — full capability list + supported languages | [docs/features.md](./docs/features.md) |
| **Security** — security model, what's protected, what isn't | [docs/security.md](./docs/security.md) |
| **Installation** — placeholders, walkthrough, **troubleshooting (incl. PBKDF2 CPU fix)** | [docs/installation.md](./docs/installation.md) |
| **Optional setup** — 2FA, Resend email, monthly cron, password recovery | [docs/optional-setup.md](./docs/optional-setup.md) |
| **Operations** — updates, custom domain, local dev, backup & restore | [docs/operations.md](./docs/operations.md) |
| **Cost** — free-tier breakdown for Cloudflare, Google, Resend | [docs/cost.md](./docs/cost.md) |

## Quick start

```bash
git clone https://github.com/moraneus/vaad.git vaad && cd vaad
cp wrangler.example.toml         wrangler.toml
cp worker/wrangler.example.toml  worker/wrangler.toml
cp package.example.json          package.json
npm install
# then follow docs/installation.md
```

If you hit a server error on first login, see the **PBKDF2 CPU fix** under [docs/installation.md → Troubleshooting](./docs/installation.md#troubleshooting-installation-issues).

## Roadmap

- Tenant push-notifications (WhatsApp / SMS) for overdue payments
- Two-step migration to Postgres + Hyperdrive if the project outgrows D1

## License

Open source. No warranty. Use at your own risk.
