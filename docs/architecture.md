# Architecture & Project Structure

[← back to README](../README.md) · [עברית](./he/architecture.md)

## High-level diagram

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
│  • infrastructure expenses + demands + payments              │
│  • reminders, vaad-members, receipts                         │
│  • documents (proxy to Google Drive)                         │
│  • drive (OAuth init / callback / status / disconnect)       │
│  • identity OAuth (recovery + sign-in-with-google)           │
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

## Roles

There are three effective roles, all derived from the `sessions.role` field on the server. The role is **re-evaluated on every request** based on the current `apartment_admins` membership — granting or revoking apartment-admin takes effect immediately for live sessions, no re-login needed.

- **Master admin** — signs in via the global admin password (default `1234` on first install). Full access to everything in the system.
- **Apartment admin** — an apartment promoted to admin by an existing admin (Settings → Tenant passwords → "Make admin"). Signs in with the apartment's own password and gets the same privileges as the master admin. The role applies to **both** the renter and owner sessions for that apartment, and propagates to first-class owners whose linked apartments are admin.
- **Tenant (resident)** — read-only access to dashboard, income, expenses, reports, the About tab, and the option to download receipts for their own apartment. Tenants can change their own password but cannot modify any data.

All write endpoints require `requireAdmin` on the server. Tenants who try to call them get a `403 — אין הרשאה`.

## Why apartment-admins are NOT the master admin

This needed to be explicit because earlier versions of the system blurred the line. Today:

- The **master admin** has its own login (the global Admin tab) backed by a singleton `admin_auth` row.
- **Apartment-admins** are simply apartment users (Tenant tab login) whose apartment has been granted admin privileges via the `apartment_admins` table. They have admin powers in the UI, but their **identity is the apartment**: their password lives in `apartments.password_hash`, their recovery email is in `apartment_recovery`, and their session has `apartmentId` set.
- An apartment-admin **cannot** rotate the master admin password (the `change-password` endpoint enforces this — `kind=admin` requires a session with no `apartmentId`).
- The master admin **can** reset any apartment's password via the Apartments management page (intentionally — they own the building's account hierarchy).

## Owner / renter / first-class owner

Each apartment is marked as **owner-occupied** or **rented**:

- **Owner-occupied** — the owner lives in the apartment. They sign in via the first-class owner flow only; there is no separate renter login.
- **Rented** — the renter signs in via the apartment dropdown. The property owner has their own independent login (first-class owner flow), with their own password and Google recovery account. Both owner and renter have identical view-only permissions.

Owners are first-class entities (`owners` table) linked to apartments via `apartment_owner_link` (one row per apartment). One owner can hold multiple apartments. When an apartment owned by an owner is granted apartment-admin, the owner's session inherits admin rights too.

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
│           ├── password.js        # client-side policy validator
│           └── views/             # dashboard, apartments, expenses, reminders,
│                                  # about, receipt, reports, settings, …
├── functions/                     # Cloudflare Pages Functions
│   ├── _middleware.js             # security headers + CSP + session prune
│   ├── lib/                       # crypto, session, audit, util, guard, drive,
│   │                              # password-stash, identity-oauth, admin2fa
│   └── api/
│       ├── auth/                  # login, logout, me, change-password,
│       │                          # reset-apartment, identity-init, identity-callback,
│       │                          # oauth-login-init, 2fa-*
│       ├── drive/                 # auth-init, auth-callback, status, disconnect
│       ├── settings/              # count-history, fee-history
│       ├── documents/             # proxy upload/download/delete via Drive
│       ├── admin/                 # reset, bulk-reset-passwords
│       └── *.js                   # apartments, owners, payments, expenses,
│                                  # contacts, apartment-adjustments,
│                                  # adjustment-payments, infrastructure-*,
│                                  # reminders, receipts, vaad-members,
│                                  # apartment-admin, audit, …
├── docs/                          # this documentation set
├── schema.sql                     # D1 schema — fully idempotent
├── wrangler.example.toml / wrangler.toml          # gitignored local copy
├── worker/                        # optional standalone monthly-cron Worker
├── package.example.json / package.json            # gitignored local copy
└── README.md / README.he.md
```
