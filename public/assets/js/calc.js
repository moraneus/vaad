// Income / expense / balance calculations.
// "Cash flow"     = money that actually entered/left in the period
// "Accounting"    = annual expenses spread over 12 months
//
// Expected vs Actual:
//   Expected income   = apartment count × monthly fee at that month
//   Actual income     = sum of recorded payments in that month
//   Expected expenses = computed from expense definitions + their date ranges
//   Actual expenses   = sum of recorded expense_payments in that month

import { getApartments, getPayments, getExpenses, getExpensePayments, getSettings, getAdjustments, getAdjustmentPayments, getFeeOverrides, getInfrastructureExpenses, getInfrastructureDemands, getInfrastructurePayments, getReminders } from './store.js';
import { isMonthInRange, valueAtMonth, monthKey, todayISO } from './utils.js';

// Resolve the expected fee for a single (apartment, year, month) cell.
// Per-cell overrides win over the global monthly_fee_history.
export function feeForApartmentMonth(apartmentId, year, month) {
  const override = getFeeOverrides().find(o =>
    o.apartmentId === apartmentId && o.year === year && o.month === month);
  if (override) return Number(override.amount) || 0;
  const fee = valueAtMonth(getSettings().monthlyFeeHistory, year, month);
  return fee ? Number(fee.amount) || 0 : 0;
}

// ---- Management start date (opening_balance_date) helpers ----
// All apartment-debt and cumulative-balance calculations begin from this date.
// Anything before it is considered "wrapped up" by the opening balance.
function openingDateISO() {
  const s = getSettings();
  return s.openingBalanceDate || null;
}

// Returns the later of the two ISO dates, or whichever is non-null.
function maxDate(aISO, bISO) {
  if (!aISO) return bISO;
  if (!bISO) return aISO;
  return aISO > bISO ? aISO : bISO;
}

// Is YYYY-MM strictly before the management-start month?
function monthBeforeOpening(year, month) {
  const open = openingDateISO();
  if (!open) return false;
  const od = new Date(open);
  const cur = year * 12 + (month - 1);
  const oIdx = od.getFullYear() * 12 + od.getMonth();
  return cur < oIdx;
}

// Expected income for a specific month: monthly fees + manual adjustments
// dated in the month. Charges add to expected income (apartment owes more),
// credits subtract (apartment owes less). Returns 0 for months before the
// management start date.
//
// Iterates per-apartment so that per-cell fee overrides are respected. For
// apartments without an override, the global monthly_fee_history is used.
export function expectedIncomeForMonth(year, month) {
  if (monthBeforeOpening(year, month)) return 0;
  const s = getSettings();
  const cnt = valueAtMonth(s.apartmentCountHistory, year, month);
  const apartmentCount = cnt ? cnt.count : 0;
  // Sum the per-apartment expected fee. We have apartmentCount apartments to
  // count; iterate the actual apartments registered (those with an override or
  // simply existing). For the count-only model where we don't have apartment
  // identities for all `apartmentCount` slots, fill the remainder with the
  // global fee.
  const apts = getApartments();
  let fromFees = 0;
  let identifiedCount = 0;
  for (const apt of apts) {
    if (identifiedCount >= apartmentCount) break;
    fromFees += feeForApartmentMonth(apt.id, year, month);
    identifiedCount++;
  }
  if (identifiedCount < apartmentCount) {
    // Fill in remainder using the global fee (apartments not yet recorded in
    // the apartments table, but counted by apartment_count_history).
    const fee = valueAtMonth(s.monthlyFeeHistory, year, month);
    fromFees += (apartmentCount - identifiedCount) * (fee ? Number(fee.amount) || 0 : 0);
  }

  // Adjustments anchored to this calendar month by effective_date. Excludes
  // anything dated before the management start date (consistent with the
  // outstanding-balance calculation).
  const lastDay = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, '0');
  const monthStart = `${year}-${mm}-01`;
  const monthEnd = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
  const open = openingDateISO();
  const adjustments = getAdjustments().filter(a =>
    a.effectiveDate >= monthStart && a.effectiveDate <= monthEnd
    && (!open || a.effectiveDate >= open)
  );
  const charges = adjustments.filter(a => a.kind === 'charge').reduce((s, a) => s + Number(a.amount || 0), 0);
  const credits = adjustments.filter(a => a.kind === 'credit').reduce((s, a) => s + Number(a.amount || 0), 0);

  // Infrastructure demands billed in this month — anchored to the parent
  // expense's expense_date. Each demand is a chargeable amount for an
  // apartment, so they belong in expected building-wide income alongside
  // monthly fees and one-off adjustments.
  const expensesById = new Map(getInfrastructureExpenses().map(e => [e.id, e]));
  const infraExpected = getInfrastructureDemands().reduce((sum, d) => {
    const exp = expensesById.get(d.expenseId);
    if (!exp || !exp.expenseDate) return sum;
    if (exp.expenseDate < monthStart || exp.expenseDate > monthEnd) return sum;
    if (open && exp.expenseDate < open) return sum;
    return sum + Number(d.amount || 0);
  }, 0);

  return fromFees + charges - credits + infraExpected;
}

// Actual income for a specific month — every kind of real money that came in:
//   - monthly fee payments (anchored to year/month)
//   - apartment-adjustment payments (anchored by paidOn)
//   - infrastructure demand payments (anchored by paidOn)
// All three flow into the same building bank account, so the dashboard,
// income view, reports, and cumulative balance should treat them the same.
export function actualIncomeForMonth(year, month) {
  const fromMonthly = getPayments()
    .filter(p => p.year === year && p.month === month)
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const inMonth = (iso) => {
    if (!iso) return false;
    const d = new Date(iso);
    return d.getFullYear() === year && (d.getMonth() + 1) === month;
  };
  const fromAdjustments = getAdjustmentPayments()
    .filter(p => inMonth(p.paidOn))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const fromInfrastructure = getInfrastructurePayments()
    .filter(p => inMonth(p.paidOn))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  return fromMonthly + fromAdjustments + fromInfrastructure;
}

// Per-apartment status for a given month.
// Respects the management start date (opening_balance_date) AND the apartment's
// activeFrom: months before either floor are out of scope (expected = 0).
export function apartmentMonthStatus(apartmentId, year, month) {
  const s = getSettings();
  const apt = getApartments().find(a => a.id === apartmentId);
  const cur = year * 12 + (month - 1);

  // Floor month index = max of opening date month, apartment activeFrom month.
  let floorIdx = -Infinity;
  const open = openingDateISO();
  if (open) {
    const od = new Date(open);
    floorIdx = Math.max(floorIdx, od.getFullYear() * 12 + od.getMonth());
  }
  if (apt?.activeFrom) {
    const ad = new Date(apt.activeFrom);
    floorIdx = Math.max(floorIdx, ad.getFullYear() * 12 + ad.getMonth());
  }

  const inScope = cur >= floorIdx;
  const expected = inScope ? feeForApartmentMonth(apartmentId, year, month) : 0;
  const paid = getPayments()
    .filter(p => p.apartmentId === apartmentId && p.year === year && p.month === month)
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  // Whether the expected value is from a per-cell override (for UI hint).
  const hasOverride = !!getFeeOverrides().find(o =>
    o.apartmentId === apartmentId && o.year === year && o.month === month);
  return {
    expected,
    paid,
    diff: paid - expected,
    inScope,
    hasOverride,
    status: paid === 0 ? (expected > 0 ? 'unpaid' : 'none') : (paid >= expected ? 'paid' : 'partial'),
  };
}

// ---- Expenses ----

// Effective annual amount at a given month considering rateHistory
function annualRateAt(expense, year, month) {
  if (!expense.rateHistory || !expense.rateHistory.length) return Number(expense.amount) || 0;
  const v = valueAtMonth(expense.rateHistory, year, month);
  return v ? Number(v.amount) : Number(expense.amount) || 0;
}

// EXPECTED expenses for a month (computed from definitions + dates).
// monthly: include amount if active in this month
// annual: include FULL amount in the billDate's month each year (between start..end)
// oneoff: include if oneOffDate is in this month
// infrastructure: include if expense_date is in this month (treated as a
//                 one-off charge against the building bank, regardless of
//                 how the costs get apportioned to apartments)
export function expectedExpensesForMonth(year, month) {
  const result = [];
  for (const e of getExpenses()) {
    if (e.status === 'closed') continue;

    if (e.type === 'monthly' || e.type === 'installments') {
      if (e.status === 'paused') continue;
      if (!isMonthInRange(year, month, e.startDate, e.endDate)) continue;
      // Use rate history if exists, else amount
      const amt = e.rateHistory && e.rateHistory.length ? annualRateAt(e, year, month) : (Number(e.amount) || 0);
      result.push({ expense: e, amount: amt, year, month });
    } else if (e.type === 'annual') {
      if (!e.billDate) continue;
      const bd = new Date(e.billDate);
      const billMonth = bd.getMonth() + 1;
      if (billMonth !== month) continue;
      // Year must be within range
      if (!isMonthInRange(year, month, e.startDate, e.endDate)) continue;
      const amt = annualRateAt(e, year, month);
      result.push({ expense: e, amount: amt, year, month });
    } else if (e.type === 'oneoff') {
      if (!e.oneOffDate) continue;
      const od = new Date(e.oneOffDate);
      if (od.getFullYear() === year && (od.getMonth() + 1) === month) {
        result.push({ expense: e, amount: Number(e.amount) || 0, year, month });
      }
    }
  }
  for (const ie of infrastructureExpensesInMonth(year, month)) result.push(ie);
  return result;
}

// Infrastructure expenses anchored to this month by expense_date. Returned
// in the same shape as regular expense entries so they slot into
// month/year summaries without callers caring about the source.
function infrastructureExpensesInMonth(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, '0');
  const monthStart = `${year}-${mm}-01`;
  const monthEnd = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
  const open = openingDateISO();
  return getInfrastructureExpenses()
    .filter(e => e.expenseDate && e.expenseDate >= monthStart && e.expenseDate <= monthEnd
                 && (!open || e.expenseDate >= open))
    .map(e => ({
      // Project the infra row into the shape views expect (.expense + .amount).
      expense: { id: e.id, name: e.name, category: 'תשתית', type: 'infrastructure', notes: e.notes },
      amount: Number(e.totalAmount) || 0,
      year,
      month,
      source: 'infrastructure',
    }));
}

// Accounting-view expenses for a month: annual is divided by 12
export function accountingExpensesForMonth(year, month) {
  const result = [];
  for (const e of getExpenses()) {
    if (e.status === 'closed') continue;
    if (e.type === 'monthly' || e.type === 'installments') {
      if (e.status === 'paused') continue;
      if (!isMonthInRange(year, month, e.startDate, e.endDate)) continue;
      const amt = e.rateHistory && e.rateHistory.length ? annualRateAt(e, year, month) : (Number(e.amount) || 0);
      result.push({ expense: e, amount: amt, year, month, mode: 'monthly' });
    } else if (e.type === 'annual') {
      if (!isMonthInRange(year, month, e.startDate, e.endDate)) continue;
      const amt = annualRateAt(e, year, month);
      result.push({ expense: e, amount: amt / 12, year, month, mode: 'annual-12' });
    } else if (e.type === 'oneoff') {
      if (!e.oneOffDate) continue;
      const od = new Date(e.oneOffDate);
      if (od.getFullYear() === year && (od.getMonth() + 1) === month) {
        result.push({ expense: e, amount: Number(e.amount) || 0, year, month, mode: 'oneoff' });
      }
    }
  }
  // Infrastructure expenses are treated as one-off charges on expense_date
  // in the accounting view too — they're not the kind of recurring cost
  // that gets spread over a year.
  for (const ie of infrastructureExpensesInMonth(year, month)) {
    result.push({ ...ie, mode: 'oneoff' });
  }
  return result;
}

// ACTUAL expenses for a month (from recorded expense_payments + infrastructure
// expenses dated to this month). Returns one entry per cash outflow.
export function actualExpensesForMonth(year, month) {
  const expenseById = new Map(getExpenses().map(e => [e.id, e]));
  const fromExpensePayments = getExpensePayments()
    .filter(p => p.year === year && p.month === month)
    .map(p => ({
      expense: expenseById.get(p.expenseId) || { id: p.expenseId, name: p.notes || '—', category: '—', type: 'oneoff' },
      amount: Number(p.amount) || 0,
      year, month,
      payment: p,
    }));
  // Infrastructure: the system doesn't track a separate "outgoing payment"
  // table for these — we treat the full total_amount as paid out by the
  // building on expense_date (which is also how the per-apartment balance
  // already handles it).
  return [...fromExpensePayments, ...infrastructureExpensesInMonth(year, month)];
}

// Per-expense status for a given month: { expected, actual, status, payments, expenseEntry }
export function expenseStatusForMonth(expenseId, year, month) {
  const e = getExpenses().find(x => x.id === expenseId);
  if (!e) return { expected: 0, actual: 0, status: 'unpaid', payments: [] };

  // Compute expected for this expense in this month
  let expected = 0;
  if (e.status !== 'closed') {
    if (e.type === 'monthly' || e.type === 'installments') {
      if (e.status !== 'paused' && isMonthInRange(year, month, e.startDate, e.endDate)) {
        expected = e.rateHistory && e.rateHistory.length ? annualRateAt(e, year, month) : (Number(e.amount) || 0);
      }
    } else if (e.type === 'annual') {
      if (e.billDate) {
        const bd = new Date(e.billDate);
        if ((bd.getMonth() + 1) === month && isMonthInRange(year, month, e.startDate, e.endDate)) {
          expected = annualRateAt(e, year, month);
        }
      }
    } else if (e.type === 'oneoff') {
      if (e.oneOffDate) {
        const od = new Date(e.oneOffDate);
        if (od.getFullYear() === year && (od.getMonth() + 1) === month) {
          expected = Number(e.amount) || 0;
        }
      }
    }
  }

  const payments = getExpensePayments().filter(p => p.expenseId === expenseId && p.year === year && p.month === month);
  const actual = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const status = actual === 0 ? (expected > 0 ? 'unpaid' : 'none')
                : actual >= expected ? 'paid'
                : 'partial';
  return { expected, actual, diff: actual - expected, status, payments };
}

// Sum helpers
export const sumExp = (list) => list.reduce((s, x) => s + (Number(x.amount) || 0), 0);

export function monthSummary(year, month, mode = 'cash') {
  const incomeExpected = expectedIncomeForMonth(year, month);
  const incomeActual = actualIncomeForMonth(year, month);

  // Expected expenses come from definitions; actual expenses come from recorded payments.
  // In accounting mode the *expected* side shows the spread definition (annual ÷ 12).
  // The "actual" side is identical regardless of mode — only money that really left.
  const expectedExpenseList = mode === 'cash'
    ? expectedExpensesForMonth(year, month)
    : accountingExpensesForMonth(year, month);
  const actualExpenseList = actualExpensesForMonth(year, month);

  const expectedExpenses = sumExp(expectedExpenseList);
  const actualExpenses = sumExp(actualExpenseList);

  // The "income" / "expenses" / "balance" are based on actual.
  const income = incomeActual;
  const expenses = actualExpenses;

  return {
    year, month, mode,
    incomeExpected, incomeActual, income,
    expectedExpenses, actualExpenses, expenses,
    expectedExpenseList, actualExpenseList,
    expenseList: expectedExpenseList, // backward-compat
    balance: income - expenses,
    expectedBalance: incomeExpected - expectedExpenses,
  };
}

// Range summary — aggregates monthSummary across every (year, month) pair
// inside [from..to] (both ISO YYYY-MM-DD inclusive). Returns the same shape
// as yearSummary but bounded by the picked range, plus per-month rows so
// callers can build a per-month breakdown table or chart.
export function rangeSummary(from, to, mode = 'cash') {
  const f = new Date(from);
  const t = new Date(to);
  const months = [];
  let income = 0, expenses = 0;
  let incomeExpected = 0, incomeActual = 0;
  let expectedExpenses = 0, actualExpenses = 0;
  let y = f.getFullYear();
  let m = f.getMonth() + 1;
  const endY = t.getFullYear();
  const endM = t.getMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    const ms = monthSummary(y, m, mode);
    months.push(ms);
    income += ms.income;
    expenses += ms.expenses;
    incomeExpected += ms.incomeExpected;
    incomeActual += ms.incomeActual;
    expectedExpenses += ms.expectedExpenses;
    actualExpenses += ms.actualExpenses;
    if (m === 12) { m = 1; y++; } else { m++; }
  }
  return {
    from, to, mode, months,
    income, expenses, incomeExpected, incomeActual,
    expectedExpenses, actualExpenses,
    balance: income - expenses,
    expectedBalance: incomeExpected - expectedExpenses,
  };
}

// Year summary (sum of months 1..12)
export function yearSummary(year, mode = 'cash') {
  const months = [];
  let income = 0, expenses = 0;
  let incomeExpected = 0, incomeActual = 0;
  let expectedExpenses = 0, actualExpenses = 0;
  for (let m = 1; m <= 12; m++) {
    const ms = monthSummary(year, m, mode);
    months.push(ms);
    income += ms.income;
    expenses += ms.expenses;
    incomeExpected += ms.incomeExpected;
    incomeActual += ms.incomeActual;
    expectedExpenses += ms.expectedExpenses;
    actualExpenses += ms.actualExpenses;
  }
  return {
    year, mode, months,
    income, expenses, balance: income - expenses,
    incomeExpected, incomeActual,
    expectedExpenses, actualExpenses,
    expectedBalance: incomeExpected - expectedExpenses,
  };
}

// Category aggregation for a list of expense entries (cash or accounting)
export function aggregateByCategory(entries) {
  const map = new Map();
  for (const it of entries) {
    const c = it.expense.category || 'ללא קטגוריה';
    map.set(c, (map.get(c) || 0) + Number(it.amount || 0));
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

// Cumulative balance from openingBalanceDate to (year, month) inclusive — cash mode.
// Bank balance = opening balance + Σ(actual money in) − Σ(actual money out).
// Activity before opening_balance_date is ignored (it's already wrapped up in
// the opening balance amount).
export function cumulativeBalance(year, month) {
  const s = getSettings();
  const openDate = new Date(s.openingBalanceDate || `${year}-01-01`);
  let bal = Number(s.openingBalance) || 0;
  let y = openDate.getFullYear();
  let m = openDate.getMonth() + 1;
  while (y < year || (y === year && m <= month)) {
    bal += actualIncomeForMonth(y, m);
    // ACTUAL expenses (recorded expense_payments) — not the budgeted/expected
    // amount from definitions. Only money that really left the account.
    bal -= sumExp(actualExpensesForMonth(y, m));
    m++;
    if (m > 12) { m = 1; y++; }
    // safety guard
    if (y > year + 50) break;
  }
  return bal;
}

// Derived status of an expense:
//   'done'        — no unpaid expected period exists (fully reconciled)
//   'in_progress' — at least one expected period is unpaid in full
// Future periods of recurring expenses are NOT counted; only periods up to today.
// One-off expenses use their oneOffDate (regardless of whether it's in future).
export function expenseDerivedStatus(expense) {
  const e = expense;
  if (!e) return 'done';
  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth() + 1;

  if (e.type === 'oneoff') {
    if (!e.oneOffDate) return 'done';
    const od = new Date(e.oneOffDate);
    const expected = Number(e.amount) || 0;
    const paid = getExpensePayments()
      .filter(p => p.expenseId === e.id)
      .reduce((s, p) => s + (Number(p.amount) || 0), 0);
    return paid >= expected ? 'done' : 'in_progress';
  }

  if (e.type === 'monthly' || e.type === 'installments') {
    if (!e.startDate) return 'done';
    const s = new Date(e.startDate);
    let y = s.getFullYear();
    let m = s.getMonth() + 1;
    // Iterate only periods up to min(end_date, today). Skip months before opening date.
    const endY = e.endDate ? Math.min(new Date(e.endDate).getFullYear(), todayY) : todayY;
    while (true) {
      if (y > endY || (y === endY && m > (e.endDate ? Math.min(new Date(e.endDate).getMonth() + 1, todayM) : todayM))) break;
      if (!monthBeforeOpening(y, m)) {
        const st = expenseStatusForMonth(e.id, y, m);
        if (st.expected > 0 && st.actual < st.expected) return 'in_progress';
      }
      m++;
      if (m > 12) { m = 1; y++; }
      if (y > todayY + 50) break;
    }
    return 'done';
  }

  if (e.type === 'annual') {
    if (!e.billDate || !e.startDate) return 'done';
    const bd = new Date(e.billDate);
    const billMonth = bd.getMonth() + 1;
    const sY = new Date(e.startDate).getFullYear();
    const eY = e.endDate ? Math.min(new Date(e.endDate).getFullYear(), todayY) : todayY;
    for (let y = sY; y <= eY; y++) {
      // skip if billing date for this year hasn't arrived yet
      if (y === todayY && billMonth > todayM) continue;
      if (monthBeforeOpening(y, billMonth)) continue;
      const st = expenseStatusForMonth(e.id, y, billMonth);
      if (st.expected > 0 && st.actual < st.expected) return 'in_progress';
    }
    return 'done';
  }

  return 'done';
}

// Outstanding balance per apartment up to and including (year, month).
// Positive = owes money (חוב). Negative = credit balance (יתרת זכות).
// Calculation begins from MAX(opening_balance_date, apartment.activeFrom) —
// nothing before the management start date is counted. Months that haven't
// arrived yet (relative to today's calendar month) are also not counted, so
// requesting outstanding for a future month effectively caps at today.
export function apartmentOutstanding(apartmentId, year, month) {
  const apt = getApartments().find(a => a.id === apartmentId);
  if (!apt) return 0;
  const s = getSettings();
  const earliestFeeFrom = (s.monthlyFeeHistory || []).reduce(
    (min, e) => {
      const f = e.effectiveFrom || e.from;
      return (!min || (f && f < min)) ? f : min;
    },
    null,
  ) || `${year}-01-01`;
  // Floor: never start before the management start date.
  const startDate = maxDate(maxDate(apt.activeFrom, earliestFeeFrom), openingDateISO()) || `${year}-01-01`;
  const start = new Date(startDate);
  // Cap end at today (no future months count toward debt).
  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth() + 1;
  let endY = year, endM = month;
  if (endY > todayY || (endY === todayY && endM > todayM)) {
    endY = todayY; endM = todayM;
  }
  let y = start.getFullYear();
  let m = start.getMonth() + 1;
  let totalExpected = 0;
  while (y < endY || (y === endY && m <= endM)) {
    totalExpected += feeForApartmentMonth(apartmentId, y, m);
    m++;
    if (m > 12) { m = 1; y++; }
    if (y > endY + 50) break;
  }
  // Build a date string for "end of target month" — adjustments and payments
  // are bounded inclusively by it.
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const endISO = `${year}-${String(month).padStart(2, '0')}-${String(lastDayOfMonth).padStart(2, '0')}`;

  const totalPaid = getPayments()
    .filter(p => p.apartmentId === apartmentId)
    .filter(p => p.year < year || (p.year === year && p.month <= month))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

  // Manual adjustments — only those on/after the management start date count.
  const open = openingDateISO();
  const adjustments = getAdjustments().filter(a => a.apartmentId === apartmentId
    && a.effectiveDate <= endISO
    && (!open || a.effectiveDate >= open));
  const totalCharges = adjustments.filter(a => a.kind === 'charge').reduce((s, a) => s + Number(a.amount || 0), 0);
  const totalCredits = adjustments.filter(a => a.kind === 'credit').reduce((s, a) => s + Number(a.amount || 0), 0);

  // Payments made toward specific charges. Use the parent charge's
  // effective_date as the cut-off (so future-dated payments still count once
  // their charge is in scope; the charge is the anchor).
  const chargeIds = new Set(adjustments.filter(a => a.kind === 'charge').map(a => a.id));
  const totalAdjustmentPaid = getAdjustmentPayments()
    .filter(p => chargeIds.has(p.adjustmentId))
    .reduce((s, p) => s + Number(p.amount || 0), 0);

  // Infrastructure demands for this apartment. Each demand is anchored to its
  // parent expense's expense_date (the date the admin recorded the expense).
  // Only demands whose expense_date is on/after the management start date AND
  // on/before the cut-off month are counted. Their payments are summed and
  // subtracted as well.
  const expensesById = new Map(getInfrastructureExpenses().map(e => [e.id, e]));
  const infraDemands = getInfrastructureDemands().filter(d => {
    if (d.apartmentId !== apartmentId) return false;
    const exp = expensesById.get(d.expenseId);
    if (!exp || !exp.expenseDate) return false;
    if (exp.expenseDate > endISO) return false;
    if (open && exp.expenseDate < open) return false;
    return true;
  });
  const totalInfraCharged = infraDemands.reduce((s, d) => s + Number(d.amount || 0), 0);
  const infraDemandIds = new Set(infraDemands.map(d => d.id));
  const totalInfraPaid = getInfrastructurePayments()
    .filter(p => infraDemandIds.has(p.demandId))
    .reduce((s, p) => s + Number(p.amount || 0), 0);

  return totalExpected + totalCharges + totalInfraCharged
       - totalPaid - totalCredits - totalAdjustmentPaid - totalInfraPaid;
}

// Per-demand payment summary for an infrastructure demand. Returns paid /
// remaining / status, plus the underlying payment list.
export function infrastructureDemandStatus(demandId) {
  const demand = getInfrastructureDemands().find(d => d.id === demandId);
  if (!demand) return { paid: 0, remaining: 0, status: 'none', payments: [] };
  const payments = getInfrastructurePayments().filter(p => p.demandId === demandId);
  const paid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
  const remaining = Math.max(0, Number(demand.amount || 0) - paid);
  const status = paid <= 0 ? 'unpaid' : (remaining <= 0.001 ? 'paid' : 'partial');
  return { paid, remaining, status, payments, demand };
}

// For year totals: returns the last month (1..12) to count for a given year.
// Past years → 12, future years → 0, current year → today's month.
export function lastMonthInScope(year) {
  const today = new Date();
  const ty = today.getFullYear();
  if (year < ty) return 12;
  if (year > ty) return 0;
  return today.getMonth() + 1;
}

// Per-charge payment summary: how much has been paid against a specific charge,
// and how much remains. Returns { paid, remaining, status }.
export function chargePaymentStatus(adjustmentId) {
  const adj = getAdjustments().find(a => a.id === adjustmentId);
  if (!adj || adj.kind !== 'charge') return { paid: 0, remaining: 0, status: 'none', payments: [] };
  const payments = getAdjustmentPayments().filter(p => p.adjustmentId === adjustmentId);
  const paid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
  const remaining = Math.max(0, Number(adj.amount || 0) - paid);
  const status = paid <= 0 ? 'unpaid' : (remaining <= 0.001 ? 'paid' : 'partial');
  return { paid, remaining, status, payments };
}

// Future-proof year range. Returns a continuous list of years suitable for
// dropdowns and reports — wide enough that the user never has to redeploy
// to see future years. Always includes:
//   - current year ± buffer (default: 2 back, 10 forward)
//   - earliest data year
//   - latest data year (in case data extends further than now+forward)
export function availableYears({ backYears = 2, forwardYears = 10 } = {}) {
  const ys = new Set();
  const now = new Date();
  const ny = now.getFullYear();
  // Now ± buffer
  for (let y = ny - backYears; y <= ny + forwardYears; y++) ys.add(y);

  // Pull in any data years (so we never hide a year that has data)
  for (const p of getPayments()) ys.add(Number(p.year));
  for (const p of getExpensePayments()) ys.add(Number(p.year));
  for (const e of getExpenses()) {
    for (const k of ['startDate', 'endDate', 'oneOffDate']) {
      if (e[k]) ys.add(new Date(e[k]).getFullYear());
    }
  }
  const s = getSettings();
  for (const h of (s.apartmentCountHistory || [])) {
    const f = h.effectiveFrom || h.from;
    if (f) ys.add(new Date(f).getFullYear());
  }
  for (const h of (s.monthlyFeeHistory || [])) {
    const f = h.effectiveFrom || h.from;
    if (f) ys.add(new Date(f).getFullYear());
  }

  // Fill any gaps so the dropdown is contiguous
  const arr = [...ys].sort((a, b) => a - b);
  if (arr.length === 0) return [ny];
  const filled = [];
  for (let y = arr[0]; y <= arr[arr.length - 1]; y++) filled.push(y);
  return filled;
}

// Years that have any data (payments / expenses / fee history). Used by reports
// to default to data-rich years. Returned newest-first.
export function knownYears() {
  return availableYears().slice().sort((a, b) => b - a);
}

// Categories present
export function knownCategories() {
  return [...new Set(getExpenses().map(e => e.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
}

// ---- Reminders ----
// A reminder is "active" once today >= (due_date - lead_days) and it hasn't been
// acknowledged yet. Returns the active list sorted by due date asc.
export function activeReminders(now = new Date()) {
  const todayMs = now.getTime();
  return getReminders()
    .filter(r => !r.acknowledgedAt)
    .filter(r => {
      const due = new Date(r.dueDate).getTime();
      const lead = (Number(r.leadDays) || 0) * 86400000;
      return (due - lead) <= todayMs;
    })
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

export function upcomingReminders(now = new Date()) {
  const todayMs = now.getTime();
  return getReminders()
    .filter(r => !r.acknowledgedAt)
    .filter(r => {
      const due = new Date(r.dueDate).getTime();
      const lead = (Number(r.leadDays) || 0) * 86400000;
      return (due - lead) > todayMs;
    })
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

export function acknowledgedReminders() {
  return getReminders()
    .filter(r => r.acknowledgedAt)
    .sort((a, b) => (a.acknowledgedAt < b.acknowledgedAt ? 1 : -1));
}

// Annual expenses ending in next 90 days (alerts)
// Expenses whose end_date falls within `daysAhead` days from now —
// surfaced on the dashboard as a renewal-coming-up nudge. Only recurring
// types (monthly, annual, installments) have a meaningful end date; one-off
// rows that somehow still carry an endDate (legacy data, or a type-switched
// edit) are filtered out so the widget reads correctly.
export function expiringSoon(daysAhead = 90) {
  const today = new Date();
  const limit = new Date(); limit.setDate(today.getDate() + daysAhead);
  return getExpenses().filter(e => {
    if (!e.endDate || e.status === 'closed') return false;
    if (e.type === 'oneoff' || e.subtype === 'variable_monthly') return false;
    const ed = new Date(e.endDate);
    return ed >= today && ed <= limit;
  });
}
