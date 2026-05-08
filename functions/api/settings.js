// GET / PUT /api/settings — building name, address, opening balance, history of fee/count.
// History items: GET nested in payload; mutate via /api/settings/history endpoints? For simplicity, all in one PUT.

import { json, error, readJSON, pickStr, pickNum, isISODate, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

async function loadSettings(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows.results) map[r.key] = r.value;
  const counts = await db.prepare('SELECT id, effective_from AS effectiveFrom, count FROM apartment_count_history ORDER BY effective_from ASC').all();
  const fees = await db.prepare('SELECT id, effective_from AS effectiveFrom, amount FROM monthly_fee_history ORDER BY effective_from ASC').all();
  return {
    buildingName: map.building_name || 'בניין הוועד',
    buildingAddress: map.building_address || '',
    openingBalance: Number(map.opening_balance || 0),
    openingBalanceDate: map.opening_balance_date || new Date().toISOString().slice(0, 10),
    bankName: map.bank_name || '',
    bankBranch: map.bank_branch || '',
    bankAccountNumber: map.bank_account_number || '',
    bankAccountHolder: map.bank_account_holder || '',
    bankIban: map.bank_iban || '',
    bankNotes: map.bank_notes || '',
    bitPhone: map.bit_phone || '',
    bitHolder: map.bit_holder || '',
    bitNotes: map.bit_notes || '',
    payboxPhone: map.paybox_phone || '',
    payboxLink: map.paybox_link || '',
    payboxHolder: map.paybox_holder || '',
    payboxNotes: map.paybox_notes || '',
    aboutText: map.about_text || '',
    apartmentCountHistory: counts.results,
    monthlyFeeHistory: fees.results,
  };
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  return json(await loadSettings(env.DB));
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const db = env.DB;

  // Whitelist of settable keys. PUT may include only a subset — undefined keys
  // are skipped so partial updates (e.g., bank-only) don't clobber others.
  const candidates = [
    ['building_name',         body.buildingName,         (v) => pickStr(v, 200)],
    ['building_address',      body.buildingAddress,      (v) => pickStr(v, 300)],
    ['opening_balance',       body.openingBalance,       (v) => String(pickNum(v) ?? 0)],
    ['opening_balance_date',  body.openingBalanceDate,   (v) => isISODate(v) ? v : null],
    ['bank_name',             body.bankName,             (v) => pickStr(v, 200)],
    ['bank_branch',           body.bankBranch,           (v) => pickStr(v, 50)],
    ['bank_account_number',   body.bankAccountNumber,    (v) => pickStr(v, 50)],
    ['bank_account_holder',   body.bankAccountHolder,    (v) => pickStr(v, 200)],
    ['bank_iban',             body.bankIban,             (v) => pickStr(v, 50)],
    ['bank_notes',            body.bankNotes,            (v) => pickStr(v, 1000)],
    ['bit_phone',             body.bitPhone,             (v) => pickStr(v, 30)],
    ['bit_holder',            body.bitHolder,            (v) => pickStr(v, 200)],
    ['bit_notes',             body.bitNotes,             (v) => pickStr(v, 500)],
    ['paybox_phone',          body.payboxPhone,          (v) => pickStr(v, 30)],
    ['paybox_link',           body.payboxLink,           (v) => pickStr(v, 500)],
    ['paybox_holder',         body.payboxHolder,         (v) => pickStr(v, 200)],
    ['paybox_notes',          body.payboxNotes,          (v) => pickStr(v, 500)],
    ['about_text',            body.aboutText,            (v) => pickStr(v, 5000)],
  ];
  for (const [k, raw, fn] of candidates) {
    if (raw === undefined) continue;
    const v = fn(raw);
    if (v === null) continue;
    await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
      .bind(k, v).run();
  }
  await logAudit(db, request, { event: 'settings_updated', role: 'admin', userLabel: 'מנהל', success: true });
  return json(await loadSettings(db));
};

// Sub-endpoints exported as named handlers? In Pages Functions, we'd put them in
// /api/settings/history-count.js etc. Let's keep this single-file and add
// dedicated routes for history changes in separate files.
