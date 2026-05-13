// Dashboard — at-a-glance summary

import { getApartments, getPayments, getExpenses, getSettings } from '../store.js';
import { fmtCurrency, fmtMonth, esc, valueAtMonth } from '../utils.js';
import { t, monthName } from '../i18n.js';
import { monthSummary, yearSummary, expectedIncomeForMonth, actualIncomeForMonth, cumulativeBalance, expiringSoon, apartmentOutstanding } from '../calc.js';
import { setHTML, renderPageHeader, Icon } from '../ui.js';

export function renderDashboard() {
  const main = document.getElementById('app-main');
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const settings = getSettings();
  const cnt = valueAtMonth(settings.apartmentCountHistory, year, month);
  const fee = valueAtMonth(settings.monthlyFeeHistory, year, month);

  const ms = monthSummary(year, month, 'cash');
  const ys = yearSummary(year, 'cash');
  const cumulative = cumulativeBalance(year, month);
  const collectionRate = ms.incomeExpected > 0 ? Math.round((ms.incomeActual / ms.incomeExpected) * 100) : 0;

  // Aggregate per-apartment outstanding: positive = residents net owe the
  // building; negative = residents have net prepaid. Both kinds (יתרת חיוב
  // and יתרת זכות) contribute with sign so the number reflects reality
  // across the whole building.
  let aptNet = 0, aptDebt = 0, aptCredit = 0;
  for (const a of getApartments()) {
    const o = apartmentOutstanding(a.id, year, 12);
    aptNet += o;
    if (o > 0) aptDebt += o;
    else if (o < 0) aptCredit += -o;
  }

  const expiring = expiringSoon(60);

  const bars = [];
  let by = year, bm = month;
  for (let i = 0; i < 12; i++) {
    const s = monthSummary(by, bm, 'cash');
    bars.unshift({ year: by, month: bm, income: s.income, expenses: s.expenses, balance: s.balance });
    bm--; if (bm < 1) { bm = 12; by--; }
  }
  const max = Math.max(1, ...bars.flatMap(b => [b.income, b.expenses]));

  setHTML(main, `
    ${renderPageHeader({
      title: t('dash.title'),
      subtitle: t('dash.subtitle', { building: settings.buildingName || t('building.default'), month: fmtMonth(year, month) }),
    })}

    <div class="stats-grid">
      <div class="stat">
        <div class="stat__label">${esc(t('dash.activeApts'))}</div>
        <div class="stat__value">${cnt ? cnt.count : 0}</div>
        <div class="stat__hint">${esc(t('dash.monthlyFee', { amount: fmtCurrency(fee ? fee.amount : 0) }))}</div>
      </div>
      <div class="stat stat--success">
        <div class="stat__label">${esc(t('dash.incomeMonth'))}</div>
        <div class="stat__value">${fmtCurrency(ms.incomeActual)}</div>
        <div class="stat__hint">${esc(t('dash.expectedMonth', { amount: fmtCurrency(ms.incomeExpected), pct: collectionRate }))}</div>
      </div>
      <div class="stat stat--danger">
        <div class="stat__label">${esc(t('dash.expensesMonth'))}</div>
        <div class="stat__value">${fmtCurrency(ms.expenses)}</div>
        <div class="stat__hint">${esc(t('dash.cashflow'))}</div>
      </div>
      <div class="stat ${ms.balance >= 0 ? '' : 'stat--danger'}">
        <div class="stat__label">${esc(t('dash.balanceMonth'))}</div>
        <div class="stat__value">${fmtCurrency(ms.balance)}</div>
        <div class="stat__hint ${ms.balance >= 0 ? 'stat__hint--positive' : 'stat__hint--negative'}">${esc(ms.balance >= 0 ? t('dash.surplus') : t('dash.deficit'))}</div>
      </div>
      <div class="stat stat--accent">
        <div class="stat__label">${esc(t('dash.cumulative'))}</div>
        <div class="stat__value">${fmtCurrency(cumulative)}</div>
        <div class="stat__hint">${esc(t('dash.includesOpening'))}</div>
      </div>
      <div class="stat ${aptNet > 0 ? 'stat--danger' : aptNet < 0 ? 'stat--success' : ''}">
        <div class="stat__label">${esc(t('dash.aptOutstanding'))}</div>
        <div class="stat__value">${
          aptNet > 0 ? fmtCurrency(aptNet)
          : aptNet < 0 ? '+' + fmtCurrency(Math.abs(aptNet))
          : fmtCurrency(0)
        }</div>
        <div class="stat__hint">
          ${esc(
            aptNet > 0 ? t('dash.aptOutstanding.debt')
            : aptNet < 0 ? t('dash.aptOutstanding.credit')
            : t('dash.aptOutstanding.settled')
          )}
          ${(aptDebt > 0 && aptCredit > 0)
            ? `<div class="muted" style="font-size:11px; margin-top:2px">${esc(t('dash.aptOutstanding.split', { debt: fmtCurrency(aptDebt), credit: fmtCurrency(aptCredit) }))}</div>`
            : ''}
        </div>
      </div>
    </div>

    <div class="split-cols" style="grid-template-columns: 2fr 1fr">
      <div class="card card--padless">
        <div class="card__header">
          <h3 class="card__title">${esc(t('dash.last12'))}</h3>
          <div class="legend">
            <span class="legend__item"><span class="legend__swatch" style="background:var(--c-success)"></span> ${esc(t('dash.income'))}</span>
            <span class="legend__item"><span class="legend__swatch" style="background:var(--c-danger)"></span> ${esc(t('dash.expenses'))}</span>
          </div>
        </div>
        <div class="card__body">
          <div class="bars">
            ${bars.map(b => `
              <div class="bar-col" title="${monthName(b.month, true)} ${b.year}: ${esc(t('dash.income'))} ${fmtCurrency(b.income)} · ${esc(t('dash.expenses'))} ${fmtCurrency(b.expenses)}">
                <div class="bar bar--income" style="height:${(b.income/max*100).toFixed(1)}%"></div>
                <div class="bar bar--expense" style="height:${(b.expenses/max*100).toFixed(1)}%"></div>
              </div>
            `).join('')}
          </div>
          <div class="bar-labels">
            ${bars.map(b => `<div>${monthName(b.month, true)}</div>`).join('')}
          </div>
        </div>
      </div>

      <div class="card card--padless">
        <div class="card__header"><h3 class="card__title">${esc(t('dash.yearSummary', { year }))}</h3></div>
        <div class="card__body" style="padding:14px 20px">
          <div class="vstack" style="gap:14px">
            <div>
              <div class="muted" style="font-size:12px; margin-bottom:4px">${esc(t('dash.actualIncome'))}</div>
              <div style="font-size:20px; font-weight:700; color:var(--c-success)">${fmtCurrency(ys.incomeActual)}</div>
              <div class="muted" style="font-size:12px">${esc(t('dash.outOfExpected', { amount: fmtCurrency(ys.incomeExpected) }))}</div>
            </div>
            <div>
              <div class="muted" style="font-size:12px; margin-bottom:4px">${esc(t('dash.expensesTotal'))}</div>
              <div style="font-size:20px; font-weight:700; color:var(--c-danger)">${fmtCurrency(ys.expenses)}</div>
            </div>
            <div style="border-top:1px solid var(--c-border); padding-top:12px">
              <div class="muted" style="font-size:12px; margin-bottom:4px">${esc(t('dash.yearBalance'))}</div>
              <div style="font-size:24px; font-weight:700; color:${ys.balance >= 0 ? 'var(--c-success)' : 'var(--c-danger)'}">${fmtCurrency(ys.balance)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    ${expiring.length > 0 ? `
      <div class="card" style="margin-top:18px">
        <div class="hstack" style="margin-bottom:12px">
          <h3 style="margin:0">${Icon.warn} ${esc(t('dash.expiringSoon'))}</h3>
          <span class="badge badge--warning">${expiring.length}</span>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>${esc(t('common.name'))}</th><th>${esc(t('common.category'))}</th><th>${esc(t('exp.col.type'))}</th><th class="num">${esc(t('common.amount'))}</th><th>${esc(t('dash.endsOn'))}</th></tr></thead>
            <tbody>
              ${expiring.map(e => `
                <tr>
                  <td>${esc(e.name)}</td>
                  <td>${esc(e.category || '—')}</td>
                  <td>${esc(t('exp.type.' + e.type))}</td>
                  <td class="num">${fmtCurrency(e.amount)}</td>
                  <td>${new Date(e.endDate).toLocaleDateString()}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}
  `);
}
