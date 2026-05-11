# Features & Languages

[← back to README](../README.md) · [עברית](./he/features.md)

## Features

### Income & charges
- **Dashboard** — at-a-glance monthly / yearly numbers, 12-month trend chart, current bank balance.
- **Income tracking** — apartment × month grid with paid / partial / unpaid status; per-payment ledger; charge payments included as income. Both the **expected** and **paid** amounts are inline-editable per cell — overriding the expected amount for a single (apartment, month) cell flows automatically into all projection totals; a per-row delta badge shows debt or credit when the paid amount differs from the expected.
- **Bulk mark paid** — on the apartments view, admin can enter bulk-select mode, pick multiple apartments, choose a month, and mark them all paid in one click. The system computes `remaining = expected − already paid` per apartment and skips ones already fully paid; one payment row is created per apartment.
- **Per-apartment charges & credits** — manual debit/credit entries (e.g., past dues, refunds) that affect the outstanding balance independently of monthly fees, with their own payment ledger.

### Expenses
- **Three expense types** — monthly recurring, annual (with rate history), and one-off — with attachments and a derived per-period status (`In progress` / `Done`).
- **Inline payment ledger per monthly expense** — every monthly expense row in the table gets an expand chevron. Clicking it reveals all recorded payments for that expense (newest first) with edit and delete buttons inline, plus an "Add payment" button. The localized payment-method label (`bank` → "העברה בנקאית") is shown per row.
- **Default payment method per expense** — pick the usual method when creating the expense (e.g., "always paid by bank transfer"). New child payments inherit it automatically; each individual payment can still override it.
- **Auto-extend monthly expenses** — opt-in checkbox on the monthly expense form. When enabled, a Cloudflare cron worker pushes the `endDate` forward to the last day of the current month every 1st. Each row covers exactly one active month and rolls itself over without admin intervention. Uncheck for fixed-term contracts.
- **Date-range filter & exports** — the expenses page has from/to date inputs with a single dropdown of presets (`This year`, `Last 3 months`, `Last year`, `All`, `Custom range`). The list filters in real time. Two export buttons next to the filter:
  - **CSV** — UTF-8 BOM, columns name / category / type / amount / period / status / docs. Excel-friendly Hebrew.
  - **PDF** — print-friendly view opened in a new tab; browser's print dialog → "Save as PDF". Includes the active range header + row count.

### Infrastructure
- **Infrastructure expenses** — capital-style expenses paid by the property owners (boiler replacement, structural repairs, etc.). The total is automatically split equally across all apartments as payment demands; each per-apartment share can be edited individually. Payments and outstanding balances flow into the apartment's overall outstanding alongside monthly-fee debt. Supporting documents (invoices, quotes, plans — images or PDFs) can be attached at create time or added later from the edit dialog; stored in Google Drive alongside regular expense attachments.

### Apartments & owners
- **Apartment numbers must be digits** — both client and server validate that the apartment number is a positive integer (the bulk operations, numeric sorting, and login dropdown all assume it).
- **Owner / renter occupancy** — each apartment is marked as owner-occupied or rented. Owner-occupied apartments use the first-class owner login only. Rented apartments expose a separate renter login alongside the owner login.
- **First-class owners** — owners are full entities (`owners` table) linked to apartments via `apartment_owner_link`. One owner can hold multiple apartments and signs in with one password regardless of how many apartments they own. Apartment-admin grants on any of those apartments propagate to the owner's session.
- **Multi-phone per owner** — each owner can register any number of phone numbers, each with an optional label (e.g. "spouse", "son"). All phones display in the apartments-and-charges table for owner-occupied apartments. The owner edit dialog has a dynamic add/remove list. Stored in a dedicated `owner_phones` table (idempotent additive migration).
- **Owners list — sort by apartment number** — the בעלי דירות tab defaults to sorting owners by their lowest apartment number (numeric collation; owners with no apartments at the bottom). A selector at the top of the table lets the admin switch to alphabetical-by-name. The "apartments" column shows the actual numbers each owner holds (e.g. "5, 12, 18"), not just a count.
- **Independent owner login** — for renter apartments, the property owner signs in with their own credentials (separate from the renter's), with their own password and their own Google recovery account. Both owner and renter sessions have identical view-only permissions.
- **Replace renter / replace owner** — when the resident or property owner of an apartment changes, the admin runs a per-role "Replace" action that wipes only the credentials + recovery account for that role. The apartment's full financial history stays intact and is inherited by the incoming resident.

### Auth & passwords
- **Sign in with Google** — residents (renters and owners) and the master admin can choose to sign in with their Google account instead of a password. Admin sets the user's Google email when creating them; the user clicks "Sign in with Google" on the login screen and lands directly inside.
- **Privacy-preserving login dropdown** — the public login screen identifies users by apartment number ("דירה 5" / "דירות 5, 12") instead of by real name, so the picker — visible to anyone visiting the site — never leaks who lives where.
- **Admin-generated initial passwords** — admins create users with a generated random password (or set a custom one). The password is shown to the admin and stored encrypted, so it can be re-displayed later from the password manager. The user signs in with that password and may change it any time.
- **Bulk initial-password set** — admins can enter bulk-select mode on the apartment-passwords table, pick multiple apartments, and set the same initial password for all of them in one action.
- **Password manager (always-viewable)** — admin-set passwords are stashed AES-GCM-encrypted under `SESSION_SECRET`, so the admin can re-display them anytime instead of having to reset and notify users.
- **Password recovery via Google OAuth** — every account (master admin, renter, owner, apartment-admin) registers a Google account once; if they later forget their password they sign in with that Google account and set a new one. No outgoing email needed.
- **Two-factor auth (2FA)** — optional TOTP for the master admin (Google Authenticator / Authy / 1Password). Includes single-use backup codes.

### Documents, receipts & reminders
- **Document storage** — uploads streamed through Pages Functions to Google Drive; the browser never sees the OAuth token. Each document gets an admin-given **display name** (independent of the original filename, which is preserved in Drive). Documents can also be attached from non-admin contexts (tenants uploading photos to their own open tickets).
- **Receipts** — printable receipts (saved as PDF via the browser print dialog) with a stable, globally-running serial number. Same apartment + same month always returns the same receipt.
- **Reminders** — persistent reminders with lead time. Show up in a header bell, in a login modal, or attached to specific expenses (contract renewals etc.).

### Tickets / building-issue reports
- **Open a ticket** — any logged-in user (admin, owner, or apartment tenant) can open a ticket with title, description, and a built-in category (electricity, plumbing, sewage, elevator, cleaning, garden, parking, security, intercom, renovation, other). Picking "other" reveals a free-text field for a custom label.
- **Photos** — attach images either via the device camera (mobile) or from the gallery / file system. Files are uploaded through the existing Drive pipeline; thumbnails appear inline on each card.
- **Comments thread** — anyone logged in can post a comment. Authors (or admins) can delete their own. Each comment shows author + timestamp.
- **Close / reopen** — admin-only actions. Closed tickets keep all their data and stay visible (filter by status: open / closed / all).
- **Link or create expense** — admin can either link an existing expense to a ticket, or open the standard expense-creation dialog from inside the ticket and have the newly-saved expense auto-linked back.
- **Filters** — search, category, status, and a date-range picker with the same presets (this year / last 3 months / last year / all / custom) used elsewhere.
- **Real-time admin notifier** — admin sessions poll every 20 seconds for new tickets and surface a toast when a count rises mid-session. Also drives a per-admin "seen" cursor so the badge resets after the admin opens the view.

### Reports & exports
- **Income report — CSV / PDF by month, year, or custom range** — the income view has a compact export toolbar (single dropdown of presets + from/to dates + CSV/PDF buttons). The export is a per-apartment × per-month grid (expected and paid) with row totals, footer per-month totals, and an extra adjustment-payment line when applicable.
- **Reports page — monthly / yearly / custom range** — a single dropdown switches between three modes: a one-month accounting summary, a yearly trend report, or a custom date-range aggregated report. The custom range mode shows top-line stats (income vs expected, expenses vs expected, balance), a per-month breakdown, and a per-category actual-spend table — all bounded by the picked dates.
- **Cash flow vs accounting view** — toggle that affects how annual expenses are presented. Cash flow lands the full annual amount in its bill month; accounting spreads it as 1/12 each month. Inline tooltips on each toggle explain the difference (and an ⓘ icon explains why both views look identical when no annual expenses exist).
- **CSV + PDF for every report** — CSV export uses UTF-8 BOM (Excel-friendly Hebrew); PDF is via the browser's print dialog.

### Other
- **About tab** — bank details for transfers + committee members + free-form notes. Visible to tenants for quick reference.
- **Audit log** — every login, mutation, password change, and reset is logged with real client IP, User-Agent and timestamp.
- **Email notifications** — opt-in per apartment. Admin can broadcast a custom message to all subscribed residents, or send the monthly report. Also drives the per-ticket admin alert. Powered by Resend (free tier, 3,000 emails / month).
- **Admin-uploadable Resend key** — instead of (or in addition to) the `RESEND_API_KEY` env-var, the admin can paste a key into the settings UI. It's stored encrypted (AES-GCM, derived from `SESSION_SECRET`) and never readable back. Activation requires a 6-digit verification code emailed to the configured recipient — proving both the key and the recipient mailbox are valid. Re-saving the key re-verifies.
- **Automated monthly cron** — optional standalone Cloudflare Worker fires once a month and triggers two housekeeping endpoints: auto-extend monthly expenses (above) and the monthly email report.

## Languages

The interface ships in **Hebrew** (default) and **English** with a built-in toggle in the header (and on the login screen). Layout direction switches automatically (RTL for Hebrew, LTR for English). The choice is saved in `localStorage` per browser. Currency, dates, numbers, and month names are all locale-aware.
