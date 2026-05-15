// Income — apartments × months grid + quick payment recording

import { getApartments, getPayments, getSettings, deletePayment, getAdjustmentPayments, getAdjustments, getInfrastructurePayments, getInfrastructureDemands } from '../store.js';
import { fmtCurrency, esc, fmtDate, todayISO, downloadBlob } from '../utils.js';
import { t, monthName } from '../i18n.js';
import { apartmentMonthStatus, apartmentOutstanding, expectedIncomeForMonth, actualIncomeForMonth, availableYears, lastMonthInScope } from '../calc.js';
import { setHTML, renderPageHeader, renderEmpty, openModal, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';
import { getSession } from '../store.js';
import { openPaymentDialog } from './apartments.js';
import { issueReceiptAndOpen, openReceiptHistory } from './receipt.js';

let curYear = new Date().getFullYear();
// Export-only date range — independent from the year-grid that's always
// rendered for a single year. Defaults to the current year.
let exportFrom = null;
let exportTo = null;

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

// Infrastructure-payment income for a given calendar (year, month) based
// on paid_on date. Mirrors adjustmentIncomeForMonth so the two flows can
// be summed symmetrically.
function infrastructureIncomeForMonth(year, month) {
  return getInfrastructurePayments()
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
    infrastructurePaid: infrastructureIncomeForMonth(curYear, i + 1),
  }));
  // Top stats: only count up to today (year-to-date), so the gap reflects
  // reality, not "what's expected for the rest of the year".
  const lastM = lastMonthInScope(curYear);
  let totalExpected = 0, totalPaid = 0;
  for (let i = 0; i < 12; i++) {
    if (i + 1 > lastM) continue;
    totalExpected += monthTotals[i].expected;
    // expectedIncomeForMonth already includes infra demands billed in that
    // month — keep "paid" symmetric by adding infra payments too. Without
    // this the gap shows a fake debt: residents that paid their infra
    // share are counted in expected but not in paid.
    totalPaid += monthTotals[i].monthlyPaid + monthTotals[i].adjustmentPaid + monthTotals[i].infrastructurePaid;
  }
  const collectionRate = totalExpected > 0 ? Math.round((totalPaid / totalExpected) * 100) : 0;
  const hasAdjIncome = monthTotals.some(x => x.adjustmentPaid > 0);
  const hasInfraIncome = monthTotals.some(x => x.infrastructurePaid > 0);

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

    ${isAdmin ? `
      <div class="toolbar" style="margin-top:-6px; gap:6px; flex-wrap:nowrap; overflow-x:auto">
        <strong style="font-size:13px; white-space:nowrap">${esc(t('income.export.heading'))}</strong>
        <select class="select" id="inc-preset" style="width:auto" title="${esc(t('income.export.preset.title'))}">
          <option value="custom">${esc(t('income.export.preset.custom'))}</option>
          <option value="thisYear">${esc(t('exp.filter.preset.thisYear'))}</option>
          <option value="last3">${esc(t('exp.filter.preset.last3'))}</option>
          <option value="lastYear">${esc(t('exp.filter.preset.lastYear'))}</option>
          <option value="thisMonth">${esc(t('income.export.preset.thisMonth'))}</option>
        </select>
        <input class="input" id="inc-from" type="date" value="${esc(exportFrom || `${curYear}-01-01`)}" style="width:140px" title="${esc(t('exp.filter.from'))}" />
        <input class="input" id="inc-to" type="date" value="${esc(exportTo || `${curYear}-12-31`)}" style="width:140px" title="${esc(t('exp.filter.to'))}" />
        <div class="spacer"></div>
        <button class="btn btn--sm" id="inc-export-csv" title="${esc(t('exp.export.csvHint'))}" style="white-space:nowrap">${Icon.download} ${esc(t('exp.export.csv'))}</button>
        <button class="btn btn--sm" id="inc-export-pdf" title="${esc(t('exp.export.pdfHint'))}" style="white-space:nowrap">${Icon.document} ${esc(t('exp.export.pdf'))}</button>
      </div>
    ` : ''}

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
              ${hasInfraIncome ? `
                <tr>
                  <td>${esc(t('income.infrastructurePayments'))}</td>
                  ${monthTotals.map(x => `<td class="num text-success">${x.infrastructurePaid > 0 ? '+' + fmtCurrency(x.infrastructurePaid) : '—'}</td>`).join('')}
                  <td class="num text-success">+${fmtCurrency(monthTotals.reduce((s, x) => s + x.infrastructurePaid, 0))}</td>
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

  document.getElementById('year-select')?.addEventListener('change', (e) => {
    curYear = Number(e.target.value);
    // When the visible year changes, reset the export range to that year so
    // the inputs stay in sync with what's on screen.
    exportFrom = `${curYear}-01-01`;
    exportTo = `${curYear}-12-31`;
    renderIncome();
  });
  document.getElementById('open-receipts')?.addEventListener('click', () => openReceiptHistory());

  // Export controls (admin-only)
  const fromEl = document.getElementById('inc-from');
  const toEl = document.getElementById('inc-to');
  fromEl?.addEventListener('change', () => { exportFrom = fromEl.value || null; });
  toEl?.addEventListener('change', () => { exportTo = toEl.value || null; });
  // Single preset dropdown — applies the chosen preset's dates to the
  // from/to inputs and to the export state. Picking "custom" leaves the
  // current values alone (admin can edit the inputs directly).
  const presetSel = document.getElementById('inc-preset');
  presetSel?.addEventListener('change', () => {
    const today = new Date();
    const y = today.getFullYear();
    const v = presetSel.value;
    if (v === 'thisYear') {
      exportFrom = `${y}-01-01`; exportTo = `${y}-12-31`;
    } else if (v === 'lastYear') {
      exportFrom = `${y - 1}-01-01`; exportTo = `${y - 1}-12-31`;
    } else if (v === 'last3') {
      const back = new Date(today); back.setMonth(today.getMonth() - 2); back.setDate(1);
      exportFrom = `${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, '0')}-01`;
      exportTo = todayISO();
    } else if (v === 'thisMonth') {
      exportFrom = `${y}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
      exportTo = todayISO();
    }
    if (v !== 'custom') {
      if (fromEl) fromEl.value = exportFrom || '';
      if (toEl) toEl.value = exportTo || '';
    }
  });
  // Manual edits flip the preset back to "custom" so the dropdown reflects
  // reality.
  const flipToCustom = () => { if (presetSel) presetSel.value = 'custom'; };
  fromEl?.addEventListener('change', flipToCustom);
  toEl?.addEventListener('change', flipToCustom);
  document.getElementById('inc-export-csv')?.addEventListener('click', () => {
    const range = computeIncomeRange();
    if (!range) { toast(t('income.export.invalidRange'), 'warning'); return; }
    exportIncomeCSV(range);
  });
  document.getElementById('inc-export-pdf')?.addEventListener('click', () => {
    const range = computeIncomeRange();
    if (!range) { toast(t('income.export.invalidRange'), 'warning'); return; }
    exportIncomePDF(range);
  });
  document.querySelectorAll('[data-act="cell"]').forEach(c => c.addEventListener('click', () => {
    const apt = getApartments().find(a => a.id === c.dataset.aid);
    openMonthPaymentsDialog(apt, curYear, Number(c.dataset.m));
  }));
}

function renderRow(apt, isAdmin) {
  // ---- Per-month aggregates for THIS apartment (pre-computed once) ----
  // 1. Infrastructure payments — sum, bucketed by paid_on calendar month.
  const aptDemandIds = new Set(
    getInfrastructureDemands().filter(d => d.apartmentId === apt.id).map(d => d.id)
  );
  const infraByMonth = new Array(13).fill(0);
  for (const p of getInfrastructurePayments()) {
    if (!p.paidOn) continue;
    if (!aptDemandIds.has(p.demandId)) continue;
    const d = new Date(p.paidOn);
    if (d.getFullYear() !== curYear) continue;
    infraByMonth[d.getMonth() + 1] += Number(p.amount) || 0;
  }
  // 2. Adjustment-charge payments — same idea. adjustment_payments carry
  //    adjustmentId; chase that to the parent adjustment for the apartment
  //    filter.
  const aptAdjIds = new Set(
    getAdjustments().filter(a => a.apartmentId === apt.id && a.kind === 'charge').map(a => a.id)
  );
  const adjByMonth = new Array(13).fill(0);
  for (const p of getAdjustmentPayments()) {
    if (!p.paidOn) continue;
    if (!aptAdjIds.has(p.adjustmentId)) continue;
    const d = new Date(p.paidOn);
    if (d.getFullYear() !== curYear) continue;
    adjByMonth[d.getMonth() + 1] += Number(p.amount) || 0;
  }

  // ---- Future-month detection ----
  // For the displayed curYear, anything strictly after the current calendar
  // month is "future" and shouldn't show a red חוב — it's just an expected
  // upcoming payment. Years entirely in the past treat every month as past;
  // years entirely in the future treat every month as future.
  const now = new Date();
  const todayY = now.getFullYear();
  const todayM = now.getMonth() + 1;
  const isFutureMonth = (m) => {
    if (curYear > todayY) return true;
    if (curYear < todayY) return false;
    return m > todayM;
  };

  const cells = [];
  let rowPaid = 0;
  let rowInfra = 0;
  let rowAdj = 0;
  for (let m = 1; m <= 12; m++) {
    const st = apartmentMonthStatus(apt.id, curYear, m);
    rowPaid += st.paid;
    const infra = infraByMonth[m];
    rowInfra += infra;
    const adj = adjByMonth[m];
    rowAdj += adj;
    const shortfall = Math.max(0, st.expected - st.paid);
    const future = isFutureMonth(m);
    const bg = st.status === 'paid' ? 'var(--c-success-soft)' : st.status === 'partial' ? 'var(--c-warning-soft)' : 'transparent';
    const color = st.status === 'paid' ? 'var(--c-success)' : st.status === 'partial' ? 'var(--c-warning)' : 'var(--c-text-subtle)';

    // Tooltip — plain-text breakdown of every contribution to this cell.
    const tip = [
      `${monthName(m)} ${curYear}`,
      `${t('income.cell.tooltip.monthly')}: ${fmtCurrency(st.paid)} / ${fmtCurrency(st.expected)}`,
      ...(infra > 0 ? [`${t('income.cell.tooltip.infrastructure')}: ${fmtCurrency(infra)}`] : []),
      ...(adj > 0 ? [`${t('income.cell.tooltip.charges')}: ${fmtCurrency(adj)}`] : []),
      ...(shortfall > 0 ? [`${future ? t('income.cell.tooltip.upcoming') : t('income.cell.tooltip.debt')}: ${fmtCurrency(shortfall)}`] : []),
    ].join('\n');

    // Visual layout:
    //   ₪280.00              ← monthly paid (or — if none)
    //   +₪400 תשתית         ← infra paid in this calendar month
    //   +₪520 חיוב          ← adjustment-charge paid in this month
    //   חוב ₪40 / צפוי ₪40  ← debt (past/current → red) or upcoming (future → muted)
    const monthlyLine = st.paid > 0 ? fmtCurrency(st.paid) : '—';
    const infraLine = infra > 0
      ? `<div style="font-size:10px; color:var(--c-info); font-weight:500; margin-top:2px">+${fmtCurrency(infra)} ${esc(t('income.cell.infraShort'))}</div>`
      : '';
    const adjLine = adj > 0
      ? `<div style="font-size:10px; color:var(--c-accent-hover); font-weight:500; margin-top:2px">+${fmtCurrency(adj)} ${esc(t('income.cell.chargeShort'))}</div>`
      : '';
    let shortfallLine = '';
    if (shortfall > 0) {
      // Past/current month → real debt, red. Future month → softer "צפוי"
      // in muted grey so a year-view doesn't look like a wall of debt.
      const stylePast = 'font-size:10px; color:var(--c-danger); font-weight:500; margin-top:2px';
      const styleFuture = 'font-size:10px; color:var(--c-text-subtle); font-weight:400; margin-top:2px';
      const label = future ? t('income.cell.upcomingShort') : t('income.cell.debtShort');
      shortfallLine = `<div style="${future ? styleFuture : stylePast}">${esc(label)} ${fmtCurrency(shortfall)}</div>`;
    }
    cells.push(`
      <td class="num" data-act="cell" data-aid="${apt.id}" data-m="${m}" style="background:${bg}; color:${color}; cursor:pointer; font-weight:600; vertical-align:top" title="${esc(tip)}">
        <div>${monthlyLine}</div>
        ${infraLine}
        ${adjLine}
        ${shortfallLine}
      </td>
    `);
  }

  // Row total reflects every cash inflow attributed to this apartment in
  // the displayed year (monthly + infra + charges). When any of the
  // non-monthly streams are non-zero, surface the split as a small note.
  const rowTotal = rowPaid + rowInfra + rowAdj;
  const splitNote = (rowInfra > 0 || rowAdj > 0)
    ? `<div class="muted" style="font-size:10px">${esc(t('income.cell.totalSplit2', { monthly: fmtCurrency(rowPaid), infra: fmtCurrency(rowInfra), charges: fmtCurrency(rowAdj) }))}</div>`
    : '';
  const totalCell = `<td class="num"><strong>${fmtCurrency(rowTotal)}</strong>${splitNote}</td>`;

  // Apartment-level outstanding shown subtly under the owner name so the
  // admin can see who's actually behind without scanning every cell. Uses
  // apartmentOutstanding which already nets monthly + charges + infra and
  // respects the opening date.
  const out = apartmentOutstanding(apt.id, curYear, 12);
  const outLabel = out > 0
    ? `<div style="font-size:11px; color:var(--c-danger); font-weight:500">${esc(t('income.row.totalDebt', { amount: fmtCurrency(out) }))}</div>`
    : (out < 0
        ? `<div style="font-size:11px; color:var(--c-success); font-weight:500">${esc(t('income.row.totalCredit', { amount: fmtCurrency(Math.abs(out)) }))}</div>`
        : '');

  return `
    <tr>
      <td class="nowrap">
        <strong>${esc(String(apt.number))}</strong>
        ${apt.owner ? `<div class="muted" style="font-size:12px">${esc(apt.owner)}</div>` : ''}
        ${outLabel}
      </td>
      ${cells.join('')}
      ${totalCell}
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

// Returns the list of (year, month) pairs spanning [exportFrom..exportTo].
// Falls back to the current year when either bound is missing. Returns null
// if the range is reversed or empty.
function computeIncomeRange() {
  const from = exportFrom || `${curYear}-01-01`;
  const to = exportTo || `${curYear}-12-31`;
  const f = new Date(from);
  const tt = new Date(to);
  if (isNaN(f.getTime()) || isNaN(tt.getTime()) || f.getTime() > tt.getTime()) return null;
  const months = [];
  let y = f.getFullYear();
  let m = f.getMonth() + 1;
  const endY = tt.getFullYear();
  const endM = tt.getMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    months.push({ year: y, month: m });
    if (m === 12) { m = 1; y++; } else { m++; }
  }
  return { from, to, months };
}

// Builds the dataset shared by both CSV and PDF: per-apartment rows, each
// with per-month [expected, paid] cells across the range, plus running and
// per-month totals. Adjustment-payment income is added to the per-month
// "paid" line in the totals row (and is shown as an extra footer line).
function computeIncomeReport(range) {
  const apts = [...getApartments()].sort((a, b) =>
    String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  const rows = apts.map(apt => {
    const cells = range.months.map(({ year, month }) => {
      const st = apartmentMonthStatus(apt.id, year, month);
      return { year, month, expected: st.expected || 0, paid: st.paid || 0 };
    });
    const expected = cells.reduce((s, c) => s + c.expected, 0);
    const paid = cells.reduce((s, c) => s + c.paid, 0);
    return { apt, cells, expected, paid, balance: paid - expected };
  });
  const monthlyTotals = range.months.map(({ year, month }) => {
    const expected = rows.reduce((s, r) => s + (r.cells.find(c => c.year === year && c.month === month)?.expected || 0), 0);
    const paid = rows.reduce((s, r) => s + (r.cells.find(c => c.year === year && c.month === month)?.paid || 0), 0);
    const adjustments = adjustmentIncomeForMonth(year, month);
    const infrastructure = infrastructureIncomeForMonth(year, month);
    return { year, month, expected, paid, adjustments, infrastructure };
  });
  const grandExpected = monthlyTotals.reduce((s, x) => s + x.expected, 0);
  const grandPaid = monthlyTotals.reduce((s, x) => s + x.paid, 0);
  const grandAdj = monthlyTotals.reduce((s, x) => s + x.adjustments, 0);
  const grandInfra = monthlyTotals.reduce((s, x) => s + x.infrastructure, 0);
  return { rows, monthlyTotals, grandExpected, grandPaid, grandAdj, grandInfra };
}

// CSV export of the income report. UTF-8 BOM keeps Excel happy with Hebrew.
// Two-line header per month (e.g., "ינואר 2026 — צפוי" / "ינואר 2026 — שולם")
// so each cell stays a number Excel can sum directly.
function exportIncomeCSV(range) {
  const data = computeIncomeReport(range);
  const q = (s) => {
    if (s == null) return '';
    const str = String(s).replace(/"/g, '""');
    return /[",\n\r]/.test(str) ? `"${str}"` : str;
  };
  const monthLabel = ({ year, month }) => `${monthName(month)} ${year}`;
  // Header row
  const head = [t('apt.col.number'), t('apt.col.owner')];
  for (const ym of range.months) {
    head.push(`${monthLabel(ym)} — ${t('reports.col.expected')}`);
    head.push(`${monthLabel(ym)} — ${t('reports.col.actual')}`);
  }
  head.push(t('reports.col.expected'), t('reports.col.actual'), t('income.export.col.balance'));
  const lines = [head.map(q).join(',')];
  // Apartment rows
  for (const r of data.rows) {
    const row = [r.apt.number, r.apt.ownerName || r.apt.owner || ''];
    for (const c of r.cells) {
      row.push(c.expected.toFixed(2));
      row.push(c.paid.toFixed(2));
    }
    row.push(r.expected.toFixed(2), r.paid.toFixed(2), r.balance.toFixed(2));
    lines.push(row.map(q).join(','));
  }
  // Per-month totals row
  const totals = ['', t('income.collected')];
  for (const m of data.monthlyTotals) {
    totals.push(m.expected.toFixed(2));
    totals.push(m.paid.toFixed(2));
  }
  totals.push(data.grandExpected.toFixed(2), data.grandPaid.toFixed(2), (data.grandPaid - data.grandExpected).toFixed(2));
  lines.push(totals.map(q).join(','));
  // Adjustment-payment line (if any)
  if (data.grandAdj > 0) {
    const adj = ['', t('income.adjustmentPayments')];
    for (const m of data.monthlyTotals) { adj.push(''); adj.push(m.adjustments.toFixed(2)); }
    adj.push('', data.grandAdj.toFixed(2), '');
    lines.push(adj.map(q).join(','));
  }
  // Infrastructure-payment line (if any) — same shape as the adjustment line.
  if (data.grandInfra > 0) {
    const infra = ['', t('income.infrastructurePayments')];
    for (const m of data.monthlyTotals) { infra.push(''); infra.push(m.infrastructure.toFixed(2)); }
    infra.push('', data.grandInfra.toFixed(2), '');
    lines.push(infra.map(q).join(','));
  }
  const BOM = '﻿';
  const filename = `income_${range.from}_to_${range.to}.csv`;
  downloadBlob(new Blob([BOM + lines.join('\n')], { type: 'text/csv;charset=utf-8' }), filename);
}

// PDF export — opens a print-friendly Blob URL and triggers the browser's
// print dialog so the user can save as PDF.
function exportIncomePDF(range) {
  const data = computeIncomeReport(range);
  const dir = document.documentElement.getAttribute('dir') || 'rtl';
  const title = t('income.export.pdfTitle');
  const monthLabel = ({ year, month }) => `${monthName(month)} ${year}`;
  const cellStatus = (c) => {
    if (c.paid === 0) return 'unpaid';
    if (c.paid + 0.001 >= c.expected) return 'paid';
    return 'partial';
  };
  const html = `<!doctype html>
<html lang="he" dir="${dir}">
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:18px;color:#111}
    h1{font-size:20px;margin:0 0 4px}
    .meta{color:#555;font-size:12px;margin-bottom:14px}
    table{border-collapse:collapse;width:100%;font-size:11px}
    th,td{border:1px solid #ccc;padding:4px 6px;text-align:start;vertical-align:top}
    th{background:#f3f3f3;font-weight:600;text-align:center}
    .num{text-align:end;font-variant-numeric:tabular-nums}
    .paid{color:#1f7a52}
    .partial{color:#a6730d}
    .unpaid{color:#888}
    tfoot td{background:#f8f8f8;font-weight:600}
    @media print{body{margin:8px} table{font-size:10px}}
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(fmtDate(range.from))} — ${esc(fmtDate(range.to))} · ${esc(t('income.export.aptCount', { n: data.rows.length }))} · ${esc(fmtDate(todayISO()))}</div>
  <table>
    <thead>
      <tr>
        <th rowspan="2">${esc(t('apt.col.number'))}</th>
        <th rowspan="2">${esc(t('apt.col.owner'))}</th>
        ${range.months.map(ym => `<th colspan="2">${esc(monthLabel(ym))}</th>`).join('')}
        <th colspan="3">${esc(t('common.total'))}</th>
      </tr>
      <tr>
        ${range.months.map(() => `<th class="num">${esc(t('reports.col.expected'))}</th><th class="num">${esc(t('reports.col.actual'))}</th>`).join('')}
        <th class="num">${esc(t('reports.col.expected'))}</th>
        <th class="num">${esc(t('reports.col.actual'))}</th>
        <th class="num">${esc(t('income.export.col.balance'))}</th>
      </tr>
    </thead>
    <tbody>
      ${data.rows.map(r => `
        <tr>
          <td><strong>${esc(String(r.apt.number))}</strong></td>
          <td>${esc(r.apt.ownerName || r.apt.owner || '—')}</td>
          ${r.cells.map(c => `
            <td class="num muted">${esc(fmtCurrency(c.expected))}</td>
            <td class="num ${cellStatus(c)}">${esc(fmtCurrency(c.paid))}</td>
          `).join('')}
          <td class="num">${esc(fmtCurrency(r.expected))}</td>
          <td class="num paid">${esc(fmtCurrency(r.paid))}</td>
          <td class="num ${r.balance >= 0 ? 'paid' : 'partial'}">${esc(fmtCurrency(r.balance))}</td>
        </tr>
      `).join('')}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="2">${esc(t('income.collected'))}</td>
        ${data.monthlyTotals.map(m => `
          <td class="num">${esc(fmtCurrency(m.expected))}</td>
          <td class="num">${esc(fmtCurrency(m.paid))}</td>
        `).join('')}
        <td class="num">${esc(fmtCurrency(data.grandExpected))}</td>
        <td class="num">${esc(fmtCurrency(data.grandPaid))}</td>
        <td class="num">${esc(fmtCurrency(data.grandPaid - data.grandExpected))}</td>
      </tr>
      ${data.grandAdj > 0 ? `
        <tr>
          <td colspan="2">${esc(t('income.adjustmentPayments'))}</td>
          ${data.monthlyTotals.map(m => `<td class="num"></td><td class="num paid">${m.adjustments > 0 ? '+' + esc(fmtCurrency(m.adjustments)) : '—'}</td>`).join('')}
          <td class="num"></td>
          <td class="num paid">+${esc(fmtCurrency(data.grandAdj))}</td>
          <td class="num"></td>
        </tr>
      ` : ''}
      ${data.grandInfra > 0 ? `
        <tr>
          <td colspan="2">${esc(t('income.infrastructurePayments'))}</td>
          ${data.monthlyTotals.map(m => `<td class="num"></td><td class="num paid">${m.infrastructure > 0 ? '+' + esc(fmtCurrency(m.infrastructure)) : '—'}</td>`).join('')}
          <td class="num"></td>
          <td class="num paid">+${esc(fmtCurrency(data.grandInfra))}</td>
          <td class="num"></td>
        </tr>
      ` : ''}
    </tfoot>
  </table>
</body>
</html>`;
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
