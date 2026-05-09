# Vaad Bayit · Building Committee Management

[Hebrew · עברית](./README.he.md)

A secure, bilingual (English / Hebrew) building-committee management system — track income, expenses, monthly/yearly reports, contacts, documents, reminders, and printable receipts. Hebrew RTL or English LTR with a one-click language switch.

Runs on **Cloudflare** (Pages + Functions + D1) with documents stored in the admin's **Google Drive**. Free for typical building usage.

---

## What's in this repo

- `public/` — static frontend (vanilla JS, RTL/LTR, i18n)
- `functions/` — Cloudflare Pages Functions (REST API + auth + Drive proxy)
- `worker/` — optional standalone Worker for the monthly-report cron trigger
- `schema.sql` — D1 database schema (idempotent — re-run on every deploy)
- `docs/` — full documentation (English) · `docs/he/` — Hebrew

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
