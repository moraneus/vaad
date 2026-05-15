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
  getDocuments, uploadDocument, deleteDocument,
  getSession,
} from '../store.js';
import { fmtCurrency, esc, fmtDate, todayISO } from '../utils.js';
import { t } from '../i18n.js';
import { infrastructureDemandStatus } from '../calc.js';
import { setHTML, renderPageHeader, renderEmpty, openModal, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';
// All HTML interpolated below uses esc() for any user-supplied value;
// Icon.* are static SVG constants from ui.js and are safe to inline.

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
  // Documents already attached to this expense (edit mode only). Found by
  // intersecting the documents cache with the link entries pointing at this id.
  const existingDocs = isEdit
    ? getDocuments().filter(d => (d.links || []).some(l => l.type === 'infrastructure_expense' && l.targetId === exp.id))
    : [];
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
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('infra.dialog.files'))}</label>
          <div class="field__hint">${esc(t('infra.dialog.filesHint'))}</div>
          <div id="infra-existing-docs" style="margin-top:8px"></div>
          <div id="infra-files-queue" style="display:flex; flex-direction:column; gap:6px; margin-top:8px"></div>
          <div style="margin-top:8px">
            <input type="file" id="infra-files-input" accept="image/*,application/pdf" multiple style="display:none" />
            <button type="button" class="btn btn--sm" id="infra-add-files-btn">${Icon.upload} ${esc(t('infra.dialog.addFiles'))}</button>
          </div>
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

  // ----- File queue + (in edit mode) existing attachments -----
  const pendingFiles = [];
  const queueEl = m.bodyEl.querySelector('#infra-files-queue');
  const existingEl = m.bodyEl.querySelector('#infra-existing-docs');
  const fileInput = m.bodyEl.querySelector('#infra-files-input');

  const renderQueue = () => {
    if (!pendingFiles.length) { setHTML(queueEl, ''); return; }
    setHTML(queueEl, `
      <div class="muted" style="font-size:12px">${esc(t('infra.dialog.filesPending', { n: pendingFiles.length }))}</div>
      ${pendingFiles.map((entry, i) => `
        <div class="hstack" style="border:1px solid var(--c-border); padding:6px 10px; border-radius:8px; font-size:13px; gap:8px">
          <span title="${esc(entry.file.name)}">${Icon.document}</span>
          <input class="input pending-name-input" type="text" data-i="${i}"
                 value="${esc(entry.displayName)}"
                 placeholder="${esc(t('docs.field.displayNamePlaceholder'))}"
                 style="flex:1; min-width:120px; font-size:13px; padding:4px 8px" />
          <button type="button" class="btn btn--sm btn--icon" data-rm-i="${i}" title="${esc(t('common.delete'))}">${Icon.trash}</button>
        </div>
      `).join('')}
    `);
    queueEl.querySelectorAll('[data-rm-i]').forEach(b => b.addEventListener('click', () => {
      pendingFiles.splice(Number(b.dataset.rmI), 1);
      renderQueue();
    }));
    queueEl.querySelectorAll('.pending-name-input').forEach(el => el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      if (pendingFiles[i]) pendingFiles[i].displayName = el.value;
    }));
  };
  const renderExisting = () => {
    if (!existingDocs.length) { setHTML(existingEl, ''); return; }
    setHTML(existingEl, `
      <div class="muted" style="font-size:12px; margin-bottom:4px">${esc(t('infra.dialog.filesExisting', { n: existingDocs.length }))}</div>
      ${existingDocs.map(d => `
        <div class="hstack" style="border:1px solid var(--c-border); padding:6px 10px; border-radius:8px; font-size:13px; margin-bottom:4px; gap:6px">
          <span>${Icon.document}</span>
          <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(d.displayName || d.name)}</span>
          <a class="btn btn--sm" href="/api/documents/${esc(d.id)}" target="_blank" rel="noopener" title="${esc(t('common.view'))}">${esc(t('common.view'))}</a>
          <a class="btn btn--sm btn--icon" href="/api/documents/${esc(d.id)}" download="${esc(d.displayName || d.name)}" title="${esc(t('common.download'))}">${Icon.download}</a>
          <button type="button" class="btn btn--sm btn--icon" data-del-doc="${esc(d.id)}" title="${esc(t('common.delete'))}">${Icon.trash}</button>
        </div>
      `).join('')}
    `);
    existingEl.querySelectorAll('[data-del-doc]').forEach(b => b.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: t('common.delete'), message: t('docs.delete.confirm'), confirmText: t('common.delete'), danger: true });
      if (!ok) return;
      try {
        await deleteDocument(b.dataset.delDoc);
        const idx = existingDocs.findIndex(x => x.id === b.dataset.delDoc);
        if (idx >= 0) existingDocs.splice(idx, 1);
        renderExisting();
      } catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }));
  };
  m.bodyEl.querySelector('#infra-add-files-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    for (const f of fileInput.files || []) pendingFiles.push({ file: f, displayName: f.name });
    fileInput.value = '';
    renderQueue();
  });
  renderExisting();

  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#infra-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!data.name) { toast(t('infra.field.nameRequired'), 'warning'); return; }
    if (!data.expenseDate) { toast(t('infra.field.dateRequired'), 'warning'); return; }
    try {
      let expenseId = exp?.id;
      if (isEdit) {
        await updateInfrastructureExpense(exp.id, { name: data.name, expenseDate: data.expenseDate, notes: data.notes });
      } else {
        const totalAmount = Number(data.totalAmount);
        if (!Number.isFinite(totalAmount) || totalAmount <= 0) { toast(t('infra.field.totalAmountRequired'), 'warning'); return; }
        const created = await createInfrastructureExpense({ name: data.name, totalAmount, expenseDate: data.expenseDate, notes: data.notes });
        expenseId = created?.id;
      }
      // Upload queued files. Failures surface via toast and don't roll back
      // the expense — the admin can re-attach later from the edit dialog.
      let uploadFails = 0;
      for (const entry of pendingFiles) {
        try { await uploadDocument(entry.file, { type: 'infrastructure_expense', id: expenseId }, entry.displayName); }
        catch (err) { uploadFails++; toast(`${entry.file.name}: ${err.message || t('common.error')}`, 'danger'); }
      }
      if (uploadFails === 0) toast(isEdit ? t('infra.updated') : t('infra.added'), 'success');
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
    footer: `
      <button class="btn btn--sm" data-act="export-pdf">${Icon.document} ${esc(t('infra.demands.export.pdf'))}</button>
      <div class="spacer"></div>
      <button class="btn" data-act="close">${esc(t('common.close'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="close"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="export-pdf"]').addEventListener('click', () => exportInfraDemandsPDF(exp, apts));

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

// Print-friendly PDF of the per-apartment demands for one infrastructure
// expense. Shows the expense header + a row per apartment with name,
// amount demanded, amount paid, remaining, status, and each individual
// payment date. Same popup+print pattern as exportContactsPDF.
function exportInfraDemandsPDF(exp, apts) {
  const dir = document.documentElement.getAttribute('dir') || 'rtl';
  const title = t('infra.demands.export.pdfTitle', { name: exp.name });
  const demands = getInfrastructureDemands().filter(d => d.expenseId === exp.id);
  const demandsByApt = new Map(demands.map(d => [d.apartmentId, d]));
  let sumDemand = 0, sumPaid = 0;
  const rows = apts.map(apt => {
    const d = demandsByApt.get(apt.id);
    const ownerName = apt.ownerName || apt.owner || '—';
    if (!d) {
      return `<tr>
        <td>${esc(apt.number)}</td>
        <td>${esc(ownerName)}</td>
        <td colspan="5" style="color:#888">${esc(t('infra.demands.noDemand'))}</td>
      </tr>`;
    }
    const st = infrastructureDemandStatus(d.id);
    sumDemand += Number(d.amount) || 0;
    sumPaid += st.paid;
    const statusLabel = st.status === 'paid' ? t('apt.status.paid')
                      : st.status === 'partial' ? t('apt.status.partial')
                      : t('apt.status.unpaid');
    const paymentDates = st.payments.map(p => `${fmtDate(p.paidOn)} · ${fmtCurrency(p.amount)}`).join('<br>');
    return `<tr>
      <td>${esc(apt.number)}</td>
      <td>${esc(ownerName)}</td>
      <td class="num">${esc(fmtCurrency(d.amount))}</td>
      <td class="num">${esc(fmtCurrency(st.paid))}</td>
      <td class="num">${esc(fmtCurrency(st.remaining))}</td>
      <td>${esc(statusLabel)}</td>
      <td style="font-size:10px">${paymentDates || '—'}</td>
    </tr>`;
  }).join('');
  const html = `<!doctype html>
<html lang="he" dir="${dir}">
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:24px;color:#111}
    h1{font-size:18px;margin:0 0 6px}
    .meta{color:#555;font-size:12px;margin-bottom:14px}
    table{border-collapse:collapse;width:100%;font-size:11px}
    th,td{border:1px solid #ccc;padding:5px 7px;text-align:start;vertical-align:top}
    th{background:#f3f3f3;font-weight:600}
    tfoot td{background:#fafafa;font-weight:600}
    .num{text-align:end}
    @media print{body{margin:12px}}
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(t('infra.demands.export.meta', { total: fmtCurrency(exp.totalAmount), date: fmtDate(exp.expenseDate), printed: fmtDate(todayISO()) }))}</div>
  <table>
    <thead>
      <tr>
        <th>${esc(t('apt.col.number'))}</th>
        <th>${esc(t('infra.col.payer'))}</th>
        <th class="num">${esc(t('infra.col.amount'))}</th>
        <th class="num">${esc(t('apt.col.paid'))}</th>
        <th class="num">${esc(t('infra.col.remaining'))}</th>
        <th>${esc(t('common.status'))}</th>
        <th>${esc(t('apt.ledger.payments'))}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="2">${esc(t('apt.totals.label'))}</td>
        <td class="num">${esc(fmtCurrency(sumDemand))}</td>
        <td class="num">${esc(fmtCurrency(sumPaid))}</td>
        <td class="num">${esc(fmtCurrency(sumDemand - sumPaid))}</td>
        <td colspan="2"></td>
      </tr>
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
