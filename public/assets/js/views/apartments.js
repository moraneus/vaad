// Apartments management + per-apartment ledger

import { getApartments, getPayments, getSettings, upsertApartment, deleteApartment, upsertPayment, deletePayment, getAdjustments, createAdjustment, deleteAdjustment, createAdjustmentPayment, deleteAdjustmentPayment, setFeeOverride, clearFeeOverride } from '../store.js';
import { api } from '../api.js';
import { fmtCurrency, esc, fmtDate, valueAtMonth, todayISO, monthKey, parseMonthKey } from '../utils.js';
import { t, monthName } from '../i18n.js';
import { apartmentMonthStatus, apartmentOutstanding, availableYears, chargePaymentStatus } from '../calc.js';
import { setHTML, renderPageHeader, renderEmpty, openModal, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';
import { getSession } from '../store.js';

let currentYear = new Date().getFullYear();

export function renderApartments() {
  const main = document.getElementById('app-main');
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const apts = [...getApartments()].sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  const settings = getSettings();
  const cnt = valueAtMonth(settings.apartmentCountHistory, currentYear, 12);
  const fee = valueAtMonth(settings.monthlyFeeHistory, currentYear, 12);

  setHTML(main, `
    ${renderPageHeader({
      title: t('apt.title'),
      subtitle: t('apt.subtitle', { count: cnt ? cnt.count : 0, fee: fmtCurrency(fee ? fee.amount : 0) }),
      actions: isAdmin ? `<button class="btn btn--primary" id="add-apt">${Icon.plus} ${esc(t('apt.add'))}</button>` : '',
    })}

    <div class="toolbar">
      <div class="hstack">
        <label class="muted">${esc(t('apt.yearLabel'))}</label>
        <select class="select" id="year-select" style="width:120px">
          ${availableYears().map(y => `<option ${y === currentYear ? 'selected' : ''} value="${y}">${y}</option>`).join('')}
        </select>
      </div>
      <div class="spacer"></div>
      <div class="muted" style="font-size:13px">${esc(t('apt.totalInSystem'))} <strong>${apts.length}</strong></div>
    </div>

    ${apts.length === 0 ? renderEmpty({
      title: t('apt.empty.title'),
      hint: t('apt.empty.hint'),
      action: isAdmin ? `<button class="btn btn--primary" id="add-apt-empty">${Icon.plus} ${esc(t('apt.add'))}</button>` : `<span class="muted">${esc(t('apt.empty.viewer'))}</span>`,
    }) : `
      <div class="card card--padless">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>${esc(t('apt.col.number'))}</th>
                <th>${esc(t('apt.col.owner'))}</th>
                <th>${esc(t('apt.col.phone'))}</th>
                <th>${esc(t('apt.col.yearStatus', { year: currentYear }))}</th>
                <th class="num">${esc(t('apt.col.expectedYear'))}</th>
                <th class="num">${esc(t('apt.col.paid'))}</th>
                <th class="num">${esc(t('apt.col.outstanding'))}</th>
                <th class="actions">${esc(t('common.actions'))}</th>
              </tr>
            </thead>
            <tbody>
              ${apts.map(apt => renderAptRow(apt, currentYear, isAdmin)).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `}
  `);

  document.getElementById('year-select')?.addEventListener('change', (e) => {
    currentYear = Number(e.target.value);
    renderApartments();
  });
  document.getElementById('add-apt')?.addEventListener('click', () => openApartmentDialog());
  document.getElementById('add-apt-empty')?.addEventListener('click', () => openApartmentDialog());

  document.querySelectorAll('[data-act="edit-apt"]').forEach(b => b.addEventListener('click', () => {
    const apt = getApartments().find(a => a.id === b.dataset.id);
    openApartmentDialog(apt);
  }));
  document.querySelectorAll('[data-act="del-apt"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const apt = getApartments().find(a => a.id === b.dataset.id);
    const ok = await confirmDialog({
      title: t('apt.delete.title'),
      message: t('apt.delete.message', { number: apt.number }),
      confirmText: t('common.delete'), danger: true,
    });
    if (ok) { try { await deleteApartment(apt.id); toast(t('apt.deleted'), 'success'); renderApartments(); } catch (err) { toast(err.message || t('common.error'), 'danger'); } }
  }));
  document.querySelectorAll('[data-act="view-apt"]').forEach(b => b.addEventListener('click', () => {
    const apt = getApartments().find(a => a.id === b.dataset.id);
    openApartmentLedger(apt);
  }));
}

function renderAptRow(apt, year, isAdmin) {
  let yearExpected = 0, yearPaid = 0;
  for (let m = 1; m <= 12; m++) {
    const st = apartmentMonthStatus(apt.id, year, m);
    yearExpected += st.expected;
    yearPaid += st.paid;
  }
  const outstanding = apartmentOutstanding(apt.id, year, 12);
  const dotsRow = [];
  for (let m = 1; m <= 12; m++) {
    const st = apartmentMonthStatus(apt.id, year, m);
    const cls = st.status === 'paid' ? 'background:var(--c-success)' :
                st.status === 'partial' ? 'background:var(--c-warning)' :
                'background:var(--c-border-strong)';
    dotsRow.push(`<span title="${monthName(m)}: ${fmtCurrency(st.paid)} / ${fmtCurrency(st.expected)}" style="width:10px;height:10px;border-radius:3px;display:inline-block;${cls}"></span>`);
  }
  return `
    <tr>
      <td><strong>${esc(String(apt.number))}</strong></td>
      <td>${esc(apt.owner || '—')}</td>
      <td>${apt.phone ? `<a href="tel:${esc(apt.phone)}" class="muted">${esc(apt.phone)}</a>` : '<span class="muted">—</span>'}${apt.email ? `<div class="muted" style="font-size:11px; direction:ltr; text-align:start"><a href="mailto:${esc(apt.email)}" class="muted">${esc(apt.email)}</a></div>` : ''}</td>
      <td><div style="display:flex; gap:3px">${dotsRow.join('')}</div></td>
      <td class="num">${fmtCurrency(yearExpected)}</td>
      <td class="num text-success">${fmtCurrency(yearPaid)}</td>
      <td class="num ${outstanding > 0 ? 'text-danger' : outstanding < 0 ? 'text-success' : 'muted'}">
        ${fmtCurrency(Math.abs(outstanding))}
        <div class="muted" style="font-size:11px">
          ${outstanding > 0 ? esc(t('apt.balance.debt')) : outstanding < 0 ? esc(t('apt.balance.credit')) : esc(t('apt.balance.balanced'))}
        </div>
      </td>
      <td class="actions">
        <button class="btn btn--sm" data-act="view-apt" data-id="${apt.id}">${esc(t('apt.row.detail'))}</button>
        ${isAdmin ? `
          <button class="btn btn--sm btn--icon" data-act="edit-apt" data-id="${apt.id}" title="${esc(t('common.edit'))}">${Icon.edit}</button>
          <button class="btn btn--sm btn--icon" data-act="del-apt" data-id="${apt.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>
        ` : ''}
      </td>
    </tr>
  `;
}

function openApartmentDialog(apt = null) {
  if (!requireAdmin()) return;
  const isEdit = !!apt;
  const m = openModal({
    title: isEdit ? t('apt.dialog.edit') : t('apt.dialog.add'),
    body: `
      <form id="apt-form" class="form-grid" autocomplete="off">
        <div class="field field--required">
          <label class="field__label">${esc(t('apt.field.number'))}</label>
          <input class="input" name="number" required value="${esc(apt?.number || '')}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('apt.field.owner'))}</label>
          <input class="input" name="owner" value="${esc(apt?.owner || '')}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('apt.field.phone'))}</label>
          <input class="input" name="phone" type="tel" value="${esc(apt?.phone || '')}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('apt.field.activeFrom'))}</label>
          <input class="input" name="activeFrom" type="date" value="${esc(apt?.activeFrom || todayISO())}" />
          <div class="field__hint">${esc(t('apt.field.activeFromHint'))}</div>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('apt.field.email'))}</label>
          <input class="input" name="email" type="email" value="${esc(apt?.email || '')}" placeholder="resident@example.com" />
          <div class="field__hint">${esc(t('apt.field.emailHint'))}</div>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('common.notes'))}</label>
          <textarea class="textarea" name="notes" rows="2">${esc(apt?.notes || '')}</textarea>
        </div>
      </form>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#apt-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!data.number) { toast(t('apt.numberRequired'), 'warning'); return; }
    const newEmail = (data.email || '').trim().toLowerCase();
    const oldEmail = (apt?.email || '').trim().toLowerCase();
    // Save the apartment first, then sync email separately.
    try {
      const saved = await upsertApartment({ id: apt?.id, ...data });
      const aptId = apt?.id || saved?.id;
      // Sync email opt-in if it changed
      if (aptId && newEmail !== oldEmail) {
        try {
          if (newEmail) await api.setApartmentEmail(aptId, newEmail);
          else await api.removeApartmentEmail(aptId);
        } catch (err) {
          // Email sync failure shouldn't fail the whole save
          toast(t('apt.emailSyncFailed') + ': ' + (err.message || ''), 'warning');
        }
      }
      toast(isEdit ? t('apt.updated') : t('apt.added'), 'success');
      m.close();
      renderApartments();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

function openApartmentLedger(apt) {
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const m = openModal({
    title: `${t('apt.ledger.title', { number: apt.number })}${apt.owner ? ` · ${apt.owner}` : ''}`,
    size: 'lg',
    body: '<div id="ledger-content"></div>',
    footer: `
      ${isAdmin ? `
        <button class="btn btn--primary" data-act="add-pay">${Icon.plus} ${esc(t('apt.ledger.recordPay'))}</button>
        <button class="btn" data-act="add-charge">${esc(t('apt.adjustment.add.charge'))}</button>
        <button class="btn" data-act="add-credit">${esc(t('apt.adjustment.add.credit'))}</button>
      ` : ''}
      <button class="btn" data-act="close">${esc(t('common.close'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="close"]').addEventListener('click', () => m.close());

  const refresh = () => {
    const content = m.bodyEl.querySelector('#ledger-content');
    const rows = [];
    for (let mn = 1; mn <= 12; mn++) {
      const st = apartmentMonthStatus(apt.id, currentYear, mn);
      const ps = getPayments().filter(p => p.apartmentId === apt.id && p.year === currentYear && p.month === mn);
      const badge = st.status === 'paid' ? `<span class="badge badge--success">${esc(t('apt.status.paid'))}</span>` :
                    st.status === 'partial' ? `<span class="badge badge--warning">${esc(t('apt.status.partial'))}</span>` :
                    st.status === 'none' ? `<span class="muted">—</span>` :
                    `<span class="badge badge--danger">${esc(t('apt.status.unpaid'))}</span>`;
      // Per-row delta badge — only when expected and paid are both > 0 and differ.
      // diff = paid - expected. Negative → debt (red), positive → credit (green).
      const diff = st.diff;
      const deltaBadge = (st.expected > 0 && diff !== 0) ? (
        diff < 0
          ? `<span class="badge badge--danger" title="${esc(t('apt.ledger.debt'))}">${fmtCurrency(diff)}</span>`
          : `<span class="badge badge--success" title="${esc(t('apt.ledger.credit'))}">+${fmtCurrency(diff)}</span>`
      ) : '';
      // Per-row action UI for the admin:
      //   * "Mark as paid" — primary, big, quick action: records the remaining
      //     amount with today's date (the original quick-pay behavior).
      //   * Small ✎ icon — secondary, opens the unified X-of-Y editor for
      //     custom amounts / editing the expected (Y) value.
      // Only shown when there's a remaining balance > 0; otherwise just the ✎.
      const remaining = st.expected - st.paid;
      const quickPayBtn = isAdmin && remaining > 0
        ? `<button class="btn btn--sm btn--accent" data-act="quick-pay" data-y="${currentYear}" data-m="${mn}" data-amt="${remaining}" title="${esc(t('apt.quickPay'))}">✓ ${esc(t('apt.quickPay'))} (${fmtCurrency(remaining)})</button>`
        : '';
      const editIconBtn = isAdmin
        ? `<button class="btn btn--sm btn--icon" data-act="edit-cell" data-y="${currentYear}" data-m="${mn}" title="${esc(t('apt.ledger.editCell'))}">✎</button>`
        : '';
      const overrideIcon = st.hasOverride
        ? ` <span class="muted" title="${esc(t('apt.ledger.overrideHint'))}" style="font-size:11px">⚙</span>`
        : '';
      rows.push(`
        <tr>
          <td>${monthName(mn)} ${currentYear}</td>
          <td class="num">${fmtCurrency(st.expected)}${overrideIcon}</td>
          <td class="num text-success">${fmtCurrency(st.paid)}</td>
          <td><div class="hstack" style="gap:6px; flex-wrap:wrap">${badge}${deltaBadge}</div></td>
          <td>
            <div class="vstack" style="gap:6px">
              <div class="hstack" style="gap:4px; flex-wrap:wrap">${quickPayBtn}${editIconBtn}</div>
              ${ps.length ? ps.map(p => `
                <div class="hstack" style="gap:6px; font-size:12px">
                  <span class="muted">${fmtCurrency(p.amount)} · ${fmtDate(p.paidOn)}</span>
                  ${isAdmin ? `<button class="btn btn--sm btn--icon" data-act="del-pay" data-pid="${p.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>` : ''}
                </div>
              `).join('') : ((quickPayBtn || editIconBtn) ? '' : '<span class="muted">—</span>')}
            </div>
          </td>
        </tr>
      `);
    }
    const outstanding = apartmentOutstanding(apt.id, currentYear, 12);
    const balLabel = outstanding > 0 ? t('apt.balance.debt')
                  : outstanding < 0 ? t('apt.balance.credit')
                  : t('apt.balance.balanced');
    const balCls = outstanding > 0 ? 'text-danger' : outstanding < 0 ? 'text-success' : 'muted';
    const adjustments = getAdjustments().filter(a => a.apartmentId === apt.id);
    setHTML(content, `
      <div class="hstack" style="margin-bottom:14px; gap:14px">
        <label class="muted">${esc(t('apt.ledger.year'))}</label>
        <select class="select" id="ledger-year" style="width:130px">
          ${availableYears().map(y => `<option ${y === currentYear ? 'selected' : ''} value="${y}">${y}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <div class="muted">${esc(balLabel)} <strong class="${balCls}">${fmtCurrency(Math.abs(outstanding))}</strong></div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>${esc(t('apt.ledger.month'))}</th><th class="num">${esc(t('apt.ledger.expected'))}</th><th class="num">${esc(t('apt.col.paid'))}</th><th>${esc(t('common.status'))}</th><th>${esc(t('apt.ledger.payments'))}</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>

      <div style="margin-top:18px">
        <div class="hstack" style="margin-bottom:8px">
          <h4 style="margin:0">${esc(t('apt.adjustments.title'))}</h4>
          <span class="badge">${adjustments.length}</span>
        </div>
        ${adjustments.length === 0 ? `<p class="muted" style="font-size:13px; margin:0">${esc(t('apt.adjustments.empty'))}</p>` : `
          <div class="vstack" style="gap:10px">
            ${adjustments.map(a => renderAdjustmentBlock(a, isAdmin)).join('')}
          </div>
        `}
      </div>
    `);
    content.querySelector('#ledger-year').addEventListener('change', (e) => {
      currentYear = Number(e.target.value);
      refresh();
    });
    content.querySelectorAll('[data-act="del-pay"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      const ok = await confirmDialog({ title: t('pay.delete.title'), message: t('pay.delete.message'), confirmText: t('common.delete'), danger: true });
      if (ok) { try { await deletePayment(b.dataset.pid); toast(t('pay.deleted'), 'success'); refresh(); renderApartments(); } catch (err) { toast(err.message || t('common.error'), 'danger'); } }
    }));
    content.querySelectorAll('[data-act="del-adj"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      const ok = await confirmDialog({ title: t('apt.adjustment.delete.title'), message: t('apt.adjustment.delete.message'), confirmText: t('common.delete'), danger: true });
      if (!ok) return;
      try { await deleteAdjustment(b.dataset.aid); toast(t('apt.adjustment.deleted'), 'success'); refresh(); renderApartments(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }));
    // Quick mark-as-paid for a charge: records the remaining amount with today's date.
    content.querySelectorAll('[data-act="quick-pay-adj"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      b.disabled = true;
      const adjustmentId = b.dataset.aid;
      const amount = Number(b.dataset.amt);
      try {
        await createAdjustmentPayment({ adjustmentId, amount, paidOn: todayISO(), method: 'bank' });
        toast(t('apt.adjustment.payment.recorded'), 'success');
        refresh();
        renderApartments();
      } catch (err) { toast(err.message || t('common.error'), 'danger'); b.disabled = false; }
    }));
    // Open custom-amount payment dialog (for partial payments).
    content.querySelectorAll('[data-act="pay-adj"]').forEach(b => b.addEventListener('click', () => {
      const adj = getAdjustments().find(x => x.id === b.dataset.aid);
      if (adj) openAdjustmentPaymentDialog(adj, () => { refresh(); renderApartments(); });
    }));
    // Delete an individual charge payment.
    content.querySelectorAll('[data-act="del-apay"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      const ok = await confirmDialog({ title: t('apt.adjustment.payment.delete.title'), message: t('apt.adjustment.payment.delete.message'), confirmText: t('common.delete'), danger: true });
      if (!ok) return;
      try { await deleteAdjustmentPayment(b.dataset.pid); toast(t('apt.adjustment.payment.deleted'), 'success'); refresh(); renderApartments(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }));
    // Quick mark-as-paid: one-click record of the remaining amount with today's
    // date. The primary, prominent action per row.
    content.querySelectorAll('[data-act="quick-pay"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      b.disabled = true;
      const year = Number(b.dataset.y);
      const month = Number(b.dataset.m);
      const amount = Number(b.dataset.amt);
      try {
        await upsertPayment({ apartmentId: apt.id, year, month, amount, paidOn: todayISO(), method: 'bit' });
        toast(t('apt.quickPay.recorded', { amount: fmtCurrency(amount) }), 'success');
        refresh();
        renderApartments();
      } catch (err) {
        toast(err.message || t('common.error'), 'danger');
        b.disabled = false;
      }
    }));
    // Small ✎ icon: opens the unified X-of-Y editor (for custom amounts or
    // editing the expected value).
    content.querySelectorAll('[data-act="edit-cell"]').forEach(b => b.addEventListener('click', () => {
      if (!requireAdmin()) return;
      const year = Number(b.dataset.y);
      const month = Number(b.dataset.m);
      openCellEditor({ apt, year, month, onDone: () => { refresh(); renderApartments(); } });
    }));
  };
  refresh();

  m.footerEl.querySelector('[data-act="add-pay"]')?.addEventListener('click', () => {
    openPaymentDialog(apt, () => { refresh(); renderApartments(); });
  });
  m.footerEl.querySelector('[data-act="add-charge"]')?.addEventListener('click', () => {
    openAdjustmentDialog(apt, 'charge', () => { refresh(); renderApartments(); });
  });
  m.footerEl.querySelector('[data-act="add-credit"]')?.addEventListener('click', () => {
    openAdjustmentDialog(apt, 'credit', () => { refresh(); renderApartments(); });
  });
}

// Dialog for adding a manual charge or credit to an apartment.
// Validates against the management start date with a soft warning (not blocked).
function openAdjustmentDialog(apt, kind, onSaved) {
  if (!requireAdmin()) return;
  const settings = getSettings();
  const openDate = settings.openingBalanceDate || null;
  const titleKey = kind === 'charge' ? 'apt.adjustment.dialog.charge' : 'apt.adjustment.dialog.credit';
  const m = openModal({
    title: t(titleKey, { number: apt.number }),
    body: `
      <form id="adj-form" class="form-grid">
        <div class="field field--required">
          <label class="field__label">${esc(t('apt.adjustment.field.amount'))}</label>
          <input class="input" name="amount" type="number" step="0.01" min="0.01" required />
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('apt.adjustment.field.date'))}</label>
          <input class="input" name="effectiveDate" type="date" required value="${todayISO()}" min="${esc(openDate || '')}" />
          ${openDate ? `<div class="field__hint">${esc(t('apt.adjustment.beforeOpening'))}</div>` : ''}
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('apt.adjustment.field.notes'))}</label>
          <textarea class="textarea" name="notes" rows="2"></textarea>
        </div>
      </form>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn ${kind === 'charge' ? 'btn--danger' : 'btn--primary'}" data-act="save">${esc(t('common.add'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#adj-form');
    const data = Object.fromEntries(new FormData(f).entries());
    const amount = Number(data.amount);
    if (!amount || amount <= 0) { toast(t('apt.adjustment.amountRequired'), 'warning'); return; }
    if (!data.effectiveDate) { toast(t('apt.adjustment.dateRequired'), 'warning'); return; }
    try {
      await createAdjustment({
        apartmentId: apt.id,
        kind,
        amount,
        effectiveDate: data.effectiveDate,
        notes: data.notes || null,
      });
      toast(t('apt.adjustment.added'), 'success');
      m.close();
      onSaved && onSaved();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

export function openPaymentDialog(apt, onSaved) {
  if (!requireAdmin()) return;
  const settings = getSettings();
  const now = new Date();
  const defaultMonth = monthKey(now.getFullYear(), now.getMonth() + 1);
  const monthsOptions = [];
  for (const y of availableYears()) {
    for (let mo = 1; mo <= 12; mo++) {
      const k = monthKey(y, mo);
      monthsOptions.push(`<option ${k === defaultMonth ? 'selected' : ''} value="${k}">${monthName(mo)} ${y}</option>`);
    }
  }
  // Resolve the expected fee for the default month using the per-apt-per-month
  // override pipeline (so a previously-set override is shown, not the global value).
  const initialFee = (() => {
    const st = apartmentMonthStatus(apt.id, now.getFullYear(), now.getMonth() + 1);
    return st.expected || (valueAtMonth(settings.monthlyFeeHistory, now.getFullYear(), now.getMonth() + 1)?.amount || 0);
  })();
  const m = openModal({
    title: t('pay.dialog.title', { number: apt.number }),
    body: `
      <form id="pay-form" class="form-grid">
        <div class="field field--required">
          <label class="field__label">${esc(t('pay.field.month'))}</label>
          <select class="select" name="monthKey" id="pay-month">${monthsOptions.join('')}</select>
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('apt.ledger.expected'))} (Y)</label>
          <div class="hstack" style="gap:6px">
            <input class="input" id="pay-expected" name="expected" type="number" step="0.01" min="0" value="${initialFee}" />
            <button type="button" class="btn btn--ghost btn--sm" data-act="reset-expected" title="${esc(t('apt.ledger.editExpected.reset'))}">↺</button>
          </div>
          <div class="field__hint" id="pay-expected-hint"></div>
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('pay.field.amount'))} (X)</label>
          <div class="hstack" style="gap:6px">
            <input class="input" id="pay-amount" name="amount" type="number" step="0.01" required value="${initialFee}" />
            <button type="button" class="btn btn--ghost btn--sm" data-act="fill-amount" title="${esc(t('apt.ledger.editCell.fillX'))}">${esc(t('apt.ledger.editCell.fillX'))}</button>
          </div>
        </div>
        <div class="field">
          <label class="field__label">${esc(t('pay.field.date'))}</label>
          <input class="input" name="paidOn" type="date" value="${todayISO()}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('pay.field.method'))}</label>
          <select class="select" name="method">
            <option value="cash">${esc(t('pay.method.cash'))}</option>
            <option value="bit">${esc(t('pay.method.bit'))}</option>
            <option value="check">${esc(t('pay.method.check'))}</option>
            <option value="bank">${esc(t('pay.method.bank'))}</option>
            <option value="other">${esc(t('pay.method.other'))}</option>
          </select>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('common.notes'))}</label>
          <textarea class="textarea" name="notes" rows="2"></textarea>
        </div>
        <div id="pay-preview" style="grid-column:1/-1; font-size:13px; min-height:1.4em"></div>
      </form>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save">${esc(t('common.save'))}</button>
    `,
    size: 'md',
  });
  const monthEl = m.bodyEl.querySelector('#pay-month');
  const yEl = m.bodyEl.querySelector('#pay-expected');
  const xEl = m.bodyEl.querySelector('#pay-amount');
  const hintEl = m.bodyEl.querySelector('#pay-expected-hint');
  const preview = m.bodyEl.querySelector('#pay-preview');

  // Compute the inherited (global) fee for the chosen month; used for the ↺
  // reset shortcut and the "expected hint" text shown below the Y input.
  const inheritedFor = (year, month) => {
    const fee = valueAtMonth(settings.monthlyFeeHistory, year, month);
    return fee ? Number(fee.amount) || 0 : 0;
  };

  // When the month changes, refresh Y to reflect that month's expected value
  // (override-aware) and update the inherited-fee hint.
  const refreshForMonth = () => {
    const { year, month } = parseMonthKey(monthEl.value);
    const st = apartmentMonthStatus(apt.id, year, month);
    yEl.value = st.expected;
    xEl.value = st.expected;
    const inherited = inheritedFor(year, month);
    hintEl.textContent = t('apt.ledger.editExpected.hint', { value: fmtCurrency(inherited) });
    updatePreview();
  };
  monthEl.addEventListener('change', refreshForMonth);

  m.bodyEl.querySelector('[data-act="reset-expected"]').addEventListener('click', () => {
    const { year, month } = parseMonthKey(monthEl.value);
    yEl.value = inheritedFor(year, month);
    updatePreview();
  });
  m.bodyEl.querySelector('[data-act="fill-amount"]').addEventListener('click', () => {
    xEl.value = yEl.value;
    updatePreview();
  });

  // Live preview built via DOM API (no innerHTML).
  const updatePreview = () => {
    const y = Number(yEl.value || 0);
    const x = Number(xEl.value || 0);
    const diff = x - y;
    preview.textContent = '';
    preview.className = '';
    if (y > 0 && diff < 0) {
      preview.classList.add('text-danger');
      preview.textContent = t('apt.ledger.editCell.previewDebt', { amount: fmtCurrency(Math.abs(diff)) });
    } else if (diff > 0) {
      preview.classList.add('text-success');
      preview.textContent = t('apt.ledger.editCell.previewCredit', { amount: fmtCurrency(diff) });
    } else if (y > 0 && Math.abs(diff) < 0.005) {
      preview.classList.add('text-success');
      preview.textContent = t('apt.ledger.editCell.previewBalanced');
    }
  };
  yEl.addEventListener('input', updatePreview);
  xEl.addEventListener('input', updatePreview);
  // Initial state
  hintEl.textContent = t('apt.ledger.editExpected.hint', { value: fmtCurrency(initialFee) });
  updatePreview();

  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#pay-form');
    const data = Object.fromEntries(new FormData(f).entries());
    const { year, month } = parseMonthKey(data.monthKey);
    const newY = Number(data.expected);
    const newX = Number(data.amount);
    if (!Number.isFinite(newY) || newY < 0) { toast(t('common.error'), 'warning'); return; }
    if (!Number.isFinite(newX) || newX <= 0) { toast(t('pay.amountRequired'), 'warning'); return; }
    try {
      // 1. If the entered Y differs from the inherited global fee, set an
      //    override; if it matches, clear any override that might exist.
      const inherited = inheritedFor(year, month);
      const curSt = apartmentMonthStatus(apt.id, year, month);
      if (Math.abs(newY - curSt.expected) > 0.005 || newY !== inherited) {
        if (Math.abs(newY - inherited) < 0.005) {
          await clearFeeOverride({ apartmentId: apt.id, year, month });
        } else {
          await setFeeOverride({ apartmentId: apt.id, year, month, amount: newY });
        }
      }
      // 2. Record the payment (additive — coexists with any prior payments).
      await upsertPayment({
        apartmentId: apt.id,
        year, month,
        amount: newX,
        paidOn: data.paidOn,
        method: data.method,
        notes: data.notes,
      });
      toast(t('pay.recorded'), 'success');
      m.close();
      onSaved && onSaved();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

// Render a charge or credit "block" — a card that for charges also shows
// payment progress (paid / remaining) and any linked payments underneath.
function renderAdjustmentBlock(a, isAdmin) {
  const isCharge = a.kind === 'charge';
  const headerBadge = isCharge
    ? `<span class="badge badge--danger">${esc(t('apt.adjustment.charge'))}</span>`
    : `<span class="badge badge--success">${esc(t('apt.adjustment.credit'))}</span>`;
  const sign = isCharge ? '+' : '−';
  const amountCls = isCharge ? 'text-danger' : 'text-success';

  if (!isCharge) {
    // Credits: just show the row (no per-item payments).
    return `
      <div class="card" style="padding:10px 14px">
        <div class="hstack" style="gap:10px">
          ${headerBadge}
          <div class="num ${amountCls}" style="font-weight:600">${sign}${fmtCurrency(a.amount)}</div>
          <div class="muted" style="font-size:12px">${fmtDate(a.effectiveDate)}</div>
          <div class="spacer"></div>
          ${isAdmin ? `<button class="btn btn--sm btn--icon" data-act="del-adj" data-aid="${a.id}">${Icon.trash}</button>` : ''}
        </div>
        ${a.notes ? `<div class="muted" style="font-size:13px; margin-top:4px">${esc(a.notes)}</div>` : ''}
      </div>
    `;
  }

  // Charges: show paid/remaining + quick-pay buttons + linked payments.
  const cps = chargePaymentStatus(a.id);
  const paid = cps.paid;
  const remaining = cps.remaining;
  const statusBadge = cps.status === 'paid'
    ? `<span class="badge badge--success">${esc(t('apt.adjustment.fullyPaid'))}</span>`
    : cps.status === 'partial'
    ? `<span class="badge badge--warning">${esc(t('apt.adjustment.partial'))}</span>`
    : `<span class="badge badge--danger">${esc(t('apt.adjustment.unpaid'))}</span>`;

  const quickPayBtn = isAdmin && remaining > 0
    ? `<button class="btn btn--sm btn--accent" data-act="quick-pay-adj" data-aid="${a.id}" data-amt="${remaining}" title="${esc(t('apt.adjustment.payment.markPaid'))}">${Icon.check} ${esc(t('apt.adjustment.payment.markPaidWith', { amount: fmtCurrency(remaining) }))}</button>`
    : '';
  const partialBtn = isAdmin && remaining > 0
    ? `<button class="btn btn--sm" data-act="pay-adj" data-aid="${a.id}">${Icon.plus}</button>`
    : '';

  return `
    <div class="card" style="padding:10px 14px">
      <div class="hstack" style="gap:10px; flex-wrap:wrap">
        ${headerBadge}
        <div class="num ${amountCls}" style="font-weight:600">${sign}${fmtCurrency(a.amount)}</div>
        <div class="muted" style="font-size:12px">${fmtDate(a.effectiveDate)}</div>
        <div class="spacer"></div>
        ${statusBadge}
        ${isAdmin ? `<button class="btn btn--sm btn--icon" data-act="del-adj" data-aid="${a.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>` : ''}
      </div>
      ${a.notes ? `<div class="muted" style="font-size:13px; margin-top:4px">${esc(a.notes)}</div>` : ''}
      <div class="hstack" style="gap:14px; margin-top:8px; font-size:13px">
        <span>${esc(t('apt.adjustment.paid'))}: <strong class="text-success">${fmtCurrency(paid)}</strong></span>
        <span>${esc(t('apt.adjustment.remaining'))}: <strong class="${remaining > 0 ? 'text-danger' : 'muted'}">${fmtCurrency(remaining)}</strong></span>
        <div class="spacer"></div>
        ${quickPayBtn}
        ${partialBtn}
      </div>
      ${cps.payments.length ? `
        <div class="vstack" style="gap:4px; margin-top:8px; padding-inline-start:16px; border-inline-start:2px solid var(--c-border)">
          ${cps.payments.map(p => `
            <div class="hstack" style="gap:8px; font-size:13px">
              <span class="text-success">−${fmtCurrency(p.amount)}</span>
              <span class="muted">${fmtDate(p.paidOn)}${p.method ? ` · ${esc(t('pay.method.' + p.method))}` : ''}</span>
              ${p.notes ? `<span class="muted">· ${esc(p.notes)}</span>` : ''}
              <div class="spacer"></div>
              ${isAdmin ? `<button class="btn btn--sm btn--icon" data-act="del-apay" data-pid="${p.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>` : ''}
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

// Dialog for recording a partial (or full) payment toward a specific charge.
function openAdjustmentPaymentDialog(adj, onSaved) {
  if (!requireAdmin()) return;
  const cps = chargePaymentStatus(adj.id);
  const m = openModal({
    title: t('apt.adjustment.payment.dialog.title'),
    body: `
      <form id="apay-form" class="form-grid">
        <div class="field" style="grid-column:1/-1">
          <div class="muted" style="font-size:13px">
            ${esc(adj.notes || '')} ${adj.notes ? '·' : ''}
            ${esc(t('apt.adjustment.remaining'))}: <strong>${fmtCurrency(cps.remaining)}</strong>
            / ${esc(t('common.amount'))}: <strong>${fmtCurrency(adj.amount)}</strong>
          </div>
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('apt.adjustment.payment.field.amount'))}</label>
          <input class="input" name="amount" type="number" step="0.01" min="0.01" max="${cps.remaining}" required value="${cps.remaining}" />
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('apt.adjustment.payment.field.date'))}</label>
          <input class="input" name="paidOn" type="date" required value="${todayISO()}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('apt.adjustment.payment.field.method'))}</label>
          <select class="select" name="method">
            <option value="bank">${esc(t('pay.method.bank'))}</option>
            <option value="bit">${esc(t('pay.method.bit'))}</option>
            <option value="check">${esc(t('pay.method.check'))}</option>
            <option value="cash">${esc(t('pay.method.cash'))}</option>
            <option value="other">${esc(t('pay.method.other'))}</option>
          </select>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('apt.adjustment.payment.field.notes'))}</label>
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
    const f = m.bodyEl.querySelector('#apay-form');
    const data = Object.fromEntries(new FormData(f).entries());
    const amount = Number(data.amount);
    if (!amount || amount <= 0) { toast(t('apt.adjustment.payment.field.amount'), 'warning'); return; }
    if (!data.paidOn) { toast(t('apt.adjustment.dateRequired'), 'warning'); return; }
    try {
      await createAdjustmentPayment({
        adjustmentId: adj.id,
        amount,
        paidOn: data.paidOn,
        method: data.method,
        notes: data.notes || null,
      });
      toast(t('apt.adjustment.payment.recorded'), 'success');
      m.close();
      onSaved && onSaved();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

// ---------- Combined per-cell editor (X of Y) ----------
// Single dialog that lets the admin edit BOTH the expected (Y) and the paid (X)
// amounts for a single (apartment, year, month) cell. Includes a "fill to
// expected" shortcut for the common "mark as fully paid" case.
//
// Save semantics:
//   * If entered Y equals the inherited global fee → clears any existing
//     override (so future global-fee changes still flow through).
//     Otherwise upserts the override.
//   * For X: deletes all existing payment rows for this (apt, year, month) and
//     creates one new row with the entered amount and date. Setting X to 0
//     leaves the cell with no payments.
function openCellEditor({ apt, year, month, onDone }) {
  const settings = getSettings();
  const st = apartmentMonthStatus(apt.id, year, month);
  const ps = getPayments().filter(p => p.apartmentId === apt.id && p.year === year && p.month === month);
  const inheritedFee = (() => {
    const fee = valueAtMonth(settings.monthlyFeeHistory, year, month);
    return fee ? Number(fee.amount) || 0 : 0;
  })();
  const curExpected = st.expected;
  const curPaid = st.paid;
  const pcount = ps.length;

  const m = openModal({
    title: t('apt.ledger.editCell.title', { month: monthName(month), year, number: apt.number }),
    body: `
      <div class="vstack" style="gap:14px">
        <div class="callout" style="font-size:13px">
          <div><strong>${esc(t('apt.ledger.editCell.intro'))}</strong></div>
          <div class="muted" style="margin-top:4px">${esc(t('apt.ledger.editCell.hint'))}</div>
        </div>
        <form id="cell-form" class="form-grid">
          <div class="field field--required">
            <label class="field__label">${esc(t('apt.ledger.expected'))} (Y)</label>
            <div class="hstack" style="gap:6px">
              <input class="input" id="cell-y" type="number" name="expected" step="0.01" min="0" value="${curExpected}" autofocus />
              <button type="button" class="btn btn--ghost btn--sm" data-act="reset-y" title="${esc(t('apt.ledger.editExpected.reset'))}">↺</button>
            </div>
            <div class="field__hint">${esc(t('apt.ledger.editExpected.hint', { value: fmtCurrency(inheritedFee) }))}</div>
          </div>
          <div class="field field--required">
            <label class="field__label">${esc(t('apt.col.paid'))} (X)</label>
            <div class="hstack" style="gap:6px">
              <input class="input" id="cell-x" type="number" name="paid" step="0.01" min="0" value="${curPaid}" />
              <button type="button" class="btn btn--ghost btn--sm" data-act="fill-x" title="${esc(t('apt.ledger.editCell.fillX'))}">${esc(t('apt.ledger.editCell.fillX'))}</button>
            </div>
            <div class="field__hint">
              ${pcount === 0 ? esc(t('apt.ledger.editPaid.hint.empty'))
              : pcount === 1 ? esc(t('apt.ledger.editPaid.hint.one'))
              : esc(t('apt.ledger.editPaid.hint.many', { n: pcount }))}
            </div>
          </div>
          <div class="field">
            <label class="field__label">${esc(t('pay.field.date'))}</label>
            <input class="input" type="date" name="paidOn" value="${ps[0]?.paidOn || todayISO()}" />
          </div>
          <div class="field">
            <label class="field__label">${esc(t('apt.ledger.editExpected.notes'))}</label>
            <input class="input" name="notes" placeholder="${esc(t('apt.ledger.editExpected.notes.placeholder'))}" />
          </div>
        </form>
        <div id="cell-preview" style="font-size:13px; min-height:1.4em"></div>
      </div>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save">${esc(t('common.save'))}</button>
    `,
    size: 'md',
  });
  // ↺ — clear the per-cell override (resets Y to the global fee).
  m.bodyEl.querySelector('[data-act="reset-y"]').addEventListener('click', () => {
    m.bodyEl.querySelector('#cell-y').value = inheritedFee;
    updatePreview();
  });
  // X = Y shortcut.
  m.bodyEl.querySelector('[data-act="fill-x"]').addEventListener('click', () => {
    const y = Number(m.bodyEl.querySelector('#cell-y').value || 0);
    m.bodyEl.querySelector('#cell-x').value = y;
    updatePreview();
  });
  // Live preview of the resulting balance — built via DOM API (no innerHTML).
  const preview = m.bodyEl.querySelector('#cell-preview');
  const updatePreview = () => {
    const y = Number(m.bodyEl.querySelector('#cell-y').value || 0);
    const x = Number(m.bodyEl.querySelector('#cell-x').value || 0);
    const diff = x - y;
    preview.textContent = '';
    preview.className = '';
    if (y > 0 && diff < 0) {
      preview.classList.add('text-danger');
      preview.textContent = t('apt.ledger.editCell.previewDebt', { amount: fmtCurrency(Math.abs(diff)) });
    } else if (diff > 0) {
      preview.classList.add('text-success');
      preview.textContent = t('apt.ledger.editCell.previewCredit', { amount: fmtCurrency(diff) });
    } else if (y > 0 && Math.abs(diff) < 0.005) {
      preview.classList.add('text-success');
      preview.textContent = t('apt.ledger.editCell.previewBalanced');
    }
  };
  m.bodyEl.querySelector('#cell-y').addEventListener('input', updatePreview);
  m.bodyEl.querySelector('#cell-x').addEventListener('input', updatePreview);
  updatePreview();

  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#cell-form');
    const data = Object.fromEntries(new FormData(f).entries());
    const newY = Number(data.expected);
    const newX = Number(data.paid);
    if (!Number.isFinite(newY) || newY < 0 || !Number.isFinite(newX) || newX < 0) {
      toast(t('common.error'), 'warning');
      return;
    }
    if (pcount >= 2 && Math.abs(newX - curPaid) > 0.005) {
      const ok = await confirmDialog({
        title: t('apt.ledger.editPaid.confirm.title'),
        message: t('apt.ledger.editPaid.confirm.message', { n: pcount }),
        confirmText: t('common.replace'), danger: true,
      });
      if (!ok) return;
    }
    try {
      // 1. Y — set or clear the override.
      if (Math.abs(newY - curExpected) > 0.005 || data.notes) {
        if (Math.abs(newY - inheritedFee) < 0.005 && !data.notes) {
          await clearFeeOverride({ apartmentId: apt.id, year, month });
        } else {
          await setFeeOverride({ apartmentId: apt.id, year, month, amount: newY, notes: data.notes || null });
        }
      }
      // 2. X — replace payment rows only if X actually changed.
      if (Math.abs(newX - curPaid) > 0.005) {
        const existing = getPayments().filter(p => p.apartmentId === apt.id && p.year === year && p.month === month);
        for (const p of existing) await deletePayment(p.id);
        if (newX > 0) {
          await upsertPayment({ apartmentId: apt.id, year, month, amount: newX, paidOn: data.paidOn || todayISO(), method: 'bit' });
        }
      }
      toast(t('common.saveDone'), 'success');
      m.close();
      onDone && onDone();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

