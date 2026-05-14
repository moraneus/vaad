// Contacts CRUD.

import { json, error, readJSON, pickStr, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const FIELDS = 'id, company, name, role, phone, email, notes';

// Loads multi-phone rows for one or many contacts. Returns Map<id, []> with
// each entry an ordered array of { id, label, phone }.
async function loadPhonesByContact(db, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const res = await db.prepare(
    `SELECT id, contact_id AS contactId, phone, label, sort_order AS sortOrder
       FROM contact_phones
      WHERE contact_id IN (${placeholders})
      ORDER BY contact_id, sort_order, created_at`
  ).bind(...ids).all();
  const byId = new Map();
  for (const row of (res.results || [])) {
    const arr = byId.get(row.contactId) || [];
    arr.push({ id: row.id, phone: row.phone, label: row.label || '' });
    byId.set(row.contactId, arr);
  }
  return byId;
}

// Replaces all contact_phones rows for `contactId` with the given array.
// Each entry: { phone, label }. Empty/whitespace phones are skipped.
async function replacePhones(db, contactId, phones) {
  await db.prepare('DELETE FROM contact_phones WHERE contact_id = ?').bind(contactId).run();
  if (!Array.isArray(phones) || !phones.length) return;
  let order = 0;
  for (const p of phones) {
    const phone = String(p?.phone || '').trim().slice(0, 30);
    if (!phone) continue;
    const label = String(p?.label || '').trim().slice(0, 80) || null;
    await db.prepare(
      'INSERT INTO contact_phones (id, contact_id, phone, label, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).bind(uid('cphn-'), contactId, phone, label, order++).run();
  }
}

// Bulk-loads bank details for a list of contact IDs. Map<contactId, obj>;
// contacts with no row are simply absent (the view treats that as "no bank
// details on file" rather than a separate state).
async function loadBankByContact(db, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const res = await db.prepare(
    `SELECT contact_id AS contactId, bank_name AS bankName, branch_number AS branchNumber,
            account_number AS accountNumber, beneficiary
       FROM contact_bank_details WHERE contact_id IN (${placeholders})`
  ).bind(...ids).all();
  const byId = new Map();
  for (const row of (res.results || [])) {
    byId.set(row.contactId, {
      bankName: row.bankName || '',
      branchNumber: row.branchNumber || '',
      accountNumber: row.accountNumber || '',
      beneficiary: row.beneficiary || '',
    });
  }
  return byId;
}

// Upsert (or clear) bank details for a contact. Falsy or all-empty input
// deletes the row entirely — keeps the table tidy.
async function writeBankDetails(db, contactId, b) {
  const bankName = String(b?.bankName || '').trim().slice(0, 100);
  const branchNumber = String(b?.branchNumber || '').trim().slice(0, 20);
  const accountNumber = String(b?.accountNumber || '').trim().slice(0, 40);
  const beneficiary = String(b?.beneficiary || '').trim().slice(0, 200);
  if (!bankName && !branchNumber && !accountNumber && !beneficiary) {
    await db.prepare('DELETE FROM contact_bank_details WHERE contact_id = ?').bind(contactId).run();
    return;
  }
  await db.prepare(
    'INSERT INTO contact_bank_details (contact_id, bank_name, branch_number, account_number, beneficiary, updated_at) ' +
    "VALUES (?, ?, ?, ?, ?, datetime('now')) " +
    'ON CONFLICT(contact_id) DO UPDATE SET bank_name = excluded.bank_name, branch_number = excluded.branch_number, ' +
    "account_number = excluded.account_number, beneficiary = excluded.beneficiary, updated_at = datetime('now')"
  ).bind(contactId, bankName || null, branchNumber || null, accountNumber || null, beneficiary || null).run();
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const rows = await env.DB.prepare(`SELECT ${FIELDS} FROM contacts ORDER BY company COLLATE NOCASE`).all();
  const contacts = rows.results || [];
  const ids = contacts.map(c => c.id);
  const phonesMap = await loadPhonesByContact(env.DB, ids);
  const bankMap = await loadBankByContact(env.DB, ids);
  for (const c of contacts) {
    c.phones = phonesMap.get(c.id) || [];
    c.bank = bankMap.get(c.id) || null;
  }
  return json({ contacts });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const company = pickStr(body.company, 200).trim();
  if (!company) return error('שם החברה חסר', 400);
  // Multi-phone payload (optional). When supplied, the first non-empty phone
  // is mirrored to the legacy contacts.phone column for display sites that
  // haven't migrated yet (and for Excel-style flat exports).
  const phones = Array.isArray(body.phones) ? body.phones : null;
  const explicitPhone = pickStr(body.phone, 30);
  const primaryPhone = phones?.find(p => String(p?.phone || '').trim())?.phone || explicitPhone;

  const id = uid('c-');
  await env.DB.prepare('INSERT INTO contacts (id, company, name, role, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, company, pickStr(body.name, 200) || null, pickStr(body.role, 100) || null, primaryPhone || null, pickStr(body.email, 200) || null, pickStr(body.notes, 1000) || null).run();
  if (phones) await replacePhones(env.DB, id, phones);
  if (body.bank && typeof body.bank === 'object') await writeBankDetails(env.DB, id, body.bank);
  await logAudit(env.DB, request, { event: 'contact_created', role: 'admin', userLabel: 'מנהל', meta: { company }, success: true });
  const row = await env.DB.prepare(`SELECT ${FIELDS} FROM contacts WHERE id = ?`).bind(id).first();
  const phonesMap = await loadPhonesByContact(env.DB, [id]);
  const bankMap = await loadBankByContact(env.DB, [id]);
  return json({ ...row, phones: phonesMap.get(id) || [], bank: bankMap.get(id) || null }, { status: 201 });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const company = pickStr(body.company, 200).trim();
  if (!company) return error('שם החברה חסר', 400);
  const phones = Array.isArray(body.phones) ? body.phones : null;
  const explicitPhone = pickStr(body.phone, 30);
  const primaryPhone = phones?.find(p => String(p?.phone || '').trim())?.phone || explicitPhone;
  await env.DB.prepare('UPDATE contacts SET company = ?, name = ?, role = ?, phone = ?, email = ?, notes = ? WHERE id = ?')
    .bind(company, pickStr(body.name, 200) || null, pickStr(body.role, 100) || null, primaryPhone || null, pickStr(body.email, 200) || null, pickStr(body.notes, 1000) || null, id).run();
  if (phones) await replacePhones(env.DB, id, phones);
  // bank: present (even if all-empty) → upsert/clear. Absent → leave the
  // existing row untouched. This way an edit dialog that doesn't render
  // the bank section can still PUT other fields without wiping bank info.
  if (Object.prototype.hasOwnProperty.call(body, 'bank')) {
    await writeBankDetails(env.DB, id, body.bank || {});
  }
  const row = await env.DB.prepare(`SELECT ${FIELDS} FROM contacts WHERE id = ?`).bind(id).first();
  const phonesMap = await loadPhonesByContact(env.DB, [id]);
  const bankMap = await loadBankByContact(env.DB, [id]);
  return json({ ...row, phones: phonesMap.get(id) || [], bank: bankMap.get(id) || null });
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(id).run();
  return json({ ok: true });
};
