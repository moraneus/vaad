// Reports — monthly / yearly / custom range · cash flow vs accounting · CSV / PDF print

import { getApartments, getPayments, getExpenses, getSettings } from '../store.js';
import { fmtCurrency, esc, fmtDate, fmtMonth, downloadBlob, todayISO } from '../utils.js';
import { t, monthName } from '../i18n.js';
import { monthSummary, yearSummary, rangeSummary, aggregateByCategory, cumulativeBalance, knownYears } from '../calc.js';
import { setHTML, renderPageHeader, Icon } from '../ui.js';

let scope = 'monthly';
let curYear = new Date().getFullYear();
let curMonth = new Date().getMonth() + 1;
let mode = 'cash';
// Custom-range scope state. Defaults to the current quarter (3-months back
// through today) on first activation.
let rangeFrom = null;
let rangeTo = null;

export function renderReports() {
  const main = document.getElementById('app-main');
  const years = knownYears();
  if (!years.includes(curYear)) curYear = years[0] || new Date().getFullYear();

  setHTML(main, `
    ${renderPageHeader({
      title: t('reports.title'),
      subtitle: t('reports.subtitle'),
      actions: `
        <button class="btn" id="export-csv">${Icon.download} ${esc(t('common.exportCsv'))}</button>
        <button class="btn btn--primary" id="print-pdf">${Icon.print} ${esc(t('common.exportPdf'))}</button>
      `,
    })}

    <div class="toolbar" style="gap:6px; flex-wrap:nowrap; overflow-x:auto">
      <select class="select" id="r-scope" style="width:auto">
        <option value="monthly" ${scope === 'monthly' ? 'selected' : ''}>${esc(t('reports.scope.monthly'))}</option>
        <option value="yearly"  ${scope === 'yearly'  ? 'selected' : ''}>${esc(t('reports.scope.yearly'))}</option>
        <option value="range"   ${scope === 'range'   ? 'selected' : ''}>${esc(t('income.export.preset.custom'))}</option>
      </select>
      <select class="select" id="year" style="width:110px; display:${scope === 'range' ? 'none' : 'inline-block'}">
        ${years.map(y => `<option ${y === curYear ? 'selected' : ''} value="${y}">${y}</option>`).join('')}
      </select>
      <select class="select" id="month" style="width:140px; display:${scope === 'monthly' ? 'inline-block' : 'none'}">
        ${Array.from({ length: 12 }, (_, i) => `<option ${i + 1 === curMonth ? 'selected' : ''} value="${i + 1}">${monthName(i + 1)}</option>`).join('')}
      </select>
      <input class="input" id="r-from" type="date" value="${esc(rangeFrom || '')}" style="width:140px; display:${scope === 'range' ? 'inline-block' : 'none'}" title="${esc(t('exp.filter.from'))}" />
      <input class="input" id="r-to" type="date" value="${esc(rangeTo || '')}" style="width:140px; display:${scope === 'range' ? 'inline-block' : 'none'}" title="${esc(t('exp.filter.to'))}" />
      <div class="spacer"></div>
      <div class="segmented">
        <button class="segmented__opt ${mode==='cash'?'segmented__opt--active':''}" data-mode="cash">${esc(t('reports.cash'))}</button>
        <button class="segmented__opt ${mode==='accounting'?'segmented__opt--active':''}" data-mode="accounting">${esc(t('reports.accounting'))}</button>
      </div>
    </div>

    <div id="report-body"></div>
  `);

  // Single scope dropdown — switching to 'range' seeds default dates if the
  // admin hasn't picked any yet (last 3 months through today).
  document.getElementById('r-scope').addEventListener('change', (e) => {
    scope = e.target.value;
    if (scope === 'range' && (!rangeFrom || !rangeTo)) {
      const today = new Date();
      const back = new Date(today); back.setMonth(today.getMonth() - 2); back.setDate(1);
      rangeFrom = `${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, '0')}-01`;
      rangeTo = todayISO();
    }
    renderReports();
  });
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; renderReports(); }));
  document.getElementById('year').addEventListener('change', (e) => { curYear = Number(e.target.value); renderReports(); });
  document.getElementById('month').addEventListener('change', (e) => { curMonth = Number(e.target.value); renderReports(); });
  document.getElementById('r-from')?.addEventListener('change', (e) => { rangeFrom = e.target.value || null; renderReports(); });
  document.getElementById('r-to')?.addEventListener('change', (e) => { rangeTo = e.target.value || null; renderReports(); });
  document.getElementById('print-pdf').addEventListener('click', () => window.print());
  document.getElementById('export-csv').addEventListener('click', exportCSV);

  if (scope === 'monthly') renderMonthlyReport();
  else if (scope === 'yearly') renderYearlyReport();
  else renderRangeReport();
}

function renderMonthlyReport() {
  const body = document.getElementById('report-body');
  const ms = monthSummary(curYear, curMonth, mode);
  const settings = getSettings();
  const cum = cumulativeBalance(curYear, curMonth);
  // Build a per-expense map of expected & actual amounts for this month
  const perExpense = new Map();
  for (const it of ms.expectedExpenseList) {
    perExpense.set(it.expense.id, { expense: it.expense, expected: it.amount, actual: 0, mode: it.mode });
  }
  for (const it of ms.actualExpenseList) {
    const existing = perExpense.get(it.expense.id);
    if (existing) existing.actual += it.amount;
    else perExpense.set(it.expense.id, { expense: it.expense, expected: 0, actual: it.amount });
  }
  // Per-row "expected" displayed in the report = REMAINING to pay, not the
  // original budget. Aligns with the in_progress / done model: once an expense
  // is paid in full, nothing should appear in the "expected" column for it.
  for (const row of perExpense.values()) {
    row.remaining = Math.max(0, row.expected - row.actual);
  }
  const expenseRows = [...perExpense.values()].sort((a, b) => (b.actual + b.remaining) - (a.actual + a.remaining));
  const totalRemaining = expenseRows.reduce((s, it) => s + it.remaining, 0);
  const totalActual = expenseRows.reduce((s, it) => s + it.actual, 0);
  // "Scope" = combined value for execution percentage. Capped so over-budget
  // rows don't push the percentage above 100.
  const totalScope = expenseRows.reduce((s, it) => s + Math.max(it.actual, it.expected), 0);
  const incomeCollectionPct = ms.incomeExpected > 0 ? Math.round((ms.incomeActual / ms.incomeExpected) * 100) : 0;
  const expenseExecPct = totalScope > 0 ? Math.round((totalActual / totalScope) * 100) : (totalActual > 0 ? 100 : 0);
  const modeLabelStr = mode === 'cash' ? t('reports.cash') : t('reports.accounting');

  // Category aggregation — actual only (since that's the real spend)
  const cats = aggregateByCategory(ms.actualExpenseList);

  setHTML(body, `
    <div class="print-header" style="display:none">
      <h1>${esc(t('reports.print.monthly', { month: fmtMonth(curYear, curMonth) }))}</h1>
      <div class="meta">${esc(t('reports.print.generated', { building: settings.buildingName || t('building.default'), mode: modeLabelStr, date: fmtDate(new Date().toISOString()) }))}</div>
    </div>

    <div class="callout">${esc(t('reports.note.future'))}</div>

    <div class="stats-grid">
      <div class="stat stat--success">
        <div class="stat__label">${esc(t('dash.income'))} · ${esc(t('reports.expectedActual.short'))}</div>
        <div class="stat__value">${fmtCurrency(ms.incomeActual)}</div>
        <div class="stat__hint">${esc(t('reports.expectedShort', { amount: fmtCurrency(ms.incomeExpected) }))}</div>
        <div class="progress" style="margin-top:6px"><div class="progress__bar progress__bar--success" style="width:${Math.min(100, incomeCollectionPct)}%"></div></div>
        <div class="stat__hint">${esc(t('reports.collectionPct', { pct: incomeCollectionPct }))}</div>
      </div>
      <div class="stat stat--danger">
        <div class="stat__label">${esc(t('dash.expenses'))} · ${esc(t('reports.expectedActual.short'))}</div>
        <div class="stat__value">${fmtCurrency(totalActual)}</div>
        <div class="stat__hint">${esc(t('reports.remainingShort', { amount: fmtCurrency(totalRemaining) }))}</div>
        <div class="progress" style="margin-top:6px"><div class="progress__bar progress__bar--danger" style="width:${Math.min(100, expenseExecPct)}%"></div></div>
        <div class="stat__hint">${esc(t('reports.executionPct', { pct: expenseExecPct }))}</div>
      </div>
      <div class="stat ${ms.balance >= 0 ? '' : 'stat--danger'}">
        <div class="stat__label">${esc(t('reports.actualBalance'))}</div>
        <div class="stat__value">${fmtCurrency(ms.balance)}</div>
        <div class="stat__hint">${esc(t('reports.actualBalanceMonthlyHint'))}</div>
        <div class="stat__hint">${esc(t('reports.expectedBalance'))}: ${fmtCurrency(ms.expectedBalance)}</div>
      </div>
      <div class="stat stat--accent">
        <div class="stat__label">${esc(t('reports.cumulative'))}</div>
        <div class="stat__value">${fmtCurrency(cum)}</div>
        <div class="stat__hint">${esc(t('reports.cumulativeHint'))}</div>
        <div class="stat__hint muted">${esc(t('reports.endOf', { month: fmtMonth(curYear, curMonth) }))}</div>
      </div>
    </div>

    <div class="card card--padless" style="margin-bottom:18px">
      <div class="card__header"><h3 class="card__title">${esc(t('reports.byExpense'))}</h3></div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>${esc(t('common.name'))}</th>
              <th>${esc(t('common.category'))}</th>
              <th>${esc(t('exp.col.type'))}</th>
              <th class="num">${esc(t('reports.col.expected'))}</th>
              <th class="num">${esc(t('reports.col.actual'))}</th>
              <th>${esc(t('common.status'))}</th>
            </tr>
          </thead>
          <tbody>
            ${expenseRows.length === 0 ? `<tr><td colspan="6" class="muted" style="text-align:center; padding:24px">${esc(t('reports.noExpenses'))}</td></tr>` : expenseRows.map(it => {
              // Two-state status aligned with the in_progress/done model.
              const isDone = it.actual > 0 && it.actual >= it.expected;
              const status = isDone
                ? `<span class="badge badge--success">${Icon.check} ${esc(t('exp.status.done'))}</span>`
                : `<span class="badge badge--warning">${esc(t('exp.status.in_progress'))}</span>`;
              return `
                <tr>
                  <td>${esc(it.expense.name)}</td>
                  <td>${esc(it.expense.category || '—')}</td>
                  <td>${esc(t('exp.type.' + (it.expense.type || 'oneoff')))}</td>
                  <td class="num muted">${it.remaining > 0 ? fmtCurrency(it.remaining, mode === 'accounting') : '—'}</td>
                  <td class="num text-success">${it.actual > 0 ? fmtCurrency(it.actual, mode === 'accounting') : '—'}</td>
                  <td>${status}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3">${esc(t('reports.totalLabel'))}</td>
              <td class="num">${fmtCurrency(totalRemaining)}</td>
              <td class="num">${fmtCurrency(totalActual)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    ${cats.length ? `
      <div class="card card--padless">
        <div class="card__header"><h3 class="card__title">${esc(t('reports.byCategory'))} · ${esc(t('reports.col.actual'))}</h3></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>${esc(t('common.category'))}</th><th class="num">${esc(t('common.amount'))}</th><th class="num">${esc(t('reports.col.percent'))}</th></tr></thead>
            <tbody>
              ${cats.map(([c, amt]) => `
                <tr>
                  <td>${esc(c)}</td>
                  <td class="num">${fmtCurrency(amt)}</td>
                  <td class="num">${totalActual > 0 ? ((amt / totalActual) * 100).toFixed(1) : '0'}%</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}
  `);
}

function renderYearlyReport() {
  const body = document.getElementById('report-body');
  const ys = yearSummary(curYear, mode);
  const settings = getSettings();
  // Categories: actual spend only
  const allCats = new Map();
  for (const ms of ys.months) {
    for (const it of (ms.actualExpenseList || [])) {
      const c = it.expense.category || '—';
      allCats.set(c, (allCats.get(c) || 0) + it.amount);
    }
  }
  const cats = [...allCats.entries()].sort((a, b) => b[1] - a[1]);
  const modeLabelStr = mode === 'cash' ? t('reports.cash') : t('reports.accounting');
  const incomeCollectionPct = ys.incomeExpected > 0 ? Math.round((ys.incomeActual / ys.incomeExpected) * 100) : 0;
  const expenseExecPct = ys.expectedExpenses > 0 ? Math.round((ys.actualExpenses / ys.expectedExpenses) * 100) : (ys.actualExpenses > 0 ? 100 : 0);

  setHTML(body, `
    <div class="print-header" style="display:none">
      <h1>${esc(t('reports.print.yearly', { year: curYear }))}</h1>
      <div class="meta">${esc(t('reports.print.generated', { building: settings.buildingName || t('building.default'), mode: modeLabelStr, date: fmtDate(new Date().toISOString()) }))}</div>
    </div>

    <div class="callout">${esc(t('reports.note.future'))}</div>

    <div class="stats-grid">
      <div class="stat stat--success">
        <div class="stat__label">${esc(t('reports.yearIncome'))} · ${esc(t('reports.expectedActual.short'))}</div>
        <div class="stat__value">${fmtCurrency(ys.incomeActual)}</div>
        <div class="stat__hint">${esc(t('reports.expectedShort', { amount: fmtCurrency(ys.incomeExpected) }))}</div>
        <div class="progress" style="margin-top:6px"><div class="progress__bar progress__bar--success" style="width:${Math.min(100, incomeCollectionPct)}%"></div></div>
        <div class="stat__hint">${esc(t('reports.collectionPct', { pct: incomeCollectionPct }))}</div>
      </div>
      <div class="stat stat--danger">
        <div class="stat__label">${esc(t('reports.yearExpenses'))} · ${esc(t('reports.expectedActual.short'))}</div>
        <div class="stat__value">${fmtCurrency(ys.actualExpenses)}</div>
        <div class="stat__hint">${esc(t('reports.expectedShort', { amount: fmtCurrency(ys.expectedExpenses) }))}</div>
        <div class="progress" style="margin-top:6px"><div class="progress__bar progress__bar--danger" style="width:${Math.min(100, expenseExecPct)}%"></div></div>
        <div class="stat__hint">${esc(t('reports.executionPct', { pct: expenseExecPct }))}</div>
      </div>
      <div class="stat ${ys.balance >= 0 ? '' : 'stat--danger'}">
        <div class="stat__label">${esc(t('reports.actualBalance'))}</div>
        <div class="stat__value">${fmtCurrency(ys.balance)}</div>
        <div class="stat__hint">${esc(t('reports.actualBalanceMonthlyHint'))}</div>
        <div class="stat__hint">${esc(t('reports.expectedBalance'))}: ${fmtCurrency(ys.expectedBalance)}</div>
      </div>
      <div class="stat stat--accent">
        <div class="stat__label">${esc(t('reports.endYearBalance'))}</div>
        <div class="stat__value">${fmtCurrency(cumulativeBalance(curYear, 12))}</div>
        <div class="stat__hint">${esc(t('reports.endYearHint'))}</div>
      </div>
    </div>

    <div class="card card--padless" style="margin-bottom:18px">
      <div class="card__header"><h3 class="card__title">${esc(t('reports.byMonth'))}</h3></div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th rowspan="2">${esc(t('common.month'))}</th>
              <th class="num" colspan="2">${esc(t('dash.income'))}</th>
              <th class="num" colspan="2">${esc(t('dash.expenses'))}</th>
              <th class="num" rowspan="2">${esc(t('reports.actualBalance'))}</th>
              <th class="num" rowspan="2">${esc(t('reports.col.cumulative'))}</th>
            </tr>
            <tr>
              <th class="num" style="font-size:11px; font-weight:500">${esc(t('reports.col.expected'))}</th>
              <th class="num" style="font-size:11px; font-weight:500">${esc(t('reports.col.actual'))}</th>
              <th class="num" style="font-size:11px; font-weight:500">${esc(t('reports.col.expected'))}</th>
              <th class="num" style="font-size:11px; font-weight:500">${esc(t('reports.col.actual'))}</th>
            </tr>
          </thead>
          <tbody>
            ${ys.months.map((ms, i) => {
              const cum = cumulativeBalance(curYear, i + 1);
              return `
                <tr>
                  <td>${monthName(i + 1)}</td>
                  <td class="num muted">${fmtCurrency(ms.incomeExpected)}</td>
                  <td class="num text-success">${fmtCurrency(ms.incomeActual)}</td>
                  <td class="num muted">${fmtCurrency(ms.expectedExpenses)}</td>
                  <td class="num text-danger">${fmtCurrency(ms.actualExpenses)}</td>
                  <td class="num ${ms.balance >= 0 ? 'text-success' : 'text-danger'}">${fmtCurrency(ms.balance)}</td>
                  <td class="num">${fmtCurrency(cum)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td>${esc(t('reports.totalLabel'))}</td>
              <td class="num">${fmtCurrency(ys.incomeExpected)}</td>
              <td class="num">${fmtCurrency(ys.incomeActual)}</td>
              <td class="num">${fmtCurrency(ys.expectedExpenses)}</td>
              <td class="num">${fmtCurrency(ys.actualExpenses)}</td>
              <td class="num ${ys.balance >= 0 ? 'text-success' : 'text-danger'}">${fmtCurrency(ys.balance)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    ${cats.length ? `
      <div class="card card--padless">
        <div class="card__header"><h3 class="card__title">${esc(t('reports.byCategory'))}</h3></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>${esc(t('common.category'))}</th><th class="num">${esc(t('common.amount'))}</th><th class="num">${esc(t('reports.col.percent'))}</th></tr></thead>
            <tbody>
              ${cats.map(([c, amt]) => `
                <tr>
                  <td>${esc(c)}</td>
                  <td class="num">${fmtCurrency(amt)}</td>
                  <td class="num">${ys.expenses > 0 ? ((amt / ys.expenses) * 100).toFixed(1) : '0'}%</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}
  `);
}

// Custom-range report — same shape as the yearly report but bounded by the
// admin-picked [from..to] window. Shows top-line stats, a per-month
// breakdown, and a per-category actual-spend table.
function renderRangeReport() {
  const body = document.getElementById('report-body');
  if (!rangeFrom || !rangeTo) {
    setHTML(body, `<div class="callout callout--warning">${esc(t('reports.range.pickDates'))}</div>`);
    return;
  }
  const f = new Date(rangeFrom);
  const tt = new Date(rangeTo);
  if (isNaN(f.getTime()) || isNaN(tt.getTime()) || f.getTime() > tt.getTime()) {
    setHTML(body, `<div class="callout callout--warning">${esc(t('income.export.invalidRange'))}</div>`);
    return;
  }
  const rs = rangeSummary(rangeFrom, rangeTo, mode);
  const settings = getSettings();
  const allCats = new Map();
  for (const ms of rs.months) {
    for (const it of (ms.actualExpenseList || [])) {
      const c = it.expense.category || '—';
      allCats.set(c, (allCats.get(c) || 0) + it.amount);
    }
  }
  const cats = [...allCats.entries()].sort((a, b) => b[1] - a[1]);
  const modeLabelStr = mode === 'cash' ? t('reports.cash') : t('reports.accounting');
  const incomeCollectionPct = rs.incomeExpected > 0 ? Math.round((rs.incomeActual / rs.incomeExpected) * 100) : 0;
  const expenseExecPct = rs.expectedExpenses > 0 ? Math.round((rs.actualExpenses / rs.expectedExpenses) * 100) : (rs.actualExpenses > 0 ? 100 : 0);

  setHTML(body, `
    <div class="print-header" style="display:none">
      <h1>${esc(t('reports.print.range', { from: fmtDate(rangeFrom), to: fmtDate(rangeTo) }))}</h1>
      <div class="meta">${esc(t('reports.print.generated', { building: settings.buildingName || t('building.default'), mode: modeLabelStr, date: fmtDate(new Date().toISOString()) }))}</div>
    </div>

    <div class="callout">${esc(t('reports.range.headline', { from: fmtDate(rangeFrom), to: fmtDate(rangeTo), n: rs.months.length }))}</div>

    <div class="stats-grid">
      <div class="stat stat--success">
        <div class="stat__label">${esc(t('reports.yearIncome'))} · ${esc(t('reports.expectedActual.short'))}</div>
        <div class="stat__value">${fmtCurrency(rs.incomeActual)}</div>
        <div class="stat__hint">${esc(t('reports.expectedShort', { amount: fmtCurrency(rs.incomeExpected) }))}</div>
        <div class="progress" style="margin-top:6px"><div class="progress__bar progress__bar--success" style="width:${Math.min(100, incomeCollectionPct)}%"></div></div>
        <div class="stat__hint">${esc(t('reports.collectionPct', { pct: incomeCollectionPct }))}</div>
      </div>
      <div class="stat stat--danger">
        <div class="stat__label">${esc(t('reports.yearExpenses'))} · ${esc(t('reports.expectedActual.short'))}</div>
        <div class="stat__value">${fmtCurrency(rs.actualExpenses)}</div>
        <div class="stat__hint">${esc(t('reports.expectedShort', { amount: fmtCurrency(rs.expectedExpenses) }))}</div>
        <div class="progress" style="margin-top:6px"><div class="progress__bar progress__bar--danger" style="width:${Math.min(100, expenseExecPct)}%"></div></div>
        <div class="stat__hint">${esc(t('reports.executionPct', { pct: expenseExecPct }))}</div>
      </div>
      <div class="stat ${rs.balance >= 0 ? '' : 'stat--danger'}">
        <div class="stat__label">${esc(t('reports.actualBalance'))}</div>
        <div class="stat__value">${fmtCurrency(rs.balance)}</div>
        <div class="stat__hint">${esc(t('reports.expectedBalance'))}: ${fmtCurrency(rs.expectedBalance)}</div>
      </div>
    </div>

    <div class="card card--padless" style="margin-bottom:18px">
      <div class="card__header"><h3 class="card__title">${esc(t('reports.byMonth'))}</h3></div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th rowspan="2">${esc(t('common.month'))}</th>
              <th class="num" colspan="2">${esc(t('dash.income'))}</th>
              <th class="num" colspan="2">${esc(t('dash.expenses'))}</th>
              <th class="num" rowspan="2">${esc(t('reports.actualBalance'))}</th>
              <th class="num" rowspan="2">${esc(t('reports.col.cumulative'))}</th>
            </tr>
            <tr>
              <th class="num" style="font-size:11px; font-weight:500">${esc(t('reports.col.expected'))}</th>
              <th class="num" style="font-size:11px; font-weight:500">${esc(t('reports.col.actual'))}</th>
              <th class="num" style="font-size:11px; font-weight:500">${esc(t('reports.col.expected'))}</th>
              <th class="num" style="font-size:11px; font-weight:500">${esc(t('reports.col.actual'))}</th>
            </tr>
          </thead>
          <tbody>
            ${rs.months.map((ms) => `
              <tr>
                <td>${monthName(ms.month)} ${ms.year}</td>
                <td class="num muted">${fmtCurrency(ms.incomeExpected)}</td>
                <td class="num text-success">${fmtCurrency(ms.incomeActual)}</td>
                <td class="num muted">${fmtCurrency(ms.expectedExpenses)}</td>
                <td class="num text-danger">${fmtCurrency(ms.actualExpenses)}</td>
                <td class="num ${ms.balance >= 0 ? 'text-success' : 'text-danger'}">${fmtCurrency(ms.balance)}</td>
                <td class="num">${fmtCurrency(cumulativeBalance(ms.year, ms.month))}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td>${esc(t('reports.totalLabel'))}</td>
              <td class="num">${fmtCurrency(rs.incomeExpected)}</td>
              <td class="num">${fmtCurrency(rs.incomeActual)}</td>
              <td class="num">${fmtCurrency(rs.expectedExpenses)}</td>
              <td class="num">${fmtCurrency(rs.actualExpenses)}</td>
              <td class="num ${rs.balance >= 0 ? 'text-success' : 'text-danger'}">${fmtCurrency(rs.balance)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    ${cats.length ? `
      <div class="card card--padless">
        <div class="card__header"><h3 class="card__title">${esc(t('reports.byCategory'))}</h3></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>${esc(t('common.category'))}</th><th class="num">${esc(t('common.amount'))}</th><th class="num">${esc(t('reports.col.percent'))}</th></tr></thead>
            <tbody>
              ${cats.map(([c, amt]) => `
                <tr>
                  <td>${esc(c)}</td>
                  <td class="num">${fmtCurrency(amt)}</td>
                  <td class="num">${rs.expenses > 0 ? ((amt / rs.expenses) * 100).toFixed(1) : '0'}%</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}
  `);
}

function modeLabel(m) {
  return m === 'monthly' ? t('reports.calcMonthly') :
         m === 'annual-12' ? t('reports.calcAnnual12') :
         t('reports.calcOneoff');
}

function exportCSV() {
  const settings = getSettings();
  const buildingName = settings.buildingName || t('building.default');
  const BOM = '﻿';
  let csv = '';
  let filename = '';

  if (scope === 'monthly') {
    const ms = monthSummary(curYear, curMonth, mode);
    filename = t('reports.export.monthly', { ym: `${curYear}-${String(curMonth).padStart(2, '0')}`, mode });
    csv += `${t('reports.monthly')},${fmtMonth(curYear, curMonth)}\n`;
    csv += `Building,${quote(buildingName)}\n`;
    csv += `Mode,${mode === 'cash' ? t('reports.cash') : t('reports.accounting')}\n\n`;
    csv += `${t('reports.incomeExpectedLabel')},${ms.incomeExpected}\n`;
    csv += `${t('reports.incomeActualLabel')},${ms.incomeActual}\n`;
    csv += `${t('reports.expectedExpenses')},${ms.expectedExpenses}\n`;
    csv += `${t('reports.expenseActualLabel')},${ms.actualExpenses}\n`;
    csv += `${t('reports.expectedBalance')},${ms.expectedBalance}\n`;
    csv += `${t('reports.actualBalance')},${ms.balance}\n\n`;
    // Per-expense expected vs actual
    const perExp = new Map();
    for (const it of ms.expectedExpenseList) perExp.set(it.expense.id, { e: it.expense, expected: it.amount, actual: 0 });
    for (const it of ms.actualExpenseList) {
      const r = perExp.get(it.expense.id);
      if (r) r.actual += it.amount;
      else perExp.set(it.expense.id, { e: it.expense, expected: 0, actual: it.amount });
    }
    csv += `${t('common.name')},${t('common.category')},${t('exp.col.type')},${t('reports.col.expected')},${t('reports.col.actual')}\n`;
    for (const r of perExp.values()) {
      csv += `${quote(r.e.name)},${quote(r.e.category || '')},${t('exp.type.' + (r.e.type || 'oneoff'))},${r.expected.toFixed(2)},${r.actual.toFixed(2)}\n`;
    }
  } else if (scope === 'range' && rangeFrom && rangeTo) {
    // Custom-range export — same column layout as the yearly CSV but bounded
    // by the picked from..to dates. Each row carries (year + month) so the
    // file remains useful when the range spans multiple calendar years.
    const rs = rangeSummary(rangeFrom, rangeTo, mode);
    filename = t('reports.export.range', { from: rangeFrom, to: rangeTo, mode });
    csv += `${t('income.export.preset.custom')},${rangeFrom} → ${rangeTo}\n`;
    csv += `Building,${quote(buildingName)}\n`;
    csv += `Mode,${mode === 'cash' ? t('reports.cash') : t('reports.accounting')}\n\n`;
    csv += `${t('common.month')},${t('reports.incomeExpectedLabel')},${t('reports.incomeActualLabel')},${t('reports.expectedExpenses')},${t('reports.expenseActualLabel')},${t('reports.actualBalance')},${t('reports.col.cumulative')}\n`;
    for (const ms of rs.months) {
      csv += `${monthName(ms.month)} ${ms.year},${ms.incomeExpected},${ms.incomeActual},${ms.expectedExpenses},${ms.actualExpenses},${ms.balance},${cumulativeBalance(ms.year, ms.month)}\n`;
    }
    csv += `${t('reports.totalLabel')},${rs.incomeExpected},${rs.incomeActual},${rs.expectedExpenses},${rs.actualExpenses},${rs.balance},\n`;
  } else {
    const ys = yearSummary(curYear, mode);
    filename = t('reports.export.yearly', { year: curYear, mode });
    csv += `${t('reports.yearly')},${curYear}\n`;
    csv += `Building,${quote(buildingName)}\n`;
    csv += `Mode,${mode === 'cash' ? t('reports.cash') : t('reports.accounting')}\n\n`;
    csv += `${t('common.month')},${t('reports.incomeExpectedLabel')},${t('reports.incomeActualLabel')},${t('reports.expectedExpenses')},${t('reports.expenseActualLabel')},${t('reports.actualBalance')},${t('reports.col.cumulative')}\n`;
    for (let i = 0; i < 12; i++) {
      const ms = ys.months[i];
      csv += `${monthName(i + 1)},${ms.incomeExpected},${ms.incomeActual},${ms.expectedExpenses},${ms.actualExpenses},${ms.balance},${cumulativeBalance(curYear, i + 1)}\n`;
    }
    csv += `${t('reports.totalLabel')},${ys.incomeExpected},${ys.incomeActual},${ys.expectedExpenses},${ys.actualExpenses},${ys.balance},\n`;
  }
  downloadBlob(new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' }), filename);
}

function quote(s) {
  if (s == null) return '';
  const str = String(s);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const printStyle = document.createElement('style');
printStyle.textContent = '@media print { .print-header { display:block !important; } }';
document.head.appendChild(printStyle);
