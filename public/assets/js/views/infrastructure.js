// Infrastructure expenses ("הוצאות תשתיתיות") — capital-style expenses paid
// by property owners. Each expense's total is split equally across all
// apartments at creation time and lands as a per-apartment payment demand.
// Admin can override individual demand amounts and record payments.
//
// Permissions: master admin has full CRUD; apartment users (renter/owner) get
// read-only access — they can see all apartments' demand status (consistent
// with how the apartments grid is shown).

import {
  getApartments, getInfrastructureExpenses, getInfrastructureDemands, getInfrastructurePayments,
  createInfrastructureExpense, updateInfrastructureExpense, deleteInfrastructureExpense,
  updateInfrastructureDemand, createInfrastructurePayment, deleteInfrastructurePayment,
  getSession,
} from '../store.js';
import { fmtCurrency, esc, fmtDate, todayISO } from '../utils.js';
import { t } from '../i18n.js';
import { infrastructureDemandStatus } from '../calc.js';
import { setHTML, renderPageHeader, renderEmpty, openModal, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';

export function renderInfrastructure() {
  const main = document.getElementById('app-main');
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const expenses = [...getInfrastructureExpenses()].sort((a, b) =>
    (a.expenseDate < b.expenseDate ? 1 : a.expenseDate > b.expenseDate ? -1 : 0));

  setHTML(main, `
    ${renderPageHeader({
      title: t('infra.title'),
      subtitle: t('infra.subtitle'),
      actions: isAdmin ? `<button class="btn btn--primary" id="add-infra">${Icon.plus} ${esc(t('infra.add'))}</button>` : '',
    })}
    <div class="callout">${esc(t('infra.intro'))}</div>
    ${expenses.length === 0 ? renderEmpty({
      title: t('infra.empty.title'),
      hint: t('infra.empty.hint'),
      action: isAdmin ? `<button class="btn btn--primary" id="add-infra-empty">${Icon.plus} ${esc(t('infra.add'))}</button>` : '',
    }) : `
      <div class="vstack" style="gap:12px">
        ${expenses.map(e => renderExpenseCard(e, isAdmin)).join('')}
      </div>
    `}
  `);

  document.getElementById('add-infra')?.addEventListener('click', () => openExpenseDialog());
  document.getElementById('add-infra-empty')?.addEventListener('click', () => openExpenseDialog());

  document.querySelectorAll('[data-act="open-infra"]').forEach(b => b.addEventListener('click', () => {
    const exp = expenses.find(e => e.id === b.dataset.id);
    if (exp) openDemandsDialog(exp);
  }));
  document.querySelectorAll('[data-act="edit-infra"]').forEach(b => b.addEventListener('click', () => {
    if (!requireAdmin()) return;
    const exp = expenses.find(e => e.id === b.dataset.id);
    if (exp) openExpenseDialog(exp);
  }));
  document.querySelectorAll('[data-act="del-infra"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const exp = expenses.find(e => e.id === b.dataset.id);
    const ok = await confirmDialog({
      title: t('infra.delete.title'),
      message: t('infra.delete.message', { name: exp.name }),
      confirmText: t('common.delete'), danger: true,
    });
    if (!ok) return;
    try { await deleteInfrastructureExpense(exp.id); toast(t('infra.deleted'), 'success'); renderInfrastructure(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));
}

// One card per infrastructure expense, with a summary of total / paid / outstanding.
function renderExpenseCard(exp, isAdmin) {
  const demands = getInfrastructureDemands().filter(d => d.expenseId === exp.id);
  const totalDemanded = demands.reduce((s, d) => s + Number(d.amount || 0), 0);
  // For each demand, sum its payments → total paid against this expense.
  const payments = getInfrastructurePayments();
  let totalPaid = 0;
  for (const d of demands) {
    totalPaid += payments.filter(p => p.demandId === d.id).reduce((s, p) => s + Number(p.amount || 0), 0);
  }
  const outstanding = Math.max(0, totalDemanded - totalPaid);
  const fullyPaid = outstanding < 0.005 && totalDemanded > 0;
  return `
    <div class="card" style="padding:16px">
      <div class="hstack" style="gap:12px; flex-wrap:wrap; margin-bottom:8px">
        <strong style="font-size:15px">${esc(exp.name)}</strong>
        ${fullyPaid ? `<span class="badge badge--success">${esc(t('infra.fullyPaid'))}</span>` : ''}
        <span class="muted" style="font-size:12px">${fmtDate(exp.expenseDate)}</span>
        <div class="spacer"></div>
        <button class="btn btn--sm" data-act="open-infra" data-id="${exp.id}">${esc(t('infra.viewDemands'))}</button>
        ${isAdmin ? `
          <button class="btn btn--sm btn--icon" data-act="edit-infra" data-id="${exp.id}" title="${esc(t('common.edit'))}">${Icon.edit}</button>
          <button class="btn btn--sm btn--icon" data-act="del-infra" data-id="${exp.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>
        ` : ''}
      </div>
      <div class="hstack" style="gap:24px; flex-wrap:wrap; font-size:13px">
        <div>${esc(t('infra.col.total'))}: <strong>${fmtCurrency(exp.totalAmount)}</strong></div>
        <div>${esc(t('infra.col.demanded'))}: <strong>${fmtCurrency(totalDemanded)}</strong></div>
        <div class="text-success">${esc(t('infra.col.paid'))}: <strong>${fmtCurrency(totalPaid)}</strong></div>
        <div class="${outstanding > 0 ? 'text-danger' : 'muted'}">${esc(t('infra.col.outstanding'))}: <strong>${fmtCurrency(outstanding)}</strong></div>
        <div class="muted">${esc(t('infra.col.demandCount', { n: demands.length }))}</div>
      </div>
      ${exp.notes ? `<div class="muted" style="font-size:12px; margin-top:8px">${esc(exp.notes)}</div>` : ''}
    </div>
  `;
}

// Add/edit dialog for an infrastructure expense.
function openExpenseDialog(exp = null) {
  if (!requireAdmin()) return;
  const isEdit = !!exp;
  const m = openModal({
    title: isEdit ? t('infra.dialog.edit') : t('infra.dialog.add'),
    body: `
      <form id="infra-form" class="form-grid" autocomplete="off">
        <div class="field field--required" style="grid-column:1/-1">
          <label class="field__label">${esc(t('infra.field.name'))}</label>
          <input class="input" name="name" required value="${esc(exp?.name || '')}" placeholder="${esc(t('infra.field.name.placeholder'))}" />
        </div>
        ${isEdit ? '' : `
          <div class="field field--required">
            <label class="field__label">${esc(t('infra.field.totalAmount'))}</label>
            <input class="input" name="totalAmount" type="number" step="0.01" min="0" required />
            <div class="field__hint">${esc(t('infra.field.totalAmount.hint'))}</div>
          </div>
        `}
        <div class="field field--required">
          <label class="field__label">${esc(t('infra.field.date'))}</label>
          <input class="input" name="expenseDate" type="date" required value="${esc(exp?.expenseDate || todayISO())}" />
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('common.notes'))}</label>
          <textarea class="textarea" name="notes" rows="2">${esc(exp?.notes || '')}</textarea>
        </div>
      </form>
      ${isEdit ? '' : `
        <div class="callout" style="font-size:12px; margin-top:10px">
          ${esc(t('infra.dialog.add.splitNote'))}
        </div>
      `}
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
    `,
    size: 'md',
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#infra-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!data.name) { toast(t('infra.field.nameRequired'), 'warning'); return; }
    if (!data.expenseDate) { toast(t('infra.field.dateRequired'), 'warning'); return; }
    try {
      if (isEdit) {
        await updateInfrastructureExpense(exp.id, { name: data.name, expenseDate: data.expenseDate, notes: data.notes });
      } else {
        const totalAmount = Number(data.totalAmount);
        if (!Number.isFinite(totalAmount) || totalAmount <= 0) { toast(t('infra.field.totalAmountRequired'), 'warning'); return; }
        await createInfrastructureExpense({ name: data.name, totalAmount, expenseDate: data.expenseDate, notes: data.notes });
      }
      toast(isEdit ? t('infra.updated') : t('infra.added'), 'success');
      m.close();
      renderInfrastructure();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

// Drill-in dialog showing per-apartment demands for a single infrastructure expense.
function openDemandsDialog(exp) {
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const apts = [...getApartments()].sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  const m = openModal({
    title: t('infra.demands.title', { name: exp.name }),
    size: 'lg',
    body: '<div id="demands-content"></div>',
    footer: `<button class="btn" data-act="close">${esc(t('common.close'))}</button>`,
  });
  m.footerEl.querySelector('[data-act="close"]').addEventListener('click', () => m.close());

  const refresh = () => {
    const container = m.bodyEl.querySelector('#demands-content');
    const demands = getInfrastructureDemands().filter(d => d.expenseId === exp.id);
    const demandsByApt = new Map(demands.map(d => [d.apartmentId, d]));
    const rows = apts.map(apt => {
      const d = demandsByApt.get(apt.id);
      // Infrastructure expenses are paid by the property OWNER, not the
      // resident. Show the owner's name as the primary identity. If a renter
      // lives in the apartment, mention them as a smaller secondary line.
      const ownerName = apt.ownerName || apt.owner || '—';
      const isRenter = apt.occupantType === 'renter';
      const identityCell = `
        <div>${esc(ownerName)} <span class="badge badge--success" style="font-size:10px; padding:1px 6px">${esc(t('apt.badge.owner'))}</span></div>
        ${isRenter && apt.owner && apt.owner !== ownerName ? `<div class="muted" style="font-size:11px">${esc(t('infra.demands.renterNote', { name: apt.owner }))}</div>` : ''}
      `;
      if (!d) {
        return `
          <tr>
            <td><strong>${esc(apt.number)}</strong></td>
            <td>${identityCell}</td>
            <td colspan="4" class="muted">${esc(t('infra.demands.noDemand'))}</td>
          </tr>
        `;
      }
      const st = infrastructureDemandStatus(d.id);
      const badge = st.status === 'paid' ? `<span class="badge badge--success">${esc(t('apt.status.paid'))}</span>`
                  : st.status === 'partial' ? `<span class="badge badge--warning">${esc(t('apt.status.partial'))}</span>`
                  : `<span class="badge badge--danger">${esc(t('apt.status.unpaid'))}</span>`;
      const amountCell = isAdmin
        ? `<button class="btn btn--ghost btn--sm" data-act="edit-amount" data-did="${d.id}" data-cur="${d.amount}" title="${esc(t('infra.demands.editAmount'))}">${fmtCurrency(d.amount)} ✎</button>`
        : fmtCurrency(d.amount);
      const actionCell = isAdmin && st.remaining > 0
        ? `<button class="btn btn--sm btn--accent" data-act="quick-pay-infra" data-did="${d.id}" data-amt="${st.remaining}">✓ ${esc(t('apt.quickPay'))} (${fmtCurrency(st.remaining)})</button>`
        : '';
      const paymentsCell = st.payments.length
        ? st.payments.map(p => `
            <div class="hstack" style="gap:6px; font-size:12px">
              <span class="muted">${fmtCurrency(p.amount)} · ${fmtDate(p.paidOn)}</span>
              ${isAdmin ? `<button class="btn btn--sm btn--icon" data-act="del-infra-pay" data-pid="${p.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>` : ''}
            </div>
          `).join('')
        : (actionCell ? '' : '<span class="muted">—</span>');
      return `
        <tr>
          <td><strong>${esc(apt.number)}</strong></td>
          <td>${identityCell}</td>
          <td class="num">${amountCell}</td>
          <td class="num text-success">${fmtCurrency(st.paid)}</td>
          <td>${badge}</td>
          <td><div class="vstack" style="gap:4px">${actionCell}${paymentsCell}</div></td>
        </tr>
      `;
    }).join('');
    setHTML(container, `
      <div class="muted" style="font-size:13px; margin-bottom:10px">
        ${esc(t('infra.demands.intro', { total: fmtCurrency(exp.totalAmount), date: fmtDate(exp.expenseDate) }))}
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>${esc(t('apt.col.number'))}</th>
              <th>${esc(t('infra.col.payer'))}</th>
              <th class="num">${esc(t('infra.col.amount'))}</th>
              <th class="num">${esc(t('apt.col.paid'))}</th>
              <th>${esc(t('common.status'))}</th>
              <th>${esc(t('apt.ledger.payments'))}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);

    container.querySelectorAll('[data-act="edit-amount"]').forEach(b => b.addEventListener('click', () => {
      if (!requireAdmin()) return;
      openAmountEditor({ demandId: b.dataset.did, current: Number(b.dataset.cur), onDone: refresh });
    }));
    container.querySelectorAll('[data-act="quick-pay-infra"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      b.disabled = true;
      try {
        await createInfrastructurePayment({ demandId: b.dataset.did, amount: Number(b.dataset.amt), paidOn: todayISO(), method: 'bit' });
        toast(t('apt.quickPay.recorded', { amount: fmtCurrency(Number(b.dataset.amt)) }), 'success');
        refresh();
        renderInfrastructure();
      } catch (err) { toast(err.message || t('common.error'), 'danger'); b.disabled = false; }
    }));
    container.querySelectorAll('[data-act="del-infra-pay"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      const ok = await confirmDialog({ title: t('pay.delete.title'), message: t('pay.delete.message'), confirmText: t('common.delete'), danger: true });
      if (!ok) return;
      try { await deleteInfrastructurePayment(b.dataset.pid); toast(t('pay.deleted'), 'success'); refresh(); renderInfrastructure(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }));
  };
  refresh();
}

// Edits a single demand's amount inline.
function openAmountEditor({ demandId, current, onDone }) {
  const m = openModal({
    title: t('infra.demands.editAmount'),
    body: `
      <form id="amt-form" class="vstack">
        <div class="field field--required">
          <label class="field__label">${esc(t('infra.col.amount'))}</label>
          <input class="input" id="amt" type="number" step="0.01" min="0" value="${current}" autofocus />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('common.notes'))}</label>
          <input class="input" name="notes" />
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
    const f = m.bodyEl.querySelector('#amt-form');
    const data = Object.fromEntries(new FormData(f).entries());
    const amount = Number(m.bodyEl.querySelector('#amt').value);
    if (!Number.isFinite(amount) || amount < 0) { toast(t('common.error'), 'warning'); return; }
    try {
      await updateInfrastructureDemand(demandId, { amount, notes: data.notes || null });
      toast(t('common.saveDone'), 'success');
      m.close();
      onDone && onDone();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}
