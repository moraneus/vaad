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
-- verified for the master admin. The "forgot password" flow re-runs Google
-- OAuth and grants reset only if the user signs in with this exact address.
-- This decouples identity verification from the Drive integration so:
--   * Drive can be connected with a different Google account (or skipped).
--   * No transactional-email service (Resend) is needed for password recovery.
CREATE TABLE IF NOT EXISTS admin_recovery (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- OAuth state nonces for the identity flow. Distinct from `oauth_state` (Drive)
-- because the purpose is encoded here: register (first verify), replace
-- (admin-session change to a new email), reset (anonymous forgot-password).
CREATE TABLE IF NOT EXISTS identity_oauth_state (
  state TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'replace', 'reset')),
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

-- One-time normalization (idempotent): the new model has only two derived
-- statuses (in_progress / done). Legacy 'closed' and 'paused' expense rows are
-- migrated by closing them with an end_date if one isn't already set. After
-- this runs once the expenses.status column is no longer consulted by the app.
UPDATE expenses
   SET end_date = date('now')
 WHERE status IN ('closed', 'paused')
   AND (end_date IS NULL OR end_date = '');
