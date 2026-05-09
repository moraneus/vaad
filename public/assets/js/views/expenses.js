// Expenses — 3 types: monthly, annual (with rate history), one-off

import { getExpenses, upsertExpense, deleteExpense, addExpenseRate, removeExpenseRate, getDocuments, uploadDocument, attachDocument, detachDocument, deleteDocument, upsertExpensePayment, deleteExpensePayment, getExpensePayments, getReminders, deleteReminder, getContacts, upsertContact } from '../store.js';
import { api } from '../api.js';
import { fmtCurrency, esc, fmtDate, formatBytes, todayISO, sortHistory, monthKey, parseMonthKey, isMonthInRange, downloadBlob } from '../utils.js';
import { t, monthName } from '../i18n.js';
import { knownCategories, expenseStatusForMonth, availableYears, expenseDerivedStatus } from '../calc.js';
import { setHTML, renderPageHeader, renderEmpty, openModal, confirmDialog, toast, requireAdmin, Icon, refreshBell } from '../ui.js';
import { getSession } from '../store.js';
import { openReminderDialog } from './reminders.js';

let filterType = 'all';
let filterStatus = 'all';
let filterCategory = 'all';
let searchTerm = '';
// Date-range filter — admin picks a [from..to] window and the list shows
// only expenses with an obligation inside that window. Defaults to the
// current calendar year on first load (computed lazily below).
let filterFrom = null;
let filterTo = null;

export function renderExpenses() {
  const main = document.getElementById('app-main');
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const all = getExpenses();
  const cats = ['all', ...knownCategories()];
  // First-time initialization: default the range to the current calendar
  // year (Jan 1 → Dec 31). The admin can narrow this with the date pickers
  // or quick-preset buttons.
  if (filterFrom === null && filterTo === null) {
    const y = new Date().getFullYear();
    filterFrom = `${y}-01-01`;
    filterTo = `${y}-12-31`;
  }

  // An expense matches the date range if it has at least one obligation
  // inside [from..to]:
  //   - monthly: any month in the range falls within [startDate..endDate]
  //   - annual:  the range covers the (year+billMonth) of any year in
  //              [startDate..endDate]
  //   - oneoff:  oneOffDate is inside the range
  const fromTime = filterFrom ? new Date(filterFrom).getTime() : null;
  const toTime = filterTo ? new Date(filterTo + 'T23:59:59').getTime() : null;
  const inRange = (iso) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return (fromTime === null || t >= fromTime) && (toTime === null || t <= toTime);
  };
  const dateMatches = (e) => {
    if (!fromTime && !toTime) return true;
    if (e.type === 'oneoff') return inRange(e.oneOffDate);
    if (e.type === 'monthly') {
      // Range overlap: expense range [startDate..endDate or +inf] vs filter
      // range [from..to]. They overlap iff startDate <= to AND (endDate is
      // null OR endDate >= from).
      const sT = e.startDate ? new Date(e.startDate).getTime() : -Infinity;
      const eT = e.endDate ? new Date(e.endDate + 'T23:59:59').getTime() : Infinity;
      const f = fromTime ?? -Infinity;
      const tt = toTime ?? Infinity;
      return sT <= tt && eT >= f;
    }
    if (e.type === 'annual') {
      // Walk each year between startDate and endDate (or filter range), check
      // whether the bill date in that year falls inside [from..to].
      const sT = e.startDate ? new Date(e.startDate).getTime() : null;
      const eT = e.endDate ? new Date(e.endDate + 'T23:59:59').getTime() : null;
      if (!e.billDate) {
        // No bill date — fall back to range-overlap like monthly.
        const f = fromTime ?? -Infinity;
        const tt = toTime ?? Infinity;
        return (sT ?? -Infinity) <= tt && (eT ?? Infinity) >= f;
      }
      const billMonth = new Date(e.billDate).getMonth();
      const billDay = new Date(e.billDate).getDate();
      const fromYear = new Date(filterFrom || e.startDate || `${new Date().getFullYear()}-01-01`).getFullYear();
      const toYear = new Date(filterTo || e.endDate || `${new Date().getFullYear()}-12-31`).getFullYear();
      for (let y = fromYear; y <= toYear; y++) {
        const t = new Date(y, billMonth, billDay).getTime();
        if (sT && t < sT) continue;
        if (eT && t > eT) continue;
        if (inRange(`${y}-${String(billMonth + 1).padStart(2, '0')}-${String(billDay).padStart(2, '0')}`)) return true;
      }
      return false;
    }
    return true;
  };
  const filtered = all.filter(e => {
    if (filterType !== 'all' && e.type !== filterType) return false;
    if (filterStatus !== 'all' && expenseDerivedStatus(e) !== filterStatus) return false;
    if (filterCategory !== 'all' && (e.category || '') !== filterCategory) return false;
    if (!dateMatches(e)) return false;
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

    <div class="toolbar" style="margin-top:-6px; gap:6px; flex-wrap:nowrap; overflow-x:auto">
      <select class="select" id="f-preset" style="width:auto" title="${esc(t('income.export.preset.title'))}">
        <option value="custom">${esc(t('income.export.preset.custom'))}</option>
        <option value="thisYear">${esc(t('exp.filter.preset.thisYear'))}</option>
        <option value="last3">${esc(t('exp.filter.preset.last3'))}</option>
        <option value="lastYear">${esc(t('exp.filter.preset.lastYear'))}</option>
        <option value="all">${esc(t('exp.filter.preset.all'))}</option>
      </select>
      <input class="input" id="f-from" type="date" value="${esc(filterFrom || '')}" style="width:140px" title="${esc(t('exp.filter.from'))}" />
      <input class="input" id="f-to" type="date" value="${esc(filterTo || '')}" style="width:140px" title="${esc(t('exp.filter.to'))}" />
      <div class="spacer"></div>
      ${isAdmin ? `
        <button class="btn btn--sm" id="exp-export-csv" title="${esc(t('exp.export.csvHint'))}" style="white-space:nowrap">${Icon.download} ${esc(t('exp.export.csv'))}</button>
        <button class="btn btn--sm" id="exp-export-pdf" title="${esc(t('exp.export.pdfHint'))}" style="white-space:nowrap">${Icon.document} ${esc(t('exp.export.pdf'))}</button>
      ` : ''}
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
  // Manual date edits flip the preset back to "custom" so the dropdown
  // always reflects the actual range in effect.
  const presetSel = document.getElementById('f-preset');
  const flipToCustom = () => { if (presetSel) presetSel.value = 'custom'; };
  document.getElementById('f-from')?.addEventListener('change', (e) => { filterFrom = e.target.value || null; flipToCustom(); renderExpenses(); });
  document.getElementById('f-to')?.addEventListener('change', (e) => { filterTo = e.target.value || null; flipToCustom(); renderExpenses(); });
  presetSel?.addEventListener('change', () => {
    const today = new Date();
    const y = today.getFullYear();
    const v = presetSel.value;
    if (v === 'thisYear') {
      filterFrom = `${y}-01-01`; filterTo = `${y}-12-31`;
    } else if (v === 'lastYear') {
      filterFrom = `${y - 1}-01-01`; filterTo = `${y - 1}-12-31`;
    } else if (v === 'last3') {
      const back = new Date(today);
      back.setMonth(today.getMonth() - 2);
      back.setDate(1);
      filterFrom = `${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, '0')}-01`;
      filterTo = todayISO();
    } else if (v === 'all') {
      filterFrom = null; filterTo = null;
    }
    // 'custom' leaves filterFrom/filterTo as-is.
    renderExpenses();
  });
  document.getElementById('exp-export-csv')?.addEventListener('click', () => exportExpensesCSV(filtered));
  document.getElementById('exp-export-pdf')?.addEventListener('click', () => exportExpensesPDF(filtered));

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

  // ----- Inline expand row for monthly expenses -----
  // Refreshes only the inline payments block, not the whole page, so the
  // expand state of other rows is preserved when a CRUD action completes.
  const refreshInlinePayments = (expenseId) => {
    const exp = getExpenses().find(x => x.id === expenseId);
    if (!exp) return;
    const host = document.querySelector(`[data-exp-payments-content="${expenseId}"]`);
    if (host) setHTML(host, renderExpensePaymentsBlock(exp, isAdmin));
    rewireInlinePaymentHandlers(host, exp, isAdmin, refreshInlinePayments);
  };
  document.querySelectorAll('[data-act="exp-expand"]').forEach(b => b.addEventListener('click', () => {
    const sub = document.querySelector(`tr.exp-payments-row[data-exp="${b.dataset.id}"]`);
    if (!sub) return;
    const opening = sub.style.display === 'none';
    sub.style.display = opening ? '' : 'none';
    b.textContent = opening ? '▴' : '▾';
    b.setAttribute('aria-expanded', String(opening));
  }));
  // Wire payment-CRUD handlers for any sub-rows that may have been rendered.
  document.querySelectorAll('[data-exp-payments-content]').forEach(host => {
    const expId = host.dataset.expPaymentsContent;
    const exp = getExpenses().find(x => x.id === expId);
    if (exp) rewireInlinePaymentHandlers(host, exp, isAdmin, refreshInlinePayments);
  });
}

// Wires the add/edit/delete buttons in the inline payments block. Called once
// at initial render and again after any CRUD that re-renders the block.
function rewireInlinePaymentHandlers(host, exp, isAdmin, refresh) {
  if (!host || !isAdmin) return;
  host.querySelectorAll('[data-act="exp-add-pay"]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.id !== exp.id) return;
    openExpensePaymentDialog(exp, () => refresh(exp.id));
  }));
  host.querySelectorAll('[data-act="exp-edit-pay"]').forEach(b => b.addEventListener('click', () => {
    const pid = b.dataset.pid;
    const payment = getExpensePayments().find(p => p.id === pid);
    if (!payment) return;
    openExpensePaymentDialog(exp, () => refresh(exp.id), undefined, payment);
  }));
  host.querySelectorAll('[data-act="exp-del-pay"]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: t('exp.payment.delete.title'), message: t('exp.payment.delete.message'), danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    try {
      await deleteExpensePayment(b.dataset.pid);
      toast(t('exp.payment.deleted'), 'success');
      refresh(exp.id);
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
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
        await upsertExpensePayment({ expenseId: exp.id, year, month, amount, paidOn: todayISO(), method: exp.defaultMethod || 'bank' });
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

function openExpensePaymentDialog(exp, onSaved, defaultYear = new Date().getFullYear(), editing = null) {
  if (!requireAdmin()) return;
  const isEdit = !!editing;
  const now = new Date();
  const initialMonthKey = isEdit
    ? monthKey(editing.year, editing.month)
    : monthKey(defaultYear, now.getFullYear() === defaultYear ? now.getMonth() + 1 : 1);
  const monthsOptions = [];
  for (const y of availableYears()) {
    for (let mo = 1; mo <= 12; mo++) {
      const k = monthKey(y, mo);
      monthsOptions.push(`<option ${k === initialMonthKey ? 'selected' : ''} value="${k}">${monthName(mo)} ${y}</option>`);
    }
  }
  // Default amount: when editing → existing payment amount; otherwise the
  // expected amount for the picked month (so a one-shot pay-the-bill takes
  // a single keystroke).
  let suggested;
  if (isEdit) {
    suggested = editing.amount ?? '';
  } else {
    const { year: dy, month: dm } = parseMonthKey(initialMonthKey);
    suggested = expenseStatusForMonth(exp.id, dy, dm).expected || exp.amount || '';
  }

  const m = openModal({
    title: isEdit ? t('exp.payment.dialog.edit', { name: exp.name }) : t('exp.payment.dialog.add', { name: exp.name }),
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
          <input class="input" name="paidOn" type="date" value="${esc(isEdit ? (editing.paidOn || todayISO()) : todayISO())}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('pay.field.method'))}</label>
          <select class="select" name="method">
            ${(() => {
              // For new payments inherit the parent expense's default method;
              // for edits show the value already saved on the row. Falls
              // through to 'bank' if neither is set (matches prior behavior).
              const seedMethod = isEdit ? editing.method : (exp?.defaultMethod || 'bank');
              const opts = [
                ['bank', t('pay.method.bank')],
                ['bit', t('pay.method.bit')],
                ['check', t('pay.method.check')],
                ['cash', t('pay.method.cash')],
                ['other', t('pay.method.other')],
              ];
              return opts.map(([v, lbl]) =>
                `<option value="${esc(v)}" ${seedMethod === v ? 'selected' : ''}>${esc(lbl)}</option>`
              ).join('');
            })()}
          </select>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('common.notes'))}</label>
          <textarea class="textarea" name="notes" rows="2">${esc(isEdit ? (editing.notes || '') : '')}</textarea>
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
        id: isEdit ? editing.id : undefined,
        expenseId: exp.id,
        year, month,
        amount: Number(data.amount),
        paidOn: data.paidOn,
        method: data.method,
        notes: data.notes,
      });
      toast(isEdit ? t('exp.payment.updated') : t('exp.payment.recorded'), 'success');
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
  // Number of installments + total = derived from the bounded range
  // (start..end inclusive, in months). Only meaningful for type='installments'.
  const monthsBetweenInclusive = (a, b) => {
    if (!a || !b) return 0;
    const da = new Date(a), db = new Date(b);
    return (db.getFullYear() - da.getFullYear()) * 12 + (db.getMonth() - da.getMonth()) + 1;
  };
  const installmentsCount = e.type === 'installments' ? monthsBetweenInclusive(e.startDate, e.endDate) : 0;
  const installmentsTotal = e.type === 'installments' ? (Number(e.amount) || 0) * installmentsCount : 0;

  let period = '';
  if (e.type === 'monthly') {
    period = `${fmtDate(e.startDate)}${e.endDate ? ` → ${fmtDate(e.endDate)}` : ''}`;
    if (e.autoExtend) period += ` <span class="badge badge--info" style="font-size:10px; padding:1px 6px">${esc(t('exp.row.autoExtendBadge'))}</span>`;
  } else if (e.type === 'annual') {
    period = `${fmtDate(e.startDate)}${e.endDate ? ` → ${fmtDate(e.endDate)}` : ''}`;
    if (e.billDate) period += ` · ${fmtDate(e.billDate)}`;
  } else if (e.type === 'installments') {
    period = `${fmtDate(e.startDate)}${e.endDate ? ` → ${fmtDate(e.endDate)}` : ''}`;
  } else {
    period = fmtDate(e.oneOffDate);
  }
  const docCount = (e.documents || []).length;
  // Monthly + installments expenses get the inline expand-row affordance —
  // both have a per-month payment ledger that fits the same UI. Annual /
  // one-off stay click-to-modal.
  const expandable = e.type === 'monthly' || e.type === 'installments';
  const chevron = expandable
    ? `<button class="btn btn--sm btn--icon" data-act="exp-expand" data-id="${e.id}" aria-expanded="false" title="${esc(t('exp.row.expand.show'))}" style="padding:2px 6px">▾</button>`
    : '';
  return `
    <tr>
      <td>
        <div class="hstack" style="gap:6px; align-items:baseline">
          <strong>${esc(e.name)}</strong>
          ${chevron}
        </div>
        ${(() => {
          // Render the linked contact (clickable → contacts tab with this
          // contact highlighted) above the free-text notes line.
          const contact = e.contactId ? getContacts().find(c => c.id === e.contactId) : null;
          const contactLine = contact
            ? `<div class="muted" style="font-size:12px"><a href="#contacts?id=${esc(contact.id)}" class="muted" style="text-decoration:underline">${esc(contact.company || contact.name || '—')}${contact.phone ? ` · ${esc(contact.phone)}` : ''}</a></div>`
            : (e.contactId ? `<div class="muted" style="font-size:12px">${esc(t('exp.contact.deleted'))}</div>` : '');
          const notesLine = e.notes ? `<div class="muted" style="font-size:12px">${esc(e.notes)}</div>` : '';
          return contactLine + notesLine;
        })()}
      </td>
      <td>${esc(e.category || '—')}</td>
      <td>${typeBadge(e.type)}${e.type === 'annual' && e.rateHistory && e.rateHistory.length > 1 ? ` <button class="btn btn--sm btn--ghost" data-act="rates" data-id="${e.id}">${esc(t('exp.rates.count', { n: e.rateHistory.length }))}</button>` : ''}</td>
      <td class="num">${
        e.type === 'installments'
          ? `${fmtCurrency(installmentsTotal)}<div class="muted" style="font-size:11px">${esc(t('exp.row.installmentsBreakdown', { n: installmentsCount, perMonth: fmtCurrency(e.amount) }))}</div>`
          : `${fmtCurrency(e.amount)}${
              e.type === 'monthly' ? `<div class="muted" style="font-size:11px">${esc(t('exp.row.perMonth'))}</div>`
              : e.type === 'annual' ? `<div class="muted" style="font-size:11px">${esc(t('exp.row.perYear'))}</div>`
              : ''
            }`
      }</td>
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
    ${expandable ? `
      <tr class="exp-payments-row" data-exp="${e.id}" style="display:none; background:var(--c-surface-2)">
        <td colspan="8" style="padding:10px 16px">
          <div data-exp-payments-content="${e.id}">${renderExpensePaymentsBlock(e, isAdmin)}</div>
        </td>
      </tr>
    ` : ''}
  `;
}

// Localized label for a payment-method key. Falls back to the raw key for
// any value not in the static set, so legacy rows with custom strings still
// display something readable.
function paymentMethodLabel(method) {
  const known = new Set(['bank', 'bit', 'check', 'cash', 'other']);
  if (!method) return '—';
  return known.has(method) ? t(`pay.method.${method}`) : method;
}

// Inline payments list for a monthly expense — shown when its row is
// expanded. Lists all recorded expense_payments rows newest-first with
// edit/delete + an "Add payment" button. Re-renders independently after CRUD
// (no full page redraw needed).
function renderExpensePaymentsBlock(e, isAdmin) {
  const all = getExpensePayments();
  const rows = all
    .filter(p => p.expenseId === e.id)
    .sort((a, b) => {
      // newest first by year+month, then by paid_on
      if (a.year !== b.year) return b.year - a.year;
      if (a.month !== b.month) return b.month - a.month;
      return String(b.paidOn || '').localeCompare(String(a.paidOn || ''));
    });
  const total = rows.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return `
    <div class="hstack" style="gap:10px; align-items:baseline; margin-bottom:8px">
      <strong>${esc(t('exp.payments.title'))}</strong>
      <span class="muted" style="font-size:12px">${esc(t('exp.payments.total'))}: <strong class="text-success">${fmtCurrency(total)}</strong></span>
      <div class="spacer"></div>
      ${isAdmin ? `<button class="btn btn--sm btn--primary" data-act="exp-add-pay" data-id="${e.id}">${Icon.plus} ${esc(t('exp.payments.add'))}</button>` : ''}
    </div>
    ${rows.length === 0 ? `
      <div class="muted" style="font-size:13px; padding:8px 0">${esc(t('exp.payments.empty'))}</div>
    ` : `
      <div class="table-wrap">
        <table class="table" style="font-size:13px">
          <thead>
            <tr>
              <th>${esc(t('exp.payments.col.month'))}</th>
              <th class="num">${esc(t('exp.payments.col.amount'))}</th>
              <th>${esc(t('exp.payments.col.paidOn'))}</th>
              <th>${esc(t('exp.payments.col.method'))}</th>
              <th>${esc(t('common.notes'))}</th>
              ${isAdmin ? `<th class="actions">${esc(t('common.actions'))}</th>` : ''}
            </tr>
          </thead>
          <tbody>
            ${rows.map(p => `
              <tr>
                <td>${esc(monthName(p.month))} ${p.year}</td>
                <td class="num text-success">${fmtCurrency(p.amount)}</td>
                <td>${p.paidOn ? fmtDate(p.paidOn) : '—'}</td>
                <td>${esc(paymentMethodLabel(p.method))}</td>
                <td class="muted">${esc(p.notes || '—')}</td>
                ${isAdmin ? `
                  <td class="actions">
                    <button class="btn btn--sm btn--icon" data-act="exp-edit-pay" data-pid="${p.id}" data-eid="${e.id}" title="${esc(t('common.edit'))}">${Icon.edit}</button>
                    <button class="btn btn--sm btn--icon" data-act="exp-del-pay" data-pid="${p.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>
                  </td>
                ` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `}
  `;
}

function typeBadge(typ) {
  return typ === 'monthly' ? `<span class="badge badge--info">${esc(t('exp.type.monthly'))}</span>` :
         typ === 'annual' ? `<span class="badge badge--accent">${esc(t('exp.type.annual'))}</span>` :
         typ === 'installments' ? `<span class="badge badge--warning">${esc(t('exp.type.installments'))}</span>` :
         `<span class="badge">${esc(t('exp.type.oneoff'))}</span>`;
}

// Returns ISO yyyy-mm-dd for the first / last day of the month containing
// the given ISO date (or today if none).
function firstOfMonthISO(iso) {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function lastOfMonthISO(iso) {
  const d = iso ? new Date(iso) : new Date();
  // Day 0 of next month = last day of current month.
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

function openExpenseDialog(exp = null) {
  if (!requireAdmin()) return;
  const isEdit = !!exp;
  const ty = exp?.type || 'monthly';
  const cats = knownCategories();
  // For NEW monthly expenses, default the date range to the current month so
  // the row covers exactly that month out of the box. The admin can extend
  // endDate (or clear it for an open-ended ongoing expense) before saving.
  // For other types or when editing, fall back to the existing values.
  const defaultStart = isEdit
    ? (exp?.startDate || todayISO())
    : ((ty === 'monthly' || ty === 'installments') ? firstOfMonthISO() : todayISO());
  const defaultEnd = isEdit
    ? (exp?.endDate || '')
    : (ty === 'monthly' ? lastOfMonthISO() : '');
  // Installments: derive N from existing range when editing, else default to 2.
  // The row's `amount` is per-month, the form shows TOTAL = amount × N.
  const monthsBetween = (a, b) => {
    if (!a || !b) return 0;
    const da = new Date(a), db = new Date(b);
    return (db.getFullYear() - da.getFullYear()) * 12 + (db.getMonth() - da.getMonth()) + 1;
  };
  const initialInstallments = (isEdit && exp?.type === 'installments')
    ? Math.max(2, monthsBetween(exp.startDate, exp.endDate))
    : 2;

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
            <button type="button" class="segmented__opt ${ty==='installments'?'segmented__opt--active':''}" data-type="installments">${esc(t('exp.type.installments'))}</button>
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
          <input class="input" name="amount" type="number" step="0.01" required
                 value="${(isEdit && exp?.type === 'installments')
                   ? (Number(exp.amount || 0) * initialInstallments).toFixed(2)
                   : (exp?.amount ?? '')}" />
          <div class="field__hint" id="hint-amount"></div>
        </div>
        <div class="field">
          <label class="field__label">${esc(t('exp.field.defaultMethod'))}</label>
          <select class="select" name="defaultMethod">
            <option value="" ${!exp?.defaultMethod ? 'selected' : ''}>${esc(t('exp.field.defaultMethod.none'))}</option>
            <option value="bank"  ${exp?.defaultMethod === 'bank'  ? 'selected' : ''}>${esc(t('pay.method.bank'))}</option>
            <option value="bit"   ${exp?.defaultMethod === 'bit'   ? 'selected' : ''}>${esc(t('pay.method.bit'))}</option>
            <option value="check" ${exp?.defaultMethod === 'check' ? 'selected' : ''}>${esc(t('pay.method.check'))}</option>
            <option value="cash"  ${exp?.defaultMethod === 'cash'  ? 'selected' : ''}>${esc(t('pay.method.cash'))}</option>
            <option value="other" ${exp?.defaultMethod === 'other' ? 'selected' : ''}>${esc(t('pay.method.other'))}</option>
          </select>
          <div class="field__hint">${esc(t('exp.field.defaultMethod.hint'))}</div>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('exp.field.contact'))}</label>
          <div class="hstack" style="gap:6px">
            <select class="select" name="contactId" id="exp-contact-sel" style="flex:1">
              <option value="" ${!exp?.contactId ? 'selected' : ''}>${esc(t('exp.field.contact.none'))}</option>
              ${[...getContacts()].sort((a, b) => String(a.company || a.name || '').localeCompare(String(b.company || b.name || ''), 'he')).map(c => `
                <option value="${esc(c.id)}" ${exp?.contactId === c.id ? 'selected' : ''}>${esc(c.company || '—')}${c.name ? ` · ${esc(c.name)}` : ''}${c.phone ? ` · ${esc(c.phone)}` : ''}</option>
              `).join('')}
            </select>
            <button type="button" class="btn btn--sm" id="exp-new-contact">+ ${esc(t('exp.field.contact.create'))}</button>
          </div>
          <div class="field__hint">${esc(t('exp.field.contact.hint'))}</div>
        </div>

        <div class="field field--required" id="field-start">
          <label class="field__label" id="lbl-start">${esc(t('exp.field.startDate'))}</label>
          <input class="input" name="startDate" type="date" value="${esc(defaultStart)}" />
        </div>
        <div class="field field--required" id="field-installments" style="display:${ty === 'installments' ? 'flex' : 'none'}">
          <label class="field__label">${esc(t('exp.field.installmentsCount'))}</label>
          <input class="input" name="installmentsCount" type="number" min="2" step="1" value="${esc(String(initialInstallments))}" />
          <div class="field__hint">${esc(t('exp.field.installmentsCountHint'))}</div>
        </div>
        <div class="field" id="field-end">
          <label class="field__label">${esc(t('exp.field.endDate'))}</label>
          <input class="input" name="endDate" type="date" value="${esc(defaultEnd)}" />
          <div class="field__hint" id="hint-end" style="display:${ty === 'monthly' ? 'block' : 'none'}">${esc(t('exp.field.endDateMonthlyHint'))}</div>
        </div>
        <div class="field" id="field-autoextend" style="display:${ty === 'monthly' ? 'flex' : 'none'}; grid-column:1/-1">
          <label class="checkbox" style="display:flex; gap:8px; align-items:flex-start; cursor:pointer">
            <input type="checkbox" name="autoExtend" id="autoExtend-cb" ${(isEdit ? exp?.autoExtend : true) ? 'checked' : ''} />
            <span>
              <span style="font-weight:500">${esc(t('exp.field.autoExtend'))}</span>
              <div class="field__hint" style="margin-top:2px">${esc(t('exp.field.autoExtend.hint'))}</div>
            </span>
          </label>
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

  // ----- Contact picker: "+ create new contact" path -----
  // Opens a small sub-dialog. On save, the new contact is created via the
  // store, the picker reloads from the cache, and the new contact is
  // pre-selected — admin can save the expense without a second click.
  // All values pass through esc() before reaching setHTML, so the rebuilt
  // dropdown is XSS-safe.
  m.bodyEl.querySelector('#exp-new-contact')?.addEventListener('click', () => {
    if (!requireAdmin()) return;
    openInlineContactDialog((created) => {
      if (!created?.id) return;
      const sel = m.bodyEl.querySelector('#exp-contact-sel');
      const sortedNow = [...getContacts()].sort((a, b) =>
        String(a.company || a.name || '').localeCompare(String(b.company || b.name || ''), 'he'));
      const html =
        `<option value="">${esc(t('exp.field.contact.none'))}</option>` +
        sortedNow.map(c =>
          `<option value="${esc(c.id)}" ${created.id === c.id ? 'selected' : ''}>${esc(c.company || '—')}${c.name ? ` · ${esc(c.name)}` : ''}${c.phone ? ` · ${esc(c.phone)}` : ''}</option>`
        ).join('');
      setHTML(sel, html);
    });
  });

  const setType = (newType) => {
    m.bodyEl.querySelector('#type-val').value = newType;
    m.bodyEl.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('segmented__opt--active', b.dataset.type === newType));
    m.bodyEl.querySelector('#field-bill').style.display = newType === 'annual' ? 'flex' : 'none';
    m.bodyEl.querySelector('#field-oneoff').style.display = newType === 'oneoff' ? 'flex' : 'none';
    m.bodyEl.querySelector('#field-start').style.display = newType === 'oneoff' ? 'none' : 'flex';
    // endDate is computed automatically for installments (start + N months) —
    // hide the input so admins don't end up with conflicting values.
    m.bodyEl.querySelector('#field-end').style.display = (newType === 'oneoff' || newType === 'installments') ? 'none' : 'flex';
    m.bodyEl.querySelector('#field-installments').style.display = newType === 'installments' ? 'flex' : 'none';
    const lbl = m.bodyEl.querySelector('#lbl-amount');
    const hint = m.bodyEl.querySelector('#hint-amount');
    const hintEnd = m.bodyEl.querySelector('#hint-end');
    lbl.textContent = newType === 'monthly' ? t('exp.field.amountMonthly')
                    : newType === 'annual' ? t('exp.field.amountAnnual')
                    : newType === 'installments' ? t('exp.field.amountInstallmentsTotal')
                    : t('exp.field.amountOneoff');
    hint.textContent = newType === 'annual' ? t('exp.annualHint')
                     : newType === 'installments' ? t('exp.installmentsHint')
                     : '';
    if (hintEnd) hintEnd.style.display = newType === 'monthly' ? 'block' : 'none';
    const autoExtendField = m.bodyEl.querySelector('#field-autoextend');
    if (autoExtendField) autoExtendField.style.display = newType === 'monthly' ? 'flex' : 'none';
    // For NEW expenses, switching INTO 'monthly' snaps both dates to the
    // current month range so the entry covers exactly that month by default.
    // Don't overwrite anything in edit mode.
    if (!isEdit && newType === 'monthly') {
      const startEl = m.bodyEl.querySelector('input[name="startDate"]');
      const endEl = m.bodyEl.querySelector('input[name="endDate"]');
      const ref = startEl.value || todayISO();
      startEl.value = firstOfMonthISO(ref);
      endEl.value = lastOfMonthISO(ref);
    }
    // Switching INTO 'installments' for a new expense snaps the start to the
    // 1st of the picked month so the per-month math is clean.
    if (!isEdit && newType === 'installments') {
      const startEl = m.bodyEl.querySelector('input[name="startDate"]');
      startEl.value = firstOfMonthISO(startEl.value || todayISO());
    }
  };
  setType(ty);
  m.bodyEl.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => setType(b.dataset.type)));

  // For monthly expenses, when admin picks a startDate, snap it to the 1st
  // of that month and (if endDate hasn't been touched away from auto-default)
  // sync endDate to the last day of the same month — so picking April 17
  // becomes "Apr 1 → Apr 30" automatically.
  const startEl = m.bodyEl.querySelector('input[name="startDate"]');
  const endEl = m.bodyEl.querySelector('input[name="endDate"]');
  startEl.addEventListener('change', () => {
    if (m.bodyEl.querySelector('#type-val').value !== 'monthly') return;
    if (!startEl.value) return;
    const expectedEndForOldStart = lastOfMonthISO(startEl.dataset.lastSnapped || startEl.defaultValue || startEl.value);
    const snappedStart = firstOfMonthISO(startEl.value);
    startEl.value = snappedStart;
    startEl.dataset.lastSnapped = snappedStart;
    // Only auto-update endDate when it's empty or still matches the old
    // auto-derived end — don't overwrite an end the admin manually changed.
    if (!endEl.value || endEl.value === expectedEndForOldStart) {
      endEl.value = lastOfMonthISO(snappedStart);
    }
  });

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
    // FormData turns unchecked checkboxes into "absent" — explicitly read the
    // checkbox state so we can pass a clear boolean to the server.
    const autoExtend = data.type === 'monthly'
      && !!m.bodyEl.querySelector('#autoExtend-cb')?.checked;
    delete data.autoExtend; // strip the form's "on" string before merging
    // Installments → store as a bounded monthly-style range. The form gives
    // us a TOTAL amount + N; we derive the per-month rate (total / N) and
    // the implicit endDate (last day of startDate + N − 1 months).
    let perMonthAmount = Number(data.amount);
    if (data.type === 'installments') {
      const n = Math.max(2, Math.floor(Number(data.installmentsCount) || 0));
      if (!Number.isFinite(n) || n < 2) { toast(t('exp.installmentsInvalid'), 'warning'); return; }
      if (!Number.isFinite(perMonthAmount) || perMonthAmount <= 0) { toast(t('exp.amountRequired'), 'warning'); return; }
      perMonthAmount = perMonthAmount / n;
      // Compute endDate = last day of (startDate + N − 1 months)
      const sd = new Date(data.startDate);
      const endY = sd.getFullYear();
      const endMidx = sd.getMonth() + (n - 1); // 0-based month + offset
      const endDateObj = new Date(endY, endMidx + 1, 0); // day 0 of next month = last day
      const ey = endDateObj.getFullYear();
      const em = String(endDateObj.getMonth() + 1).padStart(2, '0');
      const ed = String(endDateObj.getDate()).padStart(2, '0');
      data.endDate = `${ey}-${em}-${ed}`;
    }
    delete data.installmentsCount; // not a server field
    const saveBtn = m.footerEl.querySelector('[data-act="save"]');
    saveBtn.disabled = true;
    try {
      const saved = await upsertExpense({ id: exp?.id, ...data, amount: perMonthAmount, autoExtend });
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

// CSV export of the currently-filtered expenses list. UTF-8 BOM keeps Excel
// happy with Hebrew. Each row mirrors the columns visible in the on-screen
// table — name, category, type, amount, period, status, doc count.
function exportExpensesCSV(rows) {
  const BOM = '﻿';
  const q = (s) => {
    if (s == null) return '';
    const str = String(s).replace(/"/g, '""');
    return /[",\n\r]/.test(str) ? `"${str}"` : str;
  };
  const periodOf = (e) => {
    if (e.type === 'oneoff') return e.oneOffDate || '';
    return `${e.startDate || ''}${e.endDate ? ' → ' + e.endDate : ''}`;
  };
  const lines = [
    [t('exp.col.name'), t('common.category'), t('exp.col.type'), t('common.amount'),
     t('exp.col.period'), t('common.status'), t('exp.col.docs')].map(q).join(','),
  ];
  for (const e of rows) {
    lines.push([
      q(e.name),
      q(e.category || ''),
      q(t('exp.type.' + e.type)),
      q(Number(e.amount || 0).toFixed(2)),
      q(periodOf(e)),
      q(t('exp.status.' + expenseDerivedStatus(e))),
      q((e.documents || []).length),
    ].join(','));
  }
  const today = todayISO();
  const range = (filterFrom || filterTo)
    ? `_${filterFrom || ''}_to_${filterTo || ''}`
    : '';
  downloadBlob(
    new Blob([BOM + lines.join('\n')], { type: 'text/csv;charset=utf-8' }),
    `expenses_${today}${range}.csv`,
  );
}

// Print-friendly PDF export. Opens a popup window with the filtered table and
// kicks off the browser's print dialog so the user can save as PDF.
// Self-contained CSS — doesn't depend on the app's stylesheet.
function exportExpensesPDF(rows) {
  const periodOf = (e) => {
    if (e.type === 'oneoff') return e.oneOffDate ? fmtDate(e.oneOffDate) : '';
    return `${fmtDate(e.startDate)}${e.endDate ? ' → ' + fmtDate(e.endDate) : ''}`;
  };
  const dir = document.documentElement.getAttribute('dir') || 'rtl';
  const title = t('exp.export.pdfTitle');
  const headerRange = (filterFrom || filterTo)
    ? `${fmtDate(filterFrom || '')} — ${fmtDate(filterTo || '')}`
    : t('exp.filter.preset.all');
  const html = `<!doctype html>
<html lang="he" dir="${dir}">
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:24px;color:#111}
    h1{font-size:20px;margin:0 0 4px}
    .meta{color:#555;font-size:12px;margin-bottom:14px}
    table{border-collapse:collapse;width:100%;font-size:12px}
    th,td{border:1px solid #ccc;padding:6px 8px;text-align:start;vertical-align:top}
    th{background:#f3f3f3;font-weight:600}
    .num{text-align:end}
    @media print{body{margin:12px}}
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(headerRange)} · ${esc(t('exp.export.rowsCount', { n: rows.length }))} · ${esc(fmtDate(todayISO()))}</div>
  <table>
    <thead>
      <tr>
        <th>${esc(t('exp.col.name'))}</th>
        <th>${esc(t('common.category'))}</th>
        <th>${esc(t('exp.col.type'))}</th>
        <th class="num">${esc(t('common.amount'))}</th>
        <th>${esc(t('exp.col.period'))}</th>
        <th>${esc(t('common.status'))}</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(e => `
        <tr>
          <td>${esc(e.name)}${e.notes ? `<br><span style="color:#777;font-size:11px">${esc(e.notes)}</span>` : ''}</td>
          <td>${esc(e.category || '—')}</td>
          <td>${esc(t('exp.type.' + e.type))}</td>
          <td class="num">${esc(fmtCurrency(e.amount))}</td>
          <td>${esc(periodOf(e))}</td>
          <td>${esc(t('exp.status.' + expenseDerivedStatus(e)))}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</body>
</html>`;
  // Use a Blob URL so the popup loads a real document (no doc.write — safer
  // and side-steps strict-mode quirks). Once it's parsed we trigger print
  // from this side.
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const w = window.open(url, '_blank');
  if (!w) {
    URL.revokeObjectURL(url);
    toast(t('exp.export.pdfPopupBlocked'), 'warning');
    return;
  }
  setTimeout(() => {
    try { w.focus(); w.print(); } catch (_) { /* user can re-print manually */ }
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 350);
}

// Sub-dialog launched from the expense form's "+ create new contact" button.
// Mirrors the smallest useful subset of the contacts page: company (required),
// name, role, phone, email, notes. On successful save it calls onSaved with
// the freshly-created contact row so the caller can pre-select it.
function openInlineContactDialog(onSaved) {
  const m = openModal({
    title: t('exp.contact.dialog.title'),
    size: 'md',
    body: `
      <form id="ic-form" class="form-grid" autocomplete="off">
        <div class="field field--required" style="grid-column:1/-1">
          <label class="field__label">${esc(t('contacts.field.company'))}</label>
          <input class="input" name="company" required />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('contacts.field.name'))}</label>
          <input class="input" name="name" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('contacts.field.role'))}</label>
          <input class="input" name="role" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('contacts.field.phone'))}</label>
          <input class="input" name="phone" type="tel" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('contacts.field.email'))}</label>
          <input class="input" name="email" type="email" />
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('common.notes'))}</label>
          <textarea class="textarea" name="notes" rows="2"></textarea>
        </div>
      </form>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save">${esc(t('common.add'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#ic-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!(data.company || '').trim()) { toast(t('contacts.companyRequired'), 'warning'); return; }
    try {
      const created = await upsertContact({
        company: data.company.trim(),
        name: (data.name || '').trim() || null,
        role: (data.role || '').trim() || null,
        phone: (data.phone || '').trim() || null,
        email: (data.email || '').trim() || null,
        notes: (data.notes || '').trim() || null,
      });
      toast(t('contacts.created'), 'success');
      m.close();
      onSaved && onSaved(created);
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}
