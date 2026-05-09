# Features & Languages

[← back to README](../README.md) · [עברית](./he/features.md)

## Features

- **Dashboard** — at-a-glance monthly / yearly numbers, 12-month trend chart, current bank balance.
- **Income tracking** — apartment × month grid with paid / partial / unpaid status; per-payment ledger; charge payments included as income. Both the **expected** and **paid** amounts are inline-editable per cell — overriding the expected amount for a single (apartment, month) cell flows automatically into all projection totals; a per-row delta badge shows debt or credit when the paid amount differs from the expected.
- **Expenses** — three types (monthly recurring, annual, one-off) with rate history, attachments, and per-period derived status (`In progress` / `Done`).
- **Per-apartment charges & credits** — manual debit/credit entries (e.g., past dues, refunds) that affect the outstanding balance independently of monthly fees, with their own payment ledger.
- **Infrastructure expenses** — capital-style expenses paid by the property owners (e.g. boiler replacement, structural repairs). Recording an infrastructure expense automatically distributes the total equally across all apartments as payment demands; each per-apartment amount can be edited individually. Payments and outstanding balances flow into the apartment's overall outstanding alongside monthly-fee debt.
- **Owner / renter occupancy** — each apartment is marked as owner-occupied or rented. Owner-occupied apartments use the first-class owner login only. Rented apartments expose a separate renter login alongside the owner login.
- **First-class owners** — owners are full entities (`owners` table) linked to apartments via `apartment_owner_link`. One owner can hold multiple apartments and signs in with one password regardless of how many apartments they own. Apartment-admin grants on any of those apartments propagate to the owner's session.
- **Independent owner login** — for renter apartments, the property owner can sign in with their own credentials (separate from the renter's), with their own password and their own Google recovery account. Both owner and renter sessions have identical view-only permissions.
- **Sign in with Google** — residents (renters and owners) and the master admin can choose to sign in with their Google account instead of a password. Admin sets the user's Google email when creating them; the user then clicks "Sign in with Google" on the login screen and lands directly inside. Reuses the same OAuth client used for password recovery — no extra setup.
- **Replace renter / replace owner** — when the resident or property owner of an apartment changes, the admin runs a per-role "Replace" action that wipes only the credentials + recovery account for that role. The apartment's full financial history (payments, debts, infrastructure demands) stays intact and is inherited by the incoming resident. There's no need to delete and recreate the apartment.
- **Admin-generated initial passwords** — admins create users with a generated random password (or set a custom one). The password is shown to the admin and stored encrypted, so it can be re-displayed later from the password manager. The user signs in with that password and may change it any time.
- **Bulk initial-password set** — admins can enter bulk-select mode on the apartment-passwords table, pick multiple apartments, and set the same initial password for all of them in one action.
- **Password manager (always-viewable)** — admin-set passwords are stashed AES-GCM-encrypted under `SESSION_SECRET`, so the admin can re-display them anytime instead of having to reset and notify users.
- **Document storage** — uploads streamed through Pages Functions to Google Drive; the browser never sees the OAuth token. Each document gets an admin-given **display name** (independent of the original filename, which is preserved in Drive).
- **Receipts** — printable receipts (saved as PDF via the browser print dialog) with a stable, globally-running serial number. Same apartment + same month always returns the same receipt.
- **Reminders** — persistent reminders with lead time. Show up in a header bell, in a login modal, or attached to specific expenses (contract renewals etc.).
- **About tab** — bank details for transfers + committee members + free-form notes. Visible to tenants for quick reference.
- **Reports** — monthly / yearly · cash-flow vs accounting view · CSV export · print to PDF.
- **Audit log** — every login, mutation, password change, and reset is logged with real client IP, User-Agent and timestamp.
- **Two-factor auth (2FA)** — optional TOTP for the master admin (Google Authenticator / Authy / 1Password). Includes single-use backup codes.
- **Email notifications** — opt-in per apartment. Admin can broadcast a custom message to all subscribed residents, or send the monthly report. Powered by Resend (free tier, 3,000 emails / month).
- **Automated monthly reports** — optional standalone Cloudflare Worker triggers the email report on the 1st of each month.
- **Password recovery via Google OAuth** — every account (master admin, renter, owner, apartment-admin) registers a Google account once; if they later forget their password they sign in with that Google account and set a new one. No outgoing email needed.

## Languages

The interface ships in **Hebrew** (default) and **English** with a built-in toggle in the header (and on the login screen). Layout direction switches automatically (RTL for Hebrew, LTR for English). The choice is saved in `localStorage` per browser. Currency, dates, numbers, and month names are all locale-aware.
