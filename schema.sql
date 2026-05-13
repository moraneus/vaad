-- D1 schema for Vaad Bayit (building committee management)
-- Run with: wrangler d1 execute <your-d1-name> --file=./schema.sql --remote

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 100000,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS apartment_count_history (
  id TEXT PRIMARY KEY,
  effective_from TEXT NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monthly_fee_history (
  id TEXT PRIMARY KEY,
  effective_from TEXT NOT NULL,
  amount REAL NOT NULL
);

-- Per-apartment per-month fee override. When present, replaces the value from
-- monthly_fee_history for that single (apartment, year, month) cell. Used when
-- a particular apartment has a non-standard expected fee for a single month
-- (e.g. one-time surcharge or discount agreed with the owner). All "expected"
-- calculations check this table first and fall back to the global history.
CREATE TABLE IF NOT EXISTS apartment_monthly_fee_overrides (
  apartment_id TEXT NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  amount REAL NOT NULL,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (apartment_id, year, month)
);
CREATE INDEX IF NOT EXISTS idx_fee_override_ym ON apartment_monthly_fee_overrides(year, month);

CREATE TABLE IF NOT EXISTS apartments (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  owner TEXT,
  phone TEXT,
  notes TEXT,
  active_from TEXT,
  password_hash TEXT,
  password_salt TEXT,
  iterations INTEGER,
  password_set_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apartments_number ON apartments(number);

-- Property owners — first-class entity, independent of apartments. One owner
-- can hold multiple apartments; one apartment has exactly one owner. Login
-- credentials live here (an owner has a single account that spans all of
-- their apartments). Renter-occupant contact info still lives in `apartments`
-- + `apartment_occupancy`; this table is for the property owner only.
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,                    -- general contact email (display)
  login_email TEXT,              -- email used for login (lowercased; UNIQUE below)
  password_hash TEXT,
  password_salt TEXT,
  iterations INTEGER,
  password_set_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owners_login_email
  ON owners(login_email) WHERE login_email IS NOT NULL;

-- Multi-phone storage for owners. The legacy `owners.phone` column stays
-- (acts as the "primary" phone for backwards compat); rows here are the
-- additional phones an owner has registered, each with an optional `label`
-- (e.g., "אישה", "בן"). `sort_order` controls display order in the UI.
-- Replacement strategy on save: PUT /api/owners replaces all rows for that
-- owner_id with the array supplied in the body.
CREATE TABLE IF NOT EXISTS owner_phones (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  label       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_owner_phones_owner ON owner_phones(owner_id, sort_order);

-- Apartment ↔ Owner link. PK on apartment_id enforces "one apartment, one
-- owner". Many apartments can map to the same owner_id (multi-apartment owner).
-- ON DELETE RESTRICT on owner_id prevents deleting an owner who still holds
-- apartments (admin must reassign first).
CREATE TABLE IF NOT EXISTS apartment_owner_link (
  apartment_id TEXT PRIMARY KEY REFERENCES apartments(id) ON DELETE CASCADE,
  owner_id     TEXT NOT NULL    REFERENCES owners(id)     ON DELETE RESTRICT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_apt_owner_link_owner ON apartment_owner_link(owner_id);

-- Owner recovery identity (mirror of admin_recovery / apartment_recovery).
CREATE TABLE IF NOT EXISTS owner_recovery (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  email TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner password reset tokens (mirror of password_reset_tokens for owners).
CREATE TABLE IF NOT EXISTS owner_password_reset_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_pwr_token_hash ON owner_password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_owner_pwr_expires ON owner_password_reset_tokens(expires_at);

-- Per-session owner pointer for owner-mode logins (mode='owner'). loadSession
-- LEFT JOINs this so consumers see sess.ownerId. Cascades on session deletion.
CREATE TABLE IF NOT EXISTS session_owner (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE
);

-- Plaintext passwords (AES-GCM encrypted) stashed for admin-driven creates
-- and resets. Lets the admin re-display the password on demand instead of
-- once-only. Encrypted with SESSION_SECRET — same key + algorithm used for
-- the Drive refresh token. The hash in the user table remains the
-- authoritative authentication artefact; this stash is admin-visibility only.
-- Wiped when the user self-changes their password (via change-password).
--
-- scope: 'apartment-tenant' / 'apartment-owner-legacy' / 'owner'
-- scope_id: apartments.id or owners.id (or apartments.id for the legacy owner-per-apt flow)
CREATE TABLE IF NOT EXISTS user_password_secrets (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, scope_id)
);

-- One-time idempotent migration. For every apartment without an existing
-- owner link, create an owners row from the legacy fields and link it.
-- Re-running is a no-op (NOT EXISTS guards everything).
INSERT INTO owners (id, name, phone, email, password_hash, password_salt, iterations, password_set_at)
SELECT 'own-' || a.id,
       COALESCE(NULLIF(occ.owner_name, ''), NULLIF(a.owner, ''), 'בעלים דירה ' || a.number),
       COALESCE(NULLIF(occ.owner_phone, ''), NULLIF(a.phone, '')),
       NULLIF(occ.owner_email, ''),
       aoa.password_hash, aoa.password_salt, aoa.iterations, aoa.password_set_at
  FROM apartments a
  LEFT JOIN apartment_occupancy   occ ON occ.apartment_id = a.id
  LEFT JOIN apartment_owner_auth  aoa ON aoa.apartment_id = a.id
 WHERE NOT EXISTS (SELECT 1 FROM apartment_owner_link l WHERE l.apartment_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM owners o WHERE o.id = 'own-' || a.id);

INSERT INTO apartment_owner_link (apartment_id, owner_id)
SELECT a.id, 'own-' || a.id
  FROM apartments a
 WHERE NOT EXISTS (SELECT 1 FROM apartment_owner_link l WHERE l.apartment_id = a.id)
   AND EXISTS (SELECT 1 FROM owners o WHERE o.id = 'own-' || a.id);

-- Apartment occupancy metadata. Singleton-per-apartment. Stored separately
-- from `apartments` so adding the columns is idempotent (D1 doesn't support
-- conditional ALTER). When no row exists for an apartment, the apartment is
-- treated as owner-occupied (default).
--   occupant_type='owner'  → the resident in apartments.owner IS the property
--                            owner. owner_name/phone/email are unused.
--   occupant_type='renter' → the resident is a renter. owner_name/phone/email
--                            hold the contact info for the property owner who
--                            lives elsewhere.
CREATE TABLE IF NOT EXISTS apartment_occupancy (
  apartment_id TEXT PRIMARY KEY REFERENCES apartments(id) ON DELETE CASCADE,
  occupant_type TEXT NOT NULL DEFAULT 'owner' CHECK (occupant_type IN ('owner', 'renter')),
  owner_name TEXT,
  owner_phone TEXT,
  owner_email TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner credentials — only meaningful when occupant_type='renter' (since the
-- owner of an owner-occupied apartment uses the regular apartment login).
-- Lets the property owner sign in independently of the renter, for view-only
-- access to the same apartment data.
CREATE TABLE IF NOT EXISTS apartment_owner_auth (
  apartment_id TEXT PRIMARY KEY REFERENCES apartments(id) ON DELETE CASCADE,
  password_hash TEXT,
  password_salt TEXT,
  iterations INTEGER,
  password_set_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner recovery identity. Parallel to apartment_recovery but for the owner
-- credential set. The Google account verified here is used by the owner's
-- "forgot password" flow.
CREATE TABLE IF NOT EXISTS apartment_owner_recovery (
  apartment_id TEXT PRIMARY KEY REFERENCES apartments(id) ON DELETE CASCADE,
  email TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner password reset tokens. Parallel to apartment_password_reset_tokens.
-- Same shape, scoped to the owner credential set.
CREATE TABLE IF NOT EXISTS apartment_owner_password_reset_tokens (
  id TEXT PRIMARY KEY,
  apartment_id TEXT NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_apo_token_hash ON apartment_owner_password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_apo_expires ON apartment_owner_password_reset_tokens(expires_at);

-- Per-session user-kind tag. Sessions without a row here are treated as
-- 'tenant' (or 'admin' when sess.role='admin' && !apartmentId). A row with
-- user_kind='owner' marks the session as the apartment owner's, so the system
-- knows which credential set is in use for change-password / identity flows.
CREATE TABLE IF NOT EXISTS session_user_kind (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_kind TEXT NOT NULL DEFAULT 'tenant' CHECK (user_kind IN ('tenant', 'owner'))
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  apartment_id TEXT NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  amount REAL NOT NULL,
  paid_on TEXT,
  method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_apt_ym ON payments(apartment_id, year, month);
CREATE INDEX IF NOT EXISTS idx_payments_ym ON payments(year, month);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  type TEXT NOT NULL CHECK(type IN ('monthly', 'annual', 'oneoff')),
  amount REAL NOT NULL,
  start_date TEXT,
  end_date TEXT,
  bill_date TEXT,
  one_off_date TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expense_rates (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL,
  amount REAL NOT NULL
);

-- Actual expense payments (what was *really* paid, vs the definition).
-- Mirrors the income `payments` table — lets the reports distinguish
-- "expected" (from definitions/dates) vs "actual" (what was recorded as paid).
CREATE TABLE IF NOT EXISTS expense_payments (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  amount REAL NOT NULL,
  paid_on TEXT,
  method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expense_payments_exp_ym ON expense_payments(expense_id, year, month);
CREATE INDEX IF NOT EXISTS idx_expense_payments_ym ON expense_payments(year, month);

-- Opt-in flag for "auto-extend" on monthly expenses. When a row is present
-- here and the matching expense is type='monthly', the cron worker pushes
-- its end_date forward by one month every 1st of the month. This keeps the
-- "one row per active month" mental model while still being automatic.
-- last_extended_at is for diagnostics — the cron only acts if the current
-- end_date is BEFORE the last day of the current calendar month.
CREATE TABLE IF NOT EXISTS expense_auto_extend (
  expense_id        TEXT PRIMARY KEY REFERENCES expenses(id) ON DELETE CASCADE,
  last_extended_at  TEXT
);

-- Default payment method per expense. Pre-fills the method dropdown when the
-- admin records a child payment, so the common case (e.g., "always paid by
-- bank transfer") doesn't require setting it every month. Each child payment
-- can still override the method in its own row. Stored in a separate table
-- so the existing `expenses` schema stays untouched (CHECK + NOT NULL
-- columns can't be added idempotently in SQLite).
CREATE TABLE IF NOT EXISTS expense_default_method (
  expense_id TEXT PRIMARY KEY REFERENCES expenses(id) ON DELETE CASCADE,
  method     TEXT NOT NULL
);

-- Subtype tag for an expense — used when we want a logical type that the
-- existing `expenses.type` CHECK constraint doesn't allow ('installments'
-- in particular). The expense row stores the closest underlying type
-- (e.g., installments → 'monthly') and this table tags it so the frontend
-- can render the right label and the right form. Stored separately because
-- the CHECK constraint on the expenses table can't be widened idempotently
-- in SQLite without a full table rebuild.
CREATE TABLE IF NOT EXISTS expense_subtype (
  expense_id TEXT PRIMARY KEY REFERENCES expenses(id) ON DELETE CASCADE,
  subtype    TEXT NOT NULL
);

-- Optional link from an expense to a real contact in the contacts table.
-- Stored separately (rather than as a column on expenses) so the migration
-- stays additive + idempotent. The link is one-way: an expense has at most
-- one primary contact, but a contact can be referenced by many expenses.
-- ON DELETE CASCADE on expense_id cleans up the link when the expense goes
-- away. We deliberately don't FK-enforce contact_id so that deleting a
-- contact doesn't cascade-delete the link row — instead the frontend
-- reconciles by checking whether the contact still exists when rendering.
CREATE TABLE IF NOT EXISTS expense_contact_link (
  expense_id TEXT PRIMARY KEY REFERENCES expenses(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expense_contact_link_contact
  ON expense_contact_link(contact_id);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  name TEXT,
  role TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Multi-phone storage for contacts. Same shape as owner_phones — the legacy
-- contacts.phone column stays as the "primary" phone for display fallback,
-- and rows here are additional phones each with an optional `label` (e.g.,
-- "office", "after hours"). PUT /api/contacts replaces all rows for that
-- contact_id with the array supplied in the body.
CREATE TABLE IF NOT EXISTS contact_phones (
  id          TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  label       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contact_phones_contact ON contact_phones(contact_id, sort_order);

-- Documents metadata (binary lives in Google Drive)
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  drive_file_id TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  uploaded_by TEXT
);

-- Document display metadata. The filename in `documents.name` is preserved
-- (so the file in Drive keeps its original identity), but admins can give
-- documents a friendlier display name shown throughout the UI. Falls back
-- to documents.name when no display_name is set.
CREATE TABLE IF NOT EXISTS document_meta (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  display_name TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Google Drive connection (singleton row). Refresh token stored encrypted.
CREATE TABLE IF NOT EXISTS drive_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token_encrypted TEXT,
  refresh_token_iv TEXT,
  folder_id TEXT,
  folder_name TEXT NOT NULL DEFAULT 'vaad-docs',
  account_email TEXT,
  connected_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pending OAuth state (used by the redirect flow). Self-cleans by short TTL.
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_label TEXT
);

CREATE TABLE IF NOT EXISTS document_links (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('expense', 'payment')),
  target_id TEXT NOT NULL,
  PRIMARY KEY (document_id, target_type, target_id)
);

-- Infrastructure-expense ↔ documents linking. Kept in a separate table from
-- document_links because that table's CHECK(target_type IN ('expense','payment'))
-- can't be altered idempotently in SQLite. ON DELETE CASCADE on both sides
-- keeps orphan rows from accumulating.
CREATE TABLE IF NOT EXISTS infrastructure_expense_documents (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  expense_id  TEXT NOT NULL REFERENCES infrastructure_expenses(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, expense_id)
);
CREATE INDEX IF NOT EXISTS idx_infra_doc_expense
  ON infrastructure_expense_documents(expense_id);

-- Per-payment documents on `expense_payments`. Same reasoning as the
-- infrastructure table — the legacy document_links CHECK can't admit a new
-- target_type idempotently, so payment-level attachments live in a
-- dedicated table.
CREATE TABLE IF NOT EXISTS expense_payment_documents (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  payment_id   TEXT NOT NULL REFERENCES expense_payments(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, payment_id)
);
CREATE INDEX IF NOT EXISTS idx_exp_pay_doc_payment
  ON expense_payment_documents(payment_id);

-- Frozen state for individual expense_payments rows. A frozen payment keeps
-- its history (row + linked documents) but stops contributing to "actual
-- expenses" totals — useful when a payment was recorded prematurely or
-- in error and the admin wants to suppress it without losing the record.
-- Parallel-table pattern (rather than a new column) to keep schema.sql
-- idempotent across re-runs.
CREATE TABLE IF NOT EXISTS expense_payment_frozen (
  payment_id TEXT PRIMARY KEY REFERENCES expense_payments(id) ON DELETE CASCADE,
  frozen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-apartment manual adjustments (charges/credits) that affect the apartment
-- outstanding balance independently of monthly fees and payments.
--   kind = 'charge' adds to debt, 'credit' reduces debt (or creates a positive balance).
--   amount is always stored as a positive number; `kind` carries the sign.
CREATE TABLE IF NOT EXISTS apartment_adjustments (
  id TEXT PRIMARY KEY,
  apartment_id TEXT NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('charge', 'credit')),
  amount REAL NOT NULL,
  effective_date TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_adjustments_apt ON apartment_adjustments(apartment_id, effective_date);

-- Payments recorded against a specific charge (apartment_adjustment kind='charge').
-- Each row is a partial or full payment toward that charge. The remaining
-- amount on a charge = charge.amount - sum(adjustment_payments.amount).
CREATE TABLE IF NOT EXISTS adjustment_payments (
  id TEXT PRIMARY KEY,
  adjustment_id TEXT NOT NULL REFERENCES apartment_adjustments(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  paid_on TEXT NOT NULL,
  method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_adjustment_payments_adj ON adjustment_payments(adjustment_id);

-- Infrastructure expenses ("הוצאות תשתיתיות") — capital-style expenses paid
-- by the property owners (water heater replacement, structural repairs, etc.)
-- Conceptually distinct from monthly fees (regular operating expenses split
-- across renters too) and from one-off apartment_adjustments (which are
-- per-apartment by design). Each infrastructure expense splits its total
-- equally among all apartments by default; the admin can then edit each
-- apartment's share individually.
CREATE TABLE IF NOT EXISTS infrastructure_expenses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  total_amount REAL NOT NULL,
  expense_date TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-apartment payment demand for an infrastructure expense. One row per
-- (expense, apartment). amount is initially total/count but the admin can
-- override per-apartment.
CREATE TABLE IF NOT EXISTS infrastructure_demands (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES infrastructure_expenses(id) ON DELETE CASCADE,
  apartment_id TEXT NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(expense_id, apartment_id)
);
CREATE INDEX IF NOT EXISTS idx_infra_demand_apt ON infrastructure_demands(apartment_id);
CREATE INDEX IF NOT EXISTS idx_infra_demand_expense ON infrastructure_demands(expense_id);

-- Payments toward a specific infrastructure demand. Mirrors adjustment_payments.
CREATE TABLE IF NOT EXISTS infrastructure_payments (
  id TEXT PRIMARY KEY,
  demand_id TEXT NOT NULL REFERENCES infrastructure_demands(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  paid_on TEXT NOT NULL,
  method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_infra_pay_demand ON infrastructure_payments(demand_id);

-- Building committee (Vaad) members. Displayed publicly to tenants in the
-- "About" tab so they know who to contact and where to transfer payments.
CREATE TABLE IF NOT EXISTS vaad_members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vaad_members_order ON vaad_members(display_order, created_at);

-- Each vaad-member must be linked to an existing person (owner or apartment-
-- renter). The vaad_members table still stores a name/phone/email snapshot
-- so the committee card renders even if the linked entity changes; this
-- table records the link itself so the admin can pick from a curated list.
-- kind = 'owner' → linked_id is owners.id
-- kind = 'apartment' → linked_id is apartments.id (renter snapshot from
--   apartments.owner / apartments.phone / apartments.email).
-- ON DELETE CASCADE on member_id; we deliberately don't FK linked_id so a
-- deleted owner/apartment doesn't cascade-remove the committee row.
CREATE TABLE IF NOT EXISTS vaad_member_link (
  member_id  TEXT PRIMARY KEY REFERENCES vaad_members(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK(kind IN ('owner', 'apartment')),
  linked_id  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vaad_member_link_linked
  ON vaad_member_link(kind, linked_id);

-- Optional opt-in email per apartment for monthly reports / broadcasts. The
-- consent timestamp is recorded so the admin can prove opt-in if challenged
-- (Israeli anti-spam law, GDPR-equivalent).
CREATE TABLE IF NOT EXISTS apartment_email (
  apartment_id TEXT PRIMARY KEY REFERENCES apartments(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  consented_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Apartments that have been promoted to "admin" by an existing admin.
-- These users get the same privileges as the master admin (everything in the
-- system) when they log in with their apartment password. Membership in this
-- table is the sole source of truth for role='admin' on tenant logins.
CREATE TABLE IF NOT EXISTS apartment_admins (
  apartment_id TEXT PRIMARY KEY REFERENCES apartments(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by TEXT
);

-- Owner-level admin grants. An owner with a row here gets the admin role on
-- their first-class session, regardless of whether any of their apartments
-- are in apartment_admins. Mirrors apartment_admins shape so the session
-- role-derivation query stays simple. The two are independent: granting
-- owner-admin doesn't elevate any of the apartments' renter sessions.
CREATE TABLE IF NOT EXISTS owner_admins (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by TEXT
);

-- 2FA (TOTP, RFC 6238) for the master admin. Singleton row.
-- The TOTP secret is stored AES-GCM encrypted with SESSION_SECRET, so a
-- leaked DB backup alone doesn't expose the OTP seed.
-- backup_codes_json holds an array of { hash, used_at }; codes are SHA-256
-- hashed and only the hash is stored. Each code is single-use.
-- Password recovery tokens (admin only). Minted by the identity-OAuth callback
-- after Google verifies the requesting user owns the registered recovery email.
-- Stored as SHA-256 hash so a leaked DB doesn't expose live reset links.
-- Single-use, 30-minute expiry.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('admin')),
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_pwr_token_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_pwr_expires ON password_reset_tokens(expires_at);

-- Admin recovery identity. Singleton row. Holds the Google email Google has
-- verified for the MASTER admin only (not apartment-admins — those are
-- regular apartment users with admin grants and have their own recovery row
-- in apartment_recovery). The "forgot password" flow re-runs Google OAuth
-- and grants reset only if the user signs in with this exact address.
CREATE TABLE IF NOT EXISTS admin_recovery (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-apartment recovery identity. Each apartment can register its own Google
-- account that powers its "forgot password" flow. Independent of the
-- apartment's admin status — apartment-admins are simply apartments with an
-- admin grant; their identity is still per-apartment, NOT shared with the
-- master admin. The address can be the same as the apartment's general email
-- (apartment_email) but is verified separately via Google OAuth.
CREATE TABLE IF NOT EXISTS apartment_recovery (
  apartment_id TEXT PRIMARY KEY REFERENCES apartments(id) ON DELETE CASCADE,
  email TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-apartment password reset tokens. Separate from password_reset_tokens
-- (which is admin-only, and whose CHECK constraint can't be loosened
-- idempotently). Same shape, plus apartment_id to scope the reset.
CREATE TABLE IF NOT EXISTS apartment_password_reset_tokens (
  id TEXT PRIMARY KEY,
  apartment_id TEXT NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_apr_token_hash ON apartment_password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_apr_expires ON apartment_password_reset_tokens(expires_at);

-- OAuth state nonces for the identity flow. Distinct from `oauth_state` (Drive)
-- because purpose + scope are encoded here:
--   purpose: register (first verify), replace (logged-in change), reset (anonymous forgot-password)
--   scope:   'master' for master admin, 'apartment:<id>' for a specific apartment
--
-- Data here is ephemeral (30-minute TTL) so DROP+CREATE on each deploy is a
-- safe idempotent migration: in-flight OAuth flows simply need to be retried.
DROP TABLE IF EXISTS identity_oauth_state;
CREATE TABLE IF NOT EXISTS identity_oauth_state (
  state TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'replace', 'reset', 'login')),
  scope TEXT NOT NULL DEFAULT 'master',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_identity_state_created ON identity_oauth_state(created_at);

CREATE TABLE IF NOT EXISTS admin_2fa (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  totp_secret_encrypted TEXT,
  totp_secret_iv TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_activated_at TEXT,
  backup_codes_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO admin_2fa (id, totp_enabled) VALUES (1, 0);

-- Payment receipts. Each receipt has a globally-running serial number — once
-- assigned it is never reused, even if the receipt is deleted. Receipt covers
-- all payments for one (apartment, year, month). Each issuance creates a new
-- record with a new serial; downloads of an old receipt re-render from the
-- stored row (the snapshot of total/details at issue time is preserved).
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  serial INTEGER NOT NULL UNIQUE,
  apartment_id TEXT NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  apartment_number TEXT NOT NULL,
  apartment_owner TEXT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  total_amount REAL NOT NULL,
  payments_json TEXT,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  issued_by TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_apt ON receipts(apartment_id, year DESC, month DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_serial ON receipts(serial DESC);

-- Reminders that pop up in the bell + login modal until acknowledged.
-- Optionally linked to an expense (one reminder per expense at most).
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT,
  due_date TEXT NOT NULL,
  lead_days INTEGER NOT NULL DEFAULT 0,
  expense_id TEXT REFERENCES expenses(id) ON DELETE CASCADE,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reminders_active ON reminders(acknowledged_at, due_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_expense ON reminders(expense_id) WHERE expense_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  event TEXT NOT NULL,                -- login, login_failed, logout, password_change, reset_apartment, etc
  role TEXT,                          -- admin | tenant | (null for system)
  user_label TEXT,                    -- 'מנהל' | 'דירה X'
  apartment_id TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('admin', 'tenant')),
  apartment_id TEXT,
  user_label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Rate limit buckets (sliding window of attempts)
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  bucket TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ip, bucket)
);

-- Seed defaults: admin password = "1234" (must be changed)
-- The seed below uses a placeholder; the first /api/auth/init call will set the
-- real PBKDF2 hash. We insert a sentinel here so the table is non-empty.
INSERT OR IGNORE INTO admin_auth (id, password_hash, password_salt, iterations, updated_at)
VALUES (1, 'NEEDS_INIT', 'NEEDS_INIT', 100000, datetime('now'));

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('building_name', 'בניין הוועד'),
  ('building_address', ''),
  ('opening_balance', '0'),
  ('opening_balance_date', date('now')),
  ('bank_name', ''),
  ('bank_branch', ''),
  ('bank_account_number', ''),
  ('bank_account_holder', ''),
  ('bank_iban', ''),
  ('bank_notes', ''),
  ('bit_phone', ''),
  ('bit_holder', ''),
  ('bit_notes', ''),
  ('paybox_phone', ''),
  ('paybox_link', ''),
  ('paybox_holder', ''),
  ('paybox_notes', ''),
  ('about_text', ''),
  ('email_from_name', ''),
  ('email_subject_prefix', ''),
  ('initialized', '0');

INSERT OR IGNORE INTO apartment_count_history (id, effective_from, count) VALUES
  ('seed-1', date('now'), 9);

INSERT OR IGNORE INTO monthly_fee_history (id, effective_from, amount) VALUES
  ('seed-1', date('now'), 280);

-- ============================================================
-- Tickets / building-issue reports
-- ============================================================
-- Any logged-in user can open a ticket; only admins can close, reopen,
-- link an expense, or delete. Status is intentionally TEXT (not a CHECK
-- enum) so future statuses can be introduced without a schema migration.
CREATE TABLE IF NOT EXISTS tickets (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  -- One of the built-in category codes (electricity, cleaning, ...) or 'other'.
  category        TEXT NOT NULL,
  -- Free-text label used only when category='other'.
  custom_category TEXT,
  -- Snapshot of WHO opened the ticket. Kind = admin | owner | apartment-tenant.
  opened_by_kind  TEXT NOT NULL,
  opened_by_id    TEXT,
  opened_by_label TEXT NOT NULL,
  opened_at       TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at       TEXT,
  closed_by_label TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  -- Optional link to an expense (set by admin once a ticket results in a cost).
  expense_id      TEXT REFERENCES expenses(id) ON DELETE SET NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_opened_at ON tickets(opened_at);
CREATE INDEX IF NOT EXISTS idx_tickets_expense ON tickets(expense_id);

-- Comments thread on each ticket. Anyone logged in can comment; an author
-- (or admin) can delete their own comment. Snapshotted author label keeps
-- the thread readable even after the author's apartment/owner row changes.
CREATE TABLE IF NOT EXISTS ticket_comments (
  id            TEXT PRIMARY KEY,
  ticket_id     TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  author_kind   TEXT NOT NULL,
  author_id     TEXT,
  author_label  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket ON ticket_comments(ticket_id, created_at);

-- Image attachments. Same junction pattern as expense_payment_documents
-- to side-step the document_links CHECK constraint.
CREATE TABLE IF NOT EXISTS ticket_documents (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ticket_id   TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_doc_ticket ON ticket_documents(ticket_id);

-- Tracks which tickets each admin has already seen — drives the bell badge
-- and the "X new tickets" toast. last_seen_at is updated each time an admin
-- opens the tickets view; the unread count is computed as the number of
-- tickets created after that timestamp.
CREATE TABLE IF NOT EXISTS ticket_seen (
  admin_kind   TEXT NOT NULL,
  admin_id     TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (admin_kind, admin_id)
);

-- Pending email-verification challenges for activating the Resend channel.
-- We store the hashed code so the plaintext never lives in the DB.
CREATE TABLE IF NOT EXISTS resend_verification (
  -- Single-row table; key is always 'pending'.
  id           TEXT PRIMARY KEY DEFAULT 'pending',
  code_hash    TEXT NOT NULL,
  salt         TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed settings keys for the Resend email channel. Stored encrypted at rest;
-- the recipient email and status flag are plain.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('resend_api_key_enc',     ''),
  ('resend_api_key_iv',      ''),
  ('tickets_admin_email',    ''),
  ('tickets_email_status',   'disabled');

-- ============================================================
-- Document storage: dual-backend (Cloudflare R2 + Google Drive)
-- ============================================================
-- The legacy documents table has a NOT-NULL drive_file_id, which SQLite
-- can't loosen idempotently. We keep the column (R2 rows store ''), and
-- side-car the per-document storage info in a parallel table — the same
-- pattern already used by expense_subtype, expense_default_method, etc.
-- A document with no row in document_storage is treated as 'drive' so all
-- existing records keep working without backfill.
CREATE TABLE IF NOT EXISTS document_storage (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  -- 'r2', 'drive', or 'd1'. New uploads pick the active provider from settings.
  provider    TEXT NOT NULL,
  -- Object key within the R2 bucket (non-null when provider='r2', null
  -- otherwise so the Drive path uses documents.drive_file_id as before).
  -- D1-stored bytes live in document_d1_blobs keyed by document_id.
  r2_key      TEXT
);

-- D1-resident document bytes for accounts that can't or don't want to use
-- R2 or Drive. SQLite stores BLOBs natively; D1 supports them through bind.
-- Practical per-document size cap of ~5 MB — fine for ticket photos and
-- receipt PDFs, less suitable for very large scans.
CREATE TABLE IF NOT EXISTS document_d1_blobs (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  bytes       BLOB NOT NULL,
  stored_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed: storage_provider controls which backend NEW uploads use. D1 is the
-- default — no extra binding, no third-party account, no credit card on
-- file. R2 is preferred when actually wired up (10 GB free, zero egress)
-- and the admin can opt into it from Settings. Drive remains available as
-- a third option for installations that already use it.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('storage_provider', 'd1');

-- One-time normalization (idempotent): the new model has only two derived
-- statuses (in_progress / done). Legacy 'closed' and 'paused' expense rows are
-- migrated by closing them with an end_date if one isn't already set. After
-- this runs once the expenses.status column is no longer consulted by the app.
UPDATE expenses
   SET end_date = date('now')
 WHERE status IN ('closed', 'paused')
   AND (end_date IS NULL OR end_date = '');
