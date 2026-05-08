// Expenses — 3 types: monthly, annual (with rate history), one-off

import { getExpenses, upsertExpense, deleteExpense, addExpenseRate, removeExpenseRate, getDocuments, uploadDocument, attachDocument, detachDocument, deleteDocument, upsertExpensePayment, deleteExpensePayment, getExpensePayments, getReminders, deleteReminder } from '../store.js';
import { api } from '../api.js';
import { fmtCurrency, esc, fmtDate, formatBytes, todayISO, sortHistory, monthKey, parseMonthKey } from '../utils.js';
import { t, monthName } from '../i18n.js';
import { knownCategories, expenseStatusForMonth, availableYears, expenseDerivedStatus } from '../calc.js';
import { setHTML, renderPageHeader, renderEmpty, openModal, confirmDialog, toast, requireAdmin, Icon, refreshBell } from '../ui.js';
import { getSession } from '../store.js';
import { openReminderDialog } from './reminders.js';

let filterType = 'all';
let filterStatus = 'all';
let filterCategory = 'all';
let searchTerm = '';

export function renderExpenses() {
  const main = document.getElementById('app-main');
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const all = getExpenses();
  const cats = ['all', ...knownCategories()];
  const filtered = all.filter(e => {
    if (filterType !== 'all' && e.type !== filterType) return false;
    if (filterStatus !== 'all' && expenseDerivedStatus(e) !== filterStatus) return false;
    if (filterCategory !== 'all' && (e.category || '') !== filterCategory) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      if (!(e.name || '').toLowerCase().includes(q) && !(e.notes || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  setHTML(main, `
    ${renderPageHeader({
      title: t('exp.title'),
      subtitle: t('exp.subtitle', { count: all.length }),
      actions: isAdmin ? `<button class="btn btn--primary" id="add-exp">${Icon.plus} ${esc(t('exp.add'))}</button>` : '',
    })}

    <div class="toolbar">
      <input class="input" id="search" placeholder="${esc(t('exp.searchPlaceholder'))}" value="${esc(searchTerm)}" style="width:220px" />
      <select class="select" id="f-type" style="width:170px">
        <option value="all">${esc(t('common.allTypes'))}</option>
        <option value="monthly" ${filterType==='monthly'?'selected':''}>${esc(t('exp.type.monthly'))}</option>
        <option value="annual" ${filterType==='annual'?'selected':''}>${esc(t('exp.type.annual'))}</option>
        <option value="oneoff" ${filterType==='oneoff'?'selected':''}>${esc(t('exp.type.oneoff'))}</option>
      </select>
      <select class="select" id="f-status" style="width:150px">
        <option value="all">${esc(t('common.allStatuses'))}</option>
        <option value="in_progress" ${filterStatus==='in_progress'?'selected':''}>${esc(t('exp.status.in_progress'))}</option>
        <option value="done" ${filterStatus==='done'?'selected':''}>${esc(t('exp.status.done'))}</option>
      </select>
      <select class="select" id="f-cat" style="width:170px">
        ${cats.map(c => `<option value="${esc(c)}" ${c === filterCategory ? 'selected' : ''}>${c === 'all' ? esc(t('common.allCategories')) : esc(c)}</option>`).join('')}
      </select>
      <div class="spacer"></div>
      <div class="muted">${filtered.length}</div>
    </div>

    ${filtered.length === 0 ? renderEmpty({
      title: t('exp.empty.title'),
      hint: all.length === 0 ? t('exp.empty.first') : t('exp.empty.adjustFilter'),
      action: isAdmin && all.length === 0 ? `<button class="btn btn--primary" id="add-exp-empty">${Icon.plus} ${esc(t('exp.add'))}</button>` : '',
    }) : `
      <div class="card card--padless">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>${esc(t('exp.col.name'))}</th>
                <th>${esc(t('common.category'))}</th>
                <th>${esc(t('exp.col.type'))}</th>
                <th class="num">${esc(t('common.amount'))}</th>
                <th>${esc(t('exp.col.period'))}</th>
                <th>${esc(t('common.status'))}</th>
                <th>${esc(t('exp.col.docs'))}</th>
                <th class="actions">${esc(t('common.actions'))}</th>
              </tr>
            </thead>
            <tbody>
              ${filtered.map(e => renderExpenseRow(e, isAdmin)).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `}
  `);

  document.getElementById('search').addEventListener('input', (e) => { searchTerm = e.target.value; renderExpenses(); });
  document.getElementById('f-type').addEventListener('change', (e) => { filterType = e.target.value; renderExpenses(); });
  document.getElementById('f-status').addEventListener('change', (e) => { filterStatus = e.target.value; renderExpenses(); });
  document.getElementById('f-cat').addEventListener('change', (e) => { filterCategory = e.target.value; renderExpenses(); });

  document.getElementById('add-exp')?.addEventListener('click', () => openExpenseDialog());
  document.getElementById('add-exp-empty')?.addEventListener('click', () => openExpenseDialog());

  document.querySelectorAll('[data-act="edit-exp"]').forEach(b => b.addEventListener('click', () => {
    const e = getExpenses().find(x => x.id === b.dataset.id);
    openExpenseDialog(e);
  }));
  document.querySelectorAll('[data-act="del-exp"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const e = getExpenses().find(x => x.id === b.dataset.id);
    const ok = await confirmDialog({ title: t('exp.delete.title'), message: t('exp.delete.message', { name: e.name }), confirmText: t('common.delete'), danger: true });
    if (ok) { try { await deleteExpense(e.id); toast(t('exp.deleted'), 'success'); renderExpenses(); } catch (err) { toast(err.message || t('common.error'), 'danger'); } }
  }));
  document.querySelectorAll('[data-act="rates"]').forEach(b => b.addEventListener('click', () => {
    const e = getExpenses().find(x => x.id === b.dataset.id);
    openRatesDialog(e);
  }));
  document.querySelectorAll('[data-act="docs"]').forEach(b => b.addEventListener('click', () => {
    const e = getExpenses().find(x => x.id === b.dataset.id);
    openExpenseDocsDialog(e);
  }));
  document.querySelectorAll('[data-act="ledger"]').forEach(b => b.addEventListener('click', () => {
    const e = getExpenses().find(x => x.id === b.dataset.id);
    openExpenseLedger(e);
  }));
}

function openExpenseLedger(exp) {
  const session = getSession();
  const isAdmin = session.role === 'admin';
  let ledgerYear = new Date().getFullYear();

  const m = openModal({
    title: t('exp.ledger.title', { name: exp.name }),
    size: 'lg',
    body: '<div id="ledger-content"></div>',
    footer: `
      ${isAdmin ? `<button class="btn btn--primary" data-act="add-pay">${Icon.plus} ${esc(t('exp.ledger.markPaid'))}</button>` : ''}
      <button class="btn" data-act="close">${esc(t('common.close'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="close"]').addEventListener('click', () => m.close());

  const refresh = () => {
    const c = m.bodyEl.querySelector('#ledger-content');
    let totalExpected = 0, totalActual = 0;
    const rows = [];
    for (let mn = 1; mn <= 12; mn++) {
      const st = expenseStatusForMonth(exp.id, ledgerYear, mn);
      totalExpected += st.expected;
      totalActual += st.actual;
      const badge =
        st.status === 'paid' ? `<span class="badge badge--success">${esc(t('reports.expense.paid'))}</span>` :
        st.status === 'partial' ? `<span class="badge badge--warning">${esc(t('reports.expense.partial'))}</span>` :
        st.status === 'unpaid' ? `<span class="badge badge--danger">${esc(t('reports.expense.unpaid'))}</span>` :
        '<span class="muted">—</span>';
      const remaining = st.expected - st.actual;
      const quickBtn = isAdmin && remaining > 0
        ? `<button class="btn btn--sm btn--accent" data-act="quick-epay" data-y="${ledgerYear}" data-m="${mn}" data-amt="${remaining}" title="${esc(t('exp.ledger.quickPay'))}">✓ ${esc(t('exp.ledger.quickPay'))} (${fmtCurrency(remaining)})</button>`
        : '';
      rows.push(`
        <tr>
          <td>${monthName(mn)} ${ledgerYear}</td>
          <td class="num muted">${st.expected > 0 ? fmtCurrency(st.expected) : '—'}</td>
          <td class="num text-success">${st.actual > 0 ? fmtCurrency(st.actual) : '—'}</td>
          <td>${badge}</td>
          <td>
            <div class="vstack" style="gap:6px">
              ${quickBtn}
              ${st.payments.map(p => `
                <div class="hstack" style="gap:6px; font-size:13px">
                  <span>${fmtCurrency(p.amount)} · ${fmtDate(p.paidOn)}</span>
                  ${isAdmin ? `<button class="btn btn--sm btn--icon" data-act="del-epay" data-pid="${p.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>` : ''}
                </div>
              `).join('')}
            </div>
          </td>
        </tr>
      `);
    }
    setHTML(c, `
      <div class="hstack" style="margin-bottom:14px; gap:14px; flex-wrap:wrap">
        <label class="muted">${esc(t('exp.ledger.year'))}</label>
        <select class="select" id="ledger-year" style="width:130px">
          ${availableYears().map(y => `<option ${y === ledgerYear ? 'selected' : ''} value="${y}">${y}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <div class="muted">${esc(t('exp.ledger.totalExpected'))} <strong>${fmtCurrency(totalExpected)}</strong></div>
        <div class="muted">${esc(t('exp.ledger.totalActual'))} <strong class="text-success">${fmtCurrency(totalActual)}</strong></div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>${esc(t('exp.ledger.col.month'))}</th>
              <th class="num">${esc(t('exp.ledger.col.expected'))}</th>
              <th class="num">${esc(t('exp.ledger.col.actual'))}</th>
              <th>${esc(t('exp.ledger.col.status'))}</th>
              <th>${esc(t('apt.ledger.payments'))}</th>
            </tr>
          </thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
    `);
    c.querySelector('#ledger-year').addEventListener('change', (ev) => {
      ledgerYear = Number(ev.target.value);
      refresh();
    });
    c.querySelectorAll('[data-act="del-epay"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      const ok = await confirmDialog({ title: t('exp.payment.delete.title'), message: t('exp.payment.delete.message'), danger: true, confirmText: t('common.delete') });
      if (!ok) return;
      try { await deleteExpensePayment(b.dataset.pid); toast(t('exp.payment.deleted'), 'success'); refresh(); renderExpenses(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }));
    // Quick mark-as-paid: one-click record of remaining amount with today's date.
    c.querySelectorAll('[data-act="quick-epay"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      b.disabled = true;
      const year = Number(b.dataset.y);
      const month = Number(b.dataset.m);
      const amount = Number(b.dataset.amt);
      try {
        await upsertExpensePayment({ expenseId: exp.id, year, month, amount, paidOn: todayISO(), method: 'bank' });
        toast(t('exp.ledger.quickPay.recorded', { amount: fmtCurrency(amount) }), 'success');
        refresh();
        renderExpenses();
      } catch (err) {
        toast(err.message || t('common.error'), 'danger');
        b.disabled = false;
      }
    }));
  };
  refresh();

  m.footerEl.querySelector('[data-act="add-pay"]')?.addEventListener('click', () => {
    openExpensePaymentDialog(exp, () => { refresh(); renderExpenses(); }, ledgerYear);
  });
}

function openExpensePaymentDialog(exp, onSaved, defaultYear = new Date().getFullYear()) {
  if (!requireAdmin()) return;
  const now = new Date();
  const defaultMonth = monthKey(defaultYear, now.getFullYear() === defaultYear ? now.getMonth() + 1 : 1);
  const monthsOptions = [];
  for (const y of availableYears()) {
    for (let mo = 1; mo <= 12; mo++) {
      const k = monthKey(y, mo);
      monthsOptions.push(`<option ${k === defaultMonth ? 'selected' : ''} value="${k}">${monthName(mo)} ${y}</option>`);
    }
  }
  // Suggest the expected amount as default (helpful when user pays the exact amount)
  const { year: dy, month: dm } = parseMonthKey(defaultMonth);
  const suggested = expenseStatusForMonth(exp.id, dy, dm).expected || exp.amount || '';

  const m = openModal({
    title: t('exp.payment.dialog.add', { name: exp.name }),
    body: `
      <form id="epay-form" class="form-grid">
        <div class="field field--required">
          <label class="field__label">${esc(t('exp.payment.field.month'))}</label>
          <select class="select" name="monthKey">${monthsOptions.join('')}</select>
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('exp.payment.field.amount'))}</label>
          <input class="input" name="amount" type="number" step="0.01" required value="${suggested || ''}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('exp.payment.field.date'))}</label>
          <input class="input" name="paidOn" type="date" value="${todayISO()}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('pay.field.method'))}</label>
          <select class="select" name="method">
            <option value="bank">${esc(t('pay.method.bank'))}</option>
            <option value="bit">${esc(t('pay.method.bit'))}</option>
            <option value="check">${esc(t('pay.method.check'))}</option>
            <option value="cash">${esc(t('pay.method.cash'))}</option>
            <option value="other">${esc(t('pay.method.other'))}</option>
          </select>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('common.notes'))}</label>
          <textarea class="textarea" name="notes" rows="2"></textarea>
        </div>
      </form>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save">${esc(t('common.save'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#epay-form');
    const data = Object.fromEntries(new FormData(f).entries());
    const { year, month } = parseMonthKey(data.monthKey);
    if (!data.amount) { toast(t('pay.amountRequired'), 'warning'); return; }
    try {
      await upsertExpensePayment({
        expenseId: exp.id,
        year, month,
        amount: Number(data.amount),
        paidOn: data.paidOn,
        method: data.method,
        notes: data.notes,
      });
      toast(t('exp.payment.recorded'), 'success');
      m.close();
      onSaved && onSaved();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

function renderExpenseRow(e, isAdmin) {
  const derived = expenseDerivedStatus(e);
  const status = derived === 'done'
    ? `<span class="badge badge--success">${Icon.check} ${esc(t('exp.status.done'))}</span>`
    : `<span class="badge badge--warning">${esc(t('exp.status.in_progress'))}</span>`;
  let period = '';
  if (e.type === 'monthly') {
    period = `${fmtDate(e.startDate)}${e.endDate ? ` → ${fmtDate(e.endDate)}` : ''}`;
  } else if (e.type === 'annual') {
    period = `${fmtDate(e.startDate)}${e.endDate ? ` → ${fmtDate(e.endDate)}` : ''}`;
    if (e.billDate) period += ` · ${fmtDate(e.billDate)}`;
  } else {
    period = fmtDate(e.oneOffDate);
  }
  const docCount = (e.documents || []).length;
  return `
    <tr>
      <td><strong>${esc(e.name)}</strong>${e.notes ? `<div class="muted" style="font-size:12px">${esc(e.notes)}</div>` : ''}</td>
      <td>${esc(e.category || '—')}</td>
      <td>${typeBadge(e.type)}${e.type === 'annual' && e.rateHistory && e.rateHistory.length > 1 ? ` <button class="btn btn--sm btn--ghost" data-act="rates" data-id="${e.id}">${esc(t('exp.rates.count', { n: e.rateHistory.length }))}</button>` : ''}</td>
      <td class="num">${fmtCurrency(e.amount)}${e.type === 'monthly' ? `<div class="muted" style="font-size:11px">${esc(t('exp.row.perMonth'))}</div>` : e.type === 'annual' ? `<div class="muted" style="font-size:11px">${esc(t('exp.row.perYear'))}</div>` : ''}</td>
      <td>${period}</td>
      <td>${status}</td>
      <td>
        <button class="btn btn--sm btn--ghost" data-act="docs" data-id="${e.id}">${Icon.document} ${docCount}</button>
      </td>
      <td class="actions">
        <button class="btn btn--sm" data-act="ledger" data-id="${e.id}" title="${esc(t('exp.ledger.label'))}">${esc(t('exp.ledger.label'))}</button>
        ${isAdmin && e.type === 'annual' ? `<button class="btn btn--sm" data-act="rates" data-id="${e.id}" title="${esc(t('exp.rates.label'))}">${esc(t('exp.rates.label'))}</button>` : ''}
        ${isAdmin ? `<button class="btn btn--sm btn--icon" data-act="edit-exp" data-id="${e.id}" title="${esc(t('common.edit'))}">${Icon.edit}</button>` : ''}
        ${isAdmin ? `<button class="btn btn--sm btn--icon" data-act="del-exp" data-id="${e.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>` : ''}
      </td>
    </tr>
  `;
}

function typeBadge(typ) {
  return typ === 'monthly' ? `<span class="badge badge--info">${esc(t('exp.type.monthly'))}</span>` :
         typ === 'annual' ? `<span class="badge badge--accent">${esc(t('exp.type.annual'))}</span>` :
         `<span class="badge">${esc(t('exp.type.oneoff'))}</span>`;
}

function openExpenseDialog(exp = null) {
  if (!requireAdmin()) return;
  const isEdit = !!exp;
  const ty = exp?.type || 'monthly';
  const cats = knownCategories();

  // Build a list of known payee names from previous expenses (most recent wins on duplicates)
  const allExpenses = getExpenses();
  const prevNames = [...new Set(allExpenses.map(e => e.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const prevByName = new Map();
  for (const e of allExpenses) {
    const k = (e.name || '').toLowerCase();
    if (!k) continue;
    if (!prevByName.has(k)) prevByName.set(k, e);
  }

  const m = openModal({
    title: isEdit ? t('exp.dialog.edit', { name: exp.name }) : t('exp.dialog.add'),
    size: 'lg',
    body: `
      <form id="exp-form" class="form-grid">
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('exp.field.type'))}</label>
          <div class="segmented" id="type-seg">
            <button type="button" class="segmented__opt ${ty==='monthly'?'segmented__opt--active':''}" data-type="monthly">${esc(t('exp.type.monthly'))}</button>
            <button type="button" class="segmented__opt ${ty==='annual'?'segmented__opt--active':''}" data-type="annual">${esc(t('exp.type.annual'))}</button>
            <button type="button" class="segmented__opt ${ty==='oneoff'?'segmented__opt--active':''}" data-type="oneoff">${esc(t('exp.type.oneoff'))}</button>
          </div>
          <input type="hidden" name="type" id="type-val" value="${ty}" />
        </div>

        <div class="field field--required">
          <label class="field__label">${esc(t('exp.field.name'))}</label>
          <input class="input" name="name" required value="${esc(exp?.name || '')}" list="prev-names" placeholder="${esc(t('exp.field.namePlaceholder'))}" autocomplete="off" />
          <datalist id="prev-names">${prevNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
          ${!isEdit && prevNames.length ? `<div class="field__hint">${esc(t('exp.field.namePrevHint'))}</div>` : ''}
          <div class="field__hint" id="autofill-hint" style="display:none; color:var(--c-success); font-weight:500"></div>
        </div>
        <div class="field">
          <label class="field__label">${esc(t('common.category'))}</label>
          <input class="input" name="category" list="cat-list" value="${esc(exp?.category || '')}" placeholder="${esc(t('exp.field.categoryPlaceholder'))}" />
          <datalist id="cat-list">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        </div>

        <div class="field field--required">
          <label class="field__label" id="lbl-amount">${esc(t('exp.field.amount'))}</label>
          <input class="input" name="amount" type="number" step="0.01" required value="${exp?.amount ?? ''}" />
          <div class="field__hint" id="hint-amount"></div>
        </div>

        <div class="field field--required" id="field-start">
          <label class="field__label" id="lbl-start">${esc(t('exp.field.startDate'))}</label>
          <input class="input" name="startDate" type="date" value="${esc(exp?.startDate || todayISO())}" />
        </div>
        <div class="field" id="field-end">
          <label class="field__label">${esc(t('exp.field.endDate'))}</label>
          <input class="input" name="endDate" type="date" value="${esc(exp?.endDate || '')}" />
        </div>
        <div class="field" id="field-bill" style="display:${ty==='annual'?'flex':'none'}">
          <label class="field__label">${esc(t('exp.field.billDate'))}</label>
          <input class="input" name="billDate" type="date" value="${esc(exp?.billDate || '')}" />
          <div class="field__hint">${esc(t('exp.field.billDateHint'))}</div>
        </div>
        <div class="field field--required" id="field-oneoff" style="display:${ty==='oneoff'?'flex':'none'}">
          <label class="field__label">${esc(t('exp.field.oneoffDate'))}</label>
          <input class="input" name="oneOffDate" type="date" value="${esc(exp?.oneOffDate || todayISO())}" />
        </div>

        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('common.notes'))}</label>
          <textarea class="textarea" name="notes" rows="2">${esc(exp?.notes || '')}</textarea>
        </div>

        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('exp.reminder.section'))}</label>
          <div id="reminder-area"></div>
        </div>

        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('exp.dialog.files'))}</label>
          <div class="field__hint">${esc(t('exp.dialog.filesHint'))}</div>
          <div id="existing-docs" style="margin-top:8px"></div>
          <div id="files-queue" style="display:flex; flex-direction:column; gap:6px; margin-top:8px"></div>
          <div style="margin-top:8px">
            <input type="file" id="exp-files-input" accept="image/*,application/pdf" multiple style="display:none" />
            <button type="button" class="btn btn--sm" id="add-files-btn">${Icon.upload} ${esc(t('exp.dialog.addFiles'))}</button>
          </div>
        </div>
      </form>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
    `,
  });

  // ----- File queue + existing attachments -----
  const pendingFiles = [];
  const queueEl = m.bodyEl.querySelector('#files-queue');
  const existingEl = m.bodyEl.querySelector('#existing-docs');
  const fileInput = m.bodyEl.querySelector('#exp-files-input');

  const renderQueue = () => {
    if (!pendingFiles.length) { setHTML(queueEl, ''); return; }
    setHTML(queueEl, `
      <div class="muted" style="font-size:12px">${esc(t('exp.dialog.filesPending', { n: pendingFiles.length }))}</div>
      ${pendingFiles.map((f, i) => `
        <div class="hstack" style="border:1px solid var(--c-border); padding:6px 10px; border-radius:8px; font-size:13px">
          <span>${Icon.document} ${esc(f.name)}</span>
          <span class="muted" style="font-size:12px">${formatBytes(f.size)}</span>
          <div class="spacer"></div>
          <button type="button" class="btn btn--sm btn--icon" data-rm-i="${i}" title="${esc(t('exp.dialog.removeFromQueue'))}">${Icon.trash}</button>
        </div>
      `).join('')}
    `);
    queueEl.querySelectorAll('[data-rm-i]').forEach(b => b.addEventListener('click', () => {
      pendingFiles.splice(Number(b.dataset.rmI), 1);
      renderQueue();
    }));
  };

  const renderExisting = () => {
    if (!exp || !(exp.documents || []).length) { setHTML(existingEl, ''); return; }
    const docs = (exp.documents || []).map(id => getDocuments().find(d => d.id === id)).filter(Boolean);
    if (!docs.length) { setHTML(existingEl, ''); return; }
    setHTML(existingEl, `
      <div class="vstack" style="gap:6px">
        ${docs.map(d => `
          <div class="hstack" style="border:1px solid var(--c-border); padding:6px 10px; border-radius:8px; font-size:13px">
            <span>${Icon.document} <a href="${api.documentURL(d.id)}" target="_blank" rel="noopener">${esc(d.name)}</a></span>
            <span class="muted" style="font-size:12px">${formatBytes(d.size)}</span>
            <div class="spacer"></div>
            <button type="button" class="btn btn--sm btn--icon" data-detach="${d.id}" title="${esc(t('exp.docs.detach.confirm'))}">${Icon.trash}</button>
          </div>
        `).join('')}
      </div>
    `);
    existingEl.querySelectorAll('[data-detach]').forEach(b => b.addEventListener('click', async () => {
      try {
        await detachDocument('expense', exp.id, b.dataset.detach);
        exp = getExpenses().find(x => x.id === exp.id) || exp;
        renderExisting();
        renderExpenses();
      } catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }));
  };
  renderExisting();

  m.bodyEl.querySelector('#add-files-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    for (const f of Array.from(fileInput.files || [])) pendingFiles.push(f);
    fileInput.value = '';
    renderQueue();
  });

  // ----- Reminder area: shows current reminder summary, or "+ add reminder" -----
  const remEl = m.bodyEl.querySelector('#reminder-area');
  const renderReminderArea = () => {
    if (!exp?.id) {
      // For not-yet-saved expenses we offer to add a reminder *after* save —
      // hint here, no inline button (we don't have an expense_id to link to yet).
      setHTML(remEl, `<div class="muted" style="font-size:13px">${esc(t('exp.reminder.add'))} ${esc('— ')}<em>${esc(t('exp.reminder.field.note'))}</em></div>`);
      return;
    }
    const rem = getReminders().find(r => r.expenseId === exp.id);
    if (!rem) {
      setHTML(remEl, `<button type="button" class="btn btn--sm" id="add-rem-btn">${Icon.plus} ${esc(t('exp.reminder.add'))}</button>`);
      remEl.querySelector('#add-rem-btn').addEventListener('click', () => {
        openReminderDialog(null, {
          lockedExpenseId: exp.id,
          defaultTitle: t('exp.reminder.titleDefault', { name: exp.name }),
          onSaved: () => renderReminderArea(),
        });
      });
      return;
    }
    setHTML(remEl, `
      <div class="hstack" style="border:1px solid var(--c-border); padding:8px 12px; border-radius:8px; background:var(--c-surface-alt)">
        <div>
          <div style="font-weight:600">${esc(rem.title)}</div>
          <div class="muted" style="font-size:12px">${esc(t('exp.reminder.summary', { date: fmtDate(rem.dueDate), n: rem.leadDays || 0 }))}</div>
        </div>
        <div class="spacer"></div>
        <button type="button" class="btn btn--sm" id="edit-rem-btn">${Icon.edit} ${esc(t('exp.reminder.edit'))}</button>
        <button type="button" class="btn btn--sm btn--icon" id="del-rem-btn" title="${esc(t('exp.reminder.remove'))}">${Icon.trash}</button>
      </div>
    `);
    remEl.querySelector('#edit-rem-btn').addEventListener('click', () => {
      openReminderDialog(rem, { lockedExpenseId: exp.id, onSaved: () => renderReminderArea() });
    });
    remEl.querySelector('#del-rem-btn').addEventListener('click', async () => {
      const ok = await confirmDialog({ title: t('exp.reminder.removeConfirm.title'), message: t('exp.reminder.removeConfirm.message'), danger: true, confirmText: t('common.delete') });
      if (!ok) return;
      try {
        await deleteReminder(rem.id);
        toast(t('exp.reminder.removed'), 'success');
        renderReminderArea();
        refreshBell();
      } catch (err) { toast(err.message || t('common.error'), 'danger'); }
    });
  };
  renderReminderArea();

  const setType = (newType) => {
    m.bodyEl.querySelector('#type-val').value = newType;
    m.bodyEl.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('segmented__opt--active', b.dataset.type === newType));
    m.bodyEl.querySelector('#field-bill').style.display = newType === 'annual' ? 'flex' : 'none';
    m.bodyEl.querySelector('#field-oneoff').style.display = newType === 'oneoff' ? 'flex' : 'none';
    m.bodyEl.querySelector('#field-start').style.display = newType === 'oneoff' ? 'none' : 'flex';
    m.bodyEl.querySelector('#field-end').style.display = newType === 'oneoff' ? 'none' : 'flex';
    const lbl = m.bodyEl.querySelector('#lbl-amount');
    const hint = m.bodyEl.querySelector('#hint-amount');
    lbl.textContent = newType === 'monthly' ? t('exp.field.amountMonthly') : newType === 'annual' ? t('exp.field.amountAnnual') : t('exp.field.amountOneoff');
    hint.textContent = newType === 'annual' ? t('exp.annualHint') : '';
  };
  setType(ty);
  m.bodyEl.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => setType(b.dataset.type)));

  // ----- Auto-fill from previous expense when picking an existing name -----
  const nameInput = m.bodyEl.querySelector('input[name="name"]');
  const autofillHint = m.bodyEl.querySelector('#autofill-hint');
  const tryAutofill = () => {
    const value = (nameInput.value || '').trim().toLowerCase();
    if (!value) { autofillHint.style.display = 'none'; return; }
    const prev = prevByName.get(value);
    // Skip if editing this same record (no point overwriting itself)
    if (!prev || prev.id === exp?.id) { autofillHint.style.display = 'none'; return; }
    // Fill category
    const catEl = m.bodyEl.querySelector('input[name="category"]');
    if (!catEl.value) catEl.value = prev.category || '';
    // Fill type (and update segmented UI + dependent fields)
    setType(prev.type);
    // Status
    const statusEl = m.bodyEl.querySelector('select[name="status"]');
    if (statusEl) statusEl.value = prev.status || 'active';
    // Notes — only fill if blank, to avoid clobbering user input
    const notesEl = m.bodyEl.querySelector('textarea[name="notes"]');
    if (notesEl && !notesEl.value) notesEl.value = prev.notes || '';
    // Bill date for annual expenses (only fill if blank)
    if (prev.type === 'annual' && prev.billDate) {
      const billEl = m.bodyEl.querySelector('input[name="billDate"]');
      if (billEl && !billEl.value) billEl.value = prev.billDate;
    }
    // End date — only if user hasn't typed one
    if (prev.endDate) {
      const endEl = m.bodyEl.querySelector('input[name="endDate"]');
      if (endEl && !endEl.value) endEl.value = prev.endDate;
    }
    autofillHint.textContent = '✓ ' + t('exp.dialog.filledFromPrev');
    autofillHint.style.display = 'block';
  };
  // 'change' fires on blur or after datalist selection
  nameInput.addEventListener('change', tryAutofill);
  // 'input' catches direct datalist clicks in some browsers
  nameInput.addEventListener('input', () => {
    // Only run if value exactly matches an existing name (datalist pick), not for partial typing
    if (prevByName.has((nameInput.value || '').trim().toLowerCase())) tryAutofill();
  });

  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#exp-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!data.name) { toast(t('exp.nameRequired'), 'warning'); return; }
    if (!data.amount) { toast(t('exp.amountRequired'), 'warning'); return; }
    if (data.type !== 'oneoff' && !data.startDate) { toast(t('exp.startDateRequired'), 'warning'); return; }
    if (data.type === 'oneoff' && !data.oneOffDate) { toast(t('exp.oneoffDateRequired'), 'warning'); return; }
    if (data.endDate === '') data.endDate = null;
    const saveBtn = m.footerEl.querySelector('[data-act="save"]');
    saveBtn.disabled = true;
    try {
      const saved = await upsertExpense({ id: exp?.id, ...data, amount: Number(data.amount) });
      const expenseId = saved?.id || exp?.id;
      // Upload queued files (best effort — surface failures via toast)
      let uploadFails = 0;
      for (const file of pendingFiles) {
        try { await uploadDocument(file, { type: 'expense', id: expenseId }); }
        catch (err) { uploadFails++; toast(`${file.name}: ${err.message || t('common.error')}`, 'danger'); }
      }
      if (uploadFails === 0) toast(isEdit ? t('exp.updated') : t('exp.added'), 'success');
      m.close();
      renderExpenses();
    } catch (err) {
      toast(err.message || t('common.error'), 'danger');
      saveBtn.disabled = false;
    }
  });
}

function openRatesDialog(exp) {
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const m = openModal({
    title: t('exp.rates.title', { name: exp.name }),
    body: '<div id="rates-content"></div>',
    footer: `
      ${isAdmin ? `<button class="btn btn--primary" data-act="add">${Icon.plus} ${esc(t('exp.rates.add'))}</button>` : ''}
      <button class="btn" data-act="close">${esc(t('common.close'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="close"]').addEventListener('click', () => m.close());
  const refresh = () => {
    const c = m.bodyEl.querySelector('#rates-content');
    const rates = sortHistory(exp.rateHistory || []);
    setHTML(c, `
      <p class="muted" style="margin-top:0">${esc(t('exp.rates.hint'))}</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>${esc(t('exp.rates.from'))}</th><th class="num">${esc(t('exp.rates.amountAnnual'))}</th>${isAdmin ? `<th class="actions"></th>` : ''}</tr></thead>
          <tbody>
            ${rates.map(r => `
              <tr>
                <td>${fmtDate(r.from || r.effectiveFrom)}</td>
                <td class="num">${fmtCurrency(r.amount)}</td>
                ${isAdmin ? `<td class="actions">${rates.length > 1 ? `<button class="btn btn--sm btn--icon" data-act="rm" data-rid="${r.id}">${Icon.trash}</button>` : ''}</td>` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `);
    c.querySelectorAll('[data-act="rm"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      const ok = await confirmDialog({ title: t('exp.rates.delete.title'), message: t('exp.rates.delete.message'), danger: true, confirmText: t('common.delete') });
      if (ok) {
        try {
          if (await removeExpenseRate(exp.id, b.dataset.rid)) {
            toast(t('exp.rates.deleted'), 'success'); exp = getExpenses().find(x => x.id === exp.id); refresh(); renderExpenses();
          } else toast(t('exp.rates.cantDeleteLast'), 'warning');
        } catch (err) { toast(err.message || t('common.error'), 'danger'); }
      }
    }));
  };
  refresh();
  m.footerEl.querySelector('[data-act="add"]')?.addEventListener('click', () => {
    const m2 = openModal({
      title: t('exp.rates.add'),
      body: `
        <form id="rate-form" class="form-grid">
          <div class="field field--required">
            <label class="field__label">${esc(t('exp.rates.from'))}</label>
            <input class="input" name="from" type="date" required value="${todayISO()}" />
          </div>
          <div class="field field--required">
            <label class="field__label">${esc(t('exp.rates.amountAnnual'))} (ILS)</label>
            <input class="input" name="amount" type="number" step="0.01" required />
          </div>
        </form>
      `,
      footer: `<button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button><button class="btn btn--primary" data-act="ok">${esc(t('common.add'))}</button>`,
    });
    m2.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m2.close());
    m2.footerEl.querySelector('[data-act="ok"]').addEventListener('click', async () => {
      const f = m2.bodyEl.querySelector('#rate-form');
      const d = Object.fromEntries(new FormData(f).entries());
      if (!d.from || !d.amount) { toast(t('settings.fillAll'), 'warning'); return; }
      try {
        await addExpenseRate(exp.id, { from: d.from, amount: Number(d.amount) });
        m2.close();
        exp = getExpenses().find(x => x.id === exp.id);
        refresh();
        renderExpenses();
        toast(t('exp.rates.added'), 'success');
      } catch (err) { toast(err.message || t('common.error'), 'danger'); }
    });
  });
}

function openExpenseDocsDialog(exp) {
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const m = openModal({
    title: t('exp.docs.title', { name: exp.name }),
    body: '<div id="docs-content"></div>',
    footer: `
      ${isAdmin ? `<button class="btn btn--primary" data-act="upload">${Icon.upload} ${esc(t('common.upload'))}</button>` : ''}
      <button class="btn" data-act="close">${esc(t('common.close'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="close"]').addEventListener('click', () => m.close());

  const refresh = () => {
    exp = getExpenses().find(x => x.id === exp.id) || exp;
    const docs = (exp.documents || []).map(id => getDocuments().find(d => d.id === id)).filter(Boolean);
    const c = m.bodyEl.querySelector('#docs-content');
    setHTML(c, docs.length === 0 ? `<p class="muted">${esc(t('exp.docs.empty'))}</p>` : `
      <div class="vstack">
        ${docs.map(d => `
          <div class="hstack" style="border:1px solid var(--c-border); padding:10px 12px; border-radius:10px">
            <div>
              <div style="font-weight:600">${esc(d.name)}</div>
              <div class="muted" style="font-size:12px">${formatBytes(d.size)} · ${fmtDate(d.uploadedAt)}</div>
            </div>
            <div class="spacer"></div>
            <a class="btn btn--sm" href="${api.documentURL(d.id)}" download="${esc(d.name)}">${Icon.download} ${esc(t('common.download'))}</a>
            <a class="btn btn--sm" href="${api.documentURL(d.id)}" target="_blank" rel="noopener">${esc(t('common.view'))}</a>
            ${isAdmin ? `<button class="btn btn--sm btn--icon" data-act="detach" data-did="${d.id}" title="${esc(t('exp.docs.detach.confirm'))}">${Icon.trash}</button>` : ''}
          </div>
        `).join('')}
      </div>
    `);
    c.querySelectorAll('[data-act="detach"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      const ok = await confirmDialog({ title: t('exp.docs.detach.title'), message: t('exp.docs.detach.message'), confirmText: t('exp.docs.detach.confirm'), danger: true });
      if (ok) { try { await detachDocument('expense', exp.id, b.dataset.did); refresh(); toast(t('exp.docs.detached'), 'success'); renderExpenses(); } catch (err) { toast(err.message || t('common.error'), 'danger'); } }
    }));
  };
  refresh();

  m.footerEl.querySelector('[data-act="upload"]')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await uploadDocument(file, { type: 'expense', id: exp.id });
        toast(t('exp.docs.uploaded'), 'success');
        refresh();
        renderExpenses();
      } catch (err) { toast(err.message || t('exp.docs.uploadFailed'), 'danger'); }
    });
    input.click();
  });
}
