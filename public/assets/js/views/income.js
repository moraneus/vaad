// Income — apartments × months grid + quick payment recording

import { getApartments, getPayments, getSettings, deletePayment, getAdjustmentPayments } from '../store.js';
import { fmtCurrency, esc, fmtDate } from '../utils.js';
import { t, monthName } from '../i18n.js';
import { apartmentMonthStatus, expectedIncomeForMonth, actualIncomeForMonth, availableYears, lastMonthInScope } from '../calc.js';
import { setHTML, renderPageHeader, renderEmpty, openModal, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';
import { getSession } from '../store.js';
import { openPaymentDialog } from './apartments.js';
import { issueReceiptAndOpen, openReceiptHistory } from './receipt.js';

let curYear = new Date().getFullYear();

// Adjustment-payment income for a given calendar (year, month) based on paid_on date.
function adjustmentIncomeForMonth(year, month) {
  return getAdjustmentPayments()
    .filter(p => {
      if (!p.paidOn) return false;
      const d = new Date(p.paidOn);
      return d.getFullYear() === year && (d.getMonth() + 1) === month;
    })
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
}

export function renderIncome() {
  const main = document.getElementById('app-main');
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const apts = [...getApartments()].sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

  // Per-month numbers (used in the table footer — show all 12 months)
  const monthTotals = Array.from({ length: 12 }, (_, i) => ({
    expected: expectedIncomeForMonth(curYear, i + 1),
    monthlyPaid: getPayments()
      .filter(p => p.year === curYear && p.month === (i + 1))
      .reduce((s, p) => s + (Number(p.amount) || 0), 0),
    adjustmentPaid: adjustmentIncomeForMonth(curYear, i + 1),
  }));
  // Top stats: only count up to today (year-to-date), so the gap reflects
  // reality, not "what's expected for the rest of the year".
  const lastM = lastMonthInScope(curYear);
  let totalExpected = 0, totalPaid = 0;
  for (let i = 0; i < 12; i++) {
    if (i + 1 > lastM) continue;
    totalExpected += monthTotals[i].expected;
    totalPaid += monthTotals[i].monthlyPaid + monthTotals[i].adjustmentPaid;
  }
  const collectionRate = totalExpected > 0 ? Math.round((totalPaid / totalExpected) * 100) : 0;
  const hasAdjIncome = monthTotals.some(x => x.adjustmentPaid > 0);

  setHTML(main, `
    ${renderPageHeader({
      title: t('income.title'),
      subtitle: t('income.subtitle', { year: curYear }),
      actions: `<button class="btn" id="open-receipts">${Icon.document} ${esc(isAdmin ? t('receipts.history.titleAdmin') : t('receipts.history.title'))}</button>`,
    })}

    <div class="stats-grid">
      <div class="stat stat--success">
        <div class="stat__label">${esc(t('income.expectedToDate'))}</div>
        <div class="stat__value">${fmtCurrency(totalExpected)}</div>
        <div class="stat__hint">${esc(t('income.expectedToDateHint'))}</div>
      </div>
      <div class="stat stat--success">
        <div class="stat__label">${esc(t('income.paidActual'))}</div>
        <div class="stat__value">${fmtCurrency(totalPaid)}</div>
        <div class="progress" style="margin-top:8px"><div class="progress__bar progress__bar--success" style="width:${collectionRate}%"></div></div>
        <div class="stat__hint">${esc(t('income.collectionRate', { pct: collectionRate }))}</div>
      </div>
      <div class="stat ${totalPaid - totalExpected >= 0 ? '' : 'stat--danger'}">
        <div class="stat__label">${esc(t('income.gap'))}</div>
        <div class="stat__value">${fmtCurrency(totalPaid - totalExpected)}</div>
        <div class="stat__hint">${esc(totalPaid - totalExpected >= 0 ? t('income.surplus') : t('income.deficit'))}</div>
      </div>
    </div>

    <div class="toolbar">
      <select class="select" id="year-select" style="width:140px">
        ${availableYears().map(y => `<option ${y === curYear ? 'selected' : ''} value="${y}">${y}</option>`).join('')}
      </select>
      <div class="spacer"></div>
      <div class="hstack" style="font-size:12px; gap:14px">
        <span class="legend__item"><span class="legend__swatch" style="background:var(--c-success)"></span> ${esc(t('income.legend.paid'))}</span>
        <span class="legend__item"><span class="legend__swatch" style="background:var(--c-warning)"></span> ${esc(t('income.legend.partial'))}</span>
        <span class="legend__item"><span class="legend__swatch" style="background:var(--c-border-strong)"></span> ${esc(t('income.legend.unpaid'))}</span>
      </div>
    </div>

    ${apts.length === 0 ? renderEmpty({ title: t('apt.empty.title'), hint: t('apt.empty.hint') }) : `
      <div class="card card--padless">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th class="nowrap">${esc(t('apt.col.number'))}</th>
                ${Array.from({ length: 12 }, (_, i) => `<th class="num">${monthName(i + 1, true)}</th>`).join('')}
                <th class="num">${esc(t('common.total'))}</th>
              </tr>
            </thead>
            <tbody>
              ${apts.map(apt => renderRow(apt, isAdmin)).join('')}
            </tbody>
            <tfoot>
              <tr>
                <td>${esc(t('income.collected'))}</td>
                ${monthTotals.map(x => `<td class="num">${fmtCurrency(x.monthlyPaid)}</td>`).join('')}
                <td class="num">${fmtCurrency(monthTotals.reduce((s, x) => s + x.monthlyPaid, 0))}</td>
              </tr>
              ${hasAdjIncome ? `
                <tr>
                  <td>${esc(t('income.adjustmentPayments'))}</td>
                  ${monthTotals.map(x => `<td class="num text-success">${x.adjustmentPaid > 0 ? '+' + fmtCurrency(x.adjustmentPaid) : '—'}</td>`).join('')}
                  <td class="num text-success">+${fmtCurrency(monthTotals.reduce((s, x) => s + x.adjustmentPaid, 0))}</td>
                </tr>
              ` : ''}
              <tr>
                <td>${esc(t('income.expected'))}</td>
                ${monthTotals.map(x => `<td class="num muted">${fmtCurrency(x.expected)}</td>`).join('')}
                <td class="num muted">${fmtCurrency(monthTotals.reduce((s, x) => s + x.expected, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    `}
  `);

  document.getElementById('year-select')?.addEventListener('change', (e) => { curYear = Number(e.target.value); renderIncome(); });
  document.getElementById('open-receipts')?.addEventListener('click', () => openReceiptHistory());
  document.querySelectorAll('[data-act="cell"]').forEach(c => c.addEventListener('click', () => {
    const apt = getApartments().find(a => a.id === c.dataset.aid);
    openMonthPaymentsDialog(apt, curYear, Number(c.dataset.m));
  }));
}

function renderRow(apt, isAdmin) {
  const cells = [];
  let rowPaid = 0;
  for (let m = 1; m <= 12; m++) {
    const st = apartmentMonthStatus(apt.id, curYear, m);
    rowPaid += st.paid;
    const bg = st.status === 'paid' ? 'var(--c-success-soft)' : st.status === 'partial' ? 'var(--c-warning-soft)' : 'transparent';
    const color = st.status === 'paid' ? 'var(--c-success)' : st.status === 'partial' ? 'var(--c-warning)' : 'var(--c-text-subtle)';
    cells.push(`
      <td class="num" data-act="cell" data-aid="${apt.id}" data-m="${m}" style="background:${bg}; color:${color}; cursor:pointer; font-weight:600" title="${monthName(m)}: ${fmtCurrency(st.paid)} / ${fmtCurrency(st.expected)}">
        ${st.paid > 0 ? fmtCurrency(st.paid) : '—'}
      </td>
    `);
  }
  return `
    <tr>
      <td class="nowrap"><strong>${esc(String(apt.number))}</strong>${apt.owner ? `<div class="muted" style="font-size:12px">${esc(apt.owner)}</div>` : ''}</td>
      ${cells.join('')}
      <td class="num"><strong>${fmtCurrency(rowPaid)}</strong></td>
    </tr>
  `;
}

function openMonthPaymentsDialog(apt, year, month) {
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const ps = getPayments().filter(p => p.apartmentId === apt.id && p.year === year && p.month === month);
  const st = apartmentMonthStatus(apt.id, year, month);
  // Receipt button: visible only when there's a paid amount, and the user is
  // either an admin (any apartment) or the tenant of *this* apartment.
  const canIssueReceipt = st.paid > 0 && (isAdmin || session.apartmentId === apt.id);
  const m = openModal({
    title: t('pay.viewMonth', { aptNumber: String(apt.number), month: monthName(month), year }),
    body: `
      <div class="hstack" style="margin-bottom:14px">
        <div class="muted">${esc(t('apt.ledger.expected'))}: <strong>${fmtCurrency(st.expected)}</strong></div>
        <span style="color:var(--c-border-strong)">·</span>
        <div class="muted">${esc(t('apt.col.paid'))}: <strong class="text-success">${fmtCurrency(st.paid)}</strong></div>
        ${st.diff !== 0 ? `<span style="color:var(--c-border-strong)">·</span>
          <div class="muted">${esc(st.diff > 0 ? t('income.diff.surplus') : t('income.diff.debt'))}: <strong class="${st.diff < 0 ? 'text-danger' : 'text-success'}">${fmtCurrency(Math.abs(st.diff))}</strong></div>` : ''}
      </div>
      ${ps.length === 0 ? `<p class="muted">—</p>` : `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>${esc(t('common.date'))}</th><th>${esc(t('pay.field.method'))}</th><th class="num">${esc(t('common.amount'))}</th><th>${esc(t('common.notes'))}</th>${isAdmin ? `<th class="actions"></th>` : ''}</tr></thead>
            <tbody>
              ${ps.map(p => `
                <tr>
                  <td>${fmtDate(p.paidOn)}</td>
                  <td>${esc(t('pay.method.' + (p.method || 'other')))}</td>
                  <td class="num">${fmtCurrency(p.amount)}</td>
                  <td>${esc(p.notes || '—')}</td>
                  ${isAdmin ? `<td class="actions"><button class="btn btn--sm btn--icon" data-act="del" data-pid="${p.id}">${Icon.trash}</button></td>` : ''}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    `,
    footer: `
      ${canIssueReceipt ? `<button class="btn btn--accent" data-act="receipt">${Icon.download} ${esc(t('receipts.issue'))}</button>` : ''}
      ${isAdmin ? `<button class="btn btn--primary" data-act="add">${Icon.plus} ${esc(t('apt.ledger.recordPay'))}</button>` : ''}
      <button class="btn" data-act="close">${esc(t('common.close'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="close"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="add"]')?.addEventListener('click', () => {
    m.close();
    openPaymentDialog(apt, () => renderIncome());
  });
  m.footerEl.querySelector('[data-act="receipt"]')?.addEventListener('click', async () => {
    try { await issueReceiptAndOpen(apt.id, year, month); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
  m.bodyEl.querySelectorAll('[data-act="del"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const ok = await confirmDialog({ title: t('pay.delete.title'), message: t('pay.delete.message'), confirmText: t('common.delete'), danger: true });
    if (ok) { try { await deletePayment(b.dataset.pid); m.close(); renderIncome(); toast(t('pay.deleted'), 'success'); } catch (err) { toast(err.message || t('common.error'), 'danger'); } }
  }));
}
