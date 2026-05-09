// Expenses CRUD + rate history.

import { json, error, readJSON, pickStr, pickNum, isISODate, uid } from '../lib/util.js';
import { requireRead, requireAdmin } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `id, name, category, type, amount,
  start_date AS startDate, end_date AS endDate, bill_date AS billDate, one_off_date AS oneOffDate,
  notes, status`;

async function loadExpense(db, id) {
  const e = await db.prepare(`SELECT ${SAFE_FIELDS} FROM expenses WHERE id = ?`).bind(id).first();
  if (!e) return null;
  const rates = await db.prepare('SELECT id, effective_from AS effectiveFrom, amount FROM expense_rates WHERE expense_id = ? ORDER BY effective_from ASC').bind(id).all();
  e.rateHistory = rates.results;
  const links = await db.prepare("SELECT document_id AS id FROM document_links WHERE target_type = 'expense' AND target_id = ?").bind(id).all();
  e.documents = links.results.map(x => x.id);
  const auto = await db.prepare('SELECT 1 AS on_ FROM expense_auto_extend WHERE expense_id = ?').bind(id).first();
  e.autoExtend = !!auto?.on_;
  const dm = await db.prepare('SELECT method FROM expense_default_method WHERE expense_id = ?').bind(id).first();
  e.defaultMethod = dm?.method || null;
  const cl = await db.prepare('SELECT contact_id FROM expense_contact_link WHERE expense_id = ?').bind(id).first();
  e.contactId = cl?.contact_id || null;
  return e;
}

// Upserts (or clears) the contact link for an expense. Falsy contactId
// removes the row.
async function writeContactLink(db, expenseId, contactId) {
  if (contactId) {
    await db.prepare(
      'INSERT INTO expense_contact_link (expense_id, contact_id) VALUES (?, ?) ' +
      'ON CONFLICT(expense_id) DO UPDATE SET contact_id = excluded.contact_id'
    ).bind(expenseId, contactId).run();
  } else {
    await db.prepare('DELETE FROM expense_contact_link WHERE expense_id = ?').bind(expenseId).run();
  }
}

// Sets/clears the auto-extend flag for an expense. Pass `flag=true` to enable
// (the cron worker will push end_date forward each month), `false` to delete.
async function writeAutoExtend(db, expenseId, flag) {
  if (flag) {
    await db.prepare(
      'INSERT INTO expense_auto_extend (expense_id, last_extended_at) VALUES (?, NULL) ' +
      'ON CONFLICT(expense_id) DO NOTHING'
    ).bind(expenseId).run();
  } else {
    await db.prepare('DELETE FROM expense_auto_extend WHERE expense_id = ?').bind(expenseId).run();
  }
}

// Upserts (or clears) the default payment method for an expense. Falsy method
// removes the row.
async function writeDefaultMethod(db, expenseId, method) {
  const allowed = new Set(['bank', 'bit', 'check', 'cash', 'other']);
  if (method && allowed.has(method)) {
    await db.prepare(
      'INSERT INTO expense_default_method (expense_id, method) VALUES (?, ?) ' +
      'ON CONFLICT(expense_id) DO UPDATE SET method = excluded.method'
    ).bind(expenseId, method).run();
  } else {
    await db.prepare('DELETE FROM expense_default_method WHERE expense_id = ?').bind(expenseId).run();
  }
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const rows = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM expenses ORDER BY created_at DESC`).all();
  // Cache the auto-extend flag for all expenses in one query.
  const autoIds = new Set(
    (await env.DB.prepare('SELECT expense_id FROM expense_auto_extend').all())
      .results.map(r => r.expense_id)
  );
  // Same idea for default-method — fetch once and look up by id.
  const dmRows = (await env.DB.prepare('SELECT expense_id, method FROM expense_default_method').all()).results || [];
  const dmMap = new Map(dmRows.map(r => [r.expense_id, r.method]));
  // And contact links — single fetch.
  const clRows = (await env.DB.prepare('SELECT expense_id, contact_id FROM expense_contact_link').all()).results || [];
  const clMap = new Map(clRows.map(r => [r.expense_id, r.contact_id]));
  // Hydrate rate history + document links per expense
  const out = [];
  for (const e of rows.results) {
    const rates = await env.DB.prepare('SELECT id, effective_from AS effectiveFrom, amount FROM expense_rates WHERE expense_id = ? ORDER BY effective_from ASC').bind(e.id).all();
    e.rateHistory = rates.results;
    const links = await env.DB.prepare("SELECT document_id AS id FROM document_links WHERE target_type = 'expense' AND target_id = ?").bind(e.id).all();
    e.documents = links.results.map(x => x.id);
    e.autoExtend = autoIds.has(e.id);
    e.defaultMethod = dmMap.get(e.id) || null;
    e.contactId = clMap.get(e.id) || null;
    out.push(e);
  }
  return json({ expenses: out });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const name = pickStr(body.name, 200).trim();
  const type = pickStr(body.type, 16);
  const amount = pickNum(body.amount);
  if (!name || !type || amount == null) return error('שדות חובה חסרים', 400);
  if (!['monthly', 'annual', 'oneoff'].includes(type)) return error('סוג לא תקף', 400);

  const category = pickStr(body.category, 100);
  const status = pickStr(body.status, 20) || 'active';
  const notes = pickStr(body.notes, 1000);
  const startDate = isISODate(body.startDate) ? body.startDate : null;
  const endDate = isISODate(body.endDate) ? body.endDate : null;
  const billDate = isISODate(body.billDate) ? body.billDate : null;
  const oneOffDate = isISODate(body.oneOffDate) ? body.oneOffDate : null;
  if (type !== 'oneoff' && !startDate) return error('תאריך התחלה חסר', 400);
  if (type === 'oneoff' && !oneOffDate) return error('תאריך הוצאה חסר', 400);

  const id = uid('exp-');
  await env.DB.prepare('INSERT INTO expenses (id, name, category, type, amount, start_date, end_date, bill_date, one_off_date, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, category || null, type, amount, startDate, endDate, billDate, oneOffDate, notes || null, status).run();
  if (type === 'annual' && startDate) {
    await env.DB.prepare('INSERT INTO expense_rates (id, expense_id, effective_from, amount) VALUES (?, ?, ?, ?)')
      .bind(uid('rate-'), id, startDate, amount).run();
  }
  // Auto-extend only makes sense on monthly expenses with a bounded endDate.
  if (type === 'monthly' && endDate && body.autoExtend) {
    await writeAutoExtend(env.DB, id, true);
  }
  await writeDefaultMethod(env.DB, id, pickStr(body.defaultMethod, 16));
  await writeContactLink(env.DB, id, pickStr(body.contactId, 80));
  await logAudit(env.DB, request, { event: 'expense_created', role: 'admin', userLabel: 'מנהל', meta: { name, type, amount }, success: true });
  return json(await loadExpense(env.DB, id), { status: 201 });
};

export const onRequestPut = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const name = pickStr(body.name, 200).trim();
  const type = pickStr(body.type, 16);
  const amount = pickNum(body.amount);
  if (!name || !type || amount == null) return error('שדות חובה חסרים', 400);
  const updEndDate = isISODate(body.endDate) ? body.endDate : null;
  await env.DB.prepare(`UPDATE expenses SET name = ?, category = ?, type = ?, amount = ?, start_date = ?, end_date = ?, bill_date = ?, one_off_date = ?, notes = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(
      name,
      pickStr(body.category, 100) || null,
      type,
      amount,
      isISODate(body.startDate) ? body.startDate : null,
      updEndDate,
      isISODate(body.billDate) ? body.billDate : null,
      isISODate(body.oneOffDate) ? body.oneOffDate : null,
      pickStr(body.notes, 1000) || null,
      pickStr(body.status, 20) || 'active',
      id,
    ).run();
  // The auto-extend flag is only meaningful for monthly+bounded expenses.
  // Anything else: clear the flag (a paused/closed/non-monthly row shouldn't
  // be auto-extended even if it carried the flag from before).
  const wantAuto = type === 'monthly' && !!updEndDate && !!body.autoExtend;
  await writeAutoExtend(env.DB, id, wantAuto);
  await writeDefaultMethod(env.DB, id, pickStr(body.defaultMethod, 16));
  await writeContactLink(env.DB, id, pickStr(body.contactId, 80));
  await logAudit(env.DB, request, { event: 'expense_updated', role: 'admin', userLabel: 'מנהל', success: true });
  return json(await loadExpense(env.DB, id));
};

export const onRequestDelete = async ({ request, env }) => {
  const r = await requireAdmin(env, request); if (r.error) return r.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return error('id חסר', 400);
  await env.DB.prepare('DELETE FROM expenses WHERE id = ?').bind(id).run();
  await logAudit(env.DB, request, { event: 'expense_deleted', role: 'admin', userLabel: 'מנהל', success: true });
  return json({ ok: true });
};
