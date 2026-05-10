// Documents library — upload/view/download/delete via Google Drive (proxied through Pages Functions).

import { getDocuments, uploadDocument, deleteDocument, getExpenses, getPayments, getInfrastructureExpenses } from '../store.js';
import { api } from '../api.js';
import { fmtDate, formatBytes, esc } from '../utils.js';
import { t } from '../i18n.js';
import { setHTML, renderPageHeader, renderEmpty, openModal, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';
import { getSession } from '../store.js';

export function renderDocuments() {
  const main = document.getElementById('app-main');
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const docs = [...getDocuments()].sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  const totalSize = docs.reduce((s, d) => s + (d.size || 0), 0);
  const expenses = getExpenses();
  const payments = getPayments();
  const infraExpenses = getInfrastructureExpenses();
  const links = new Map();
  for (const e of expenses) for (const id of (e.documents || [])) {
    if (!links.has(id)) links.set(id, []);
    links.get(id).push({ kind: 'expense', label: t('docs.linkedExpense', { name: e.name }) });
  }
  for (const p of payments) for (const id of (p.documents || [])) {
    if (!links.has(id)) links.set(id, []);
    links.get(id).push({ kind: 'payment', label: t('docs.linkedPayment', { ym: `${p.year}/${String(p.month).padStart(2,'0')}` }) });
  }
  // Infrastructure-expense links — populated from the document.links array
  // (added to the documents endpoint when we introduced the new attachment).
  const infraById = new Map(infraExpenses.map(e => [e.id, e]));
  // Per-payment links — same shape, but the targetId is an expense_payments
  // row. We label by parent expense + month so the admin can locate it.
  const expensePaymentsList = (window.__VAAD__?.getCache?.()?.expensePayments) || [];
  const paymentById = new Map(expensePaymentsList.map(p => [p.id, p]));
  const expensesById = new Map(expenses.map(e => [e.id, e]));
  for (const d of docs) {
    for (const l of (d.links || [])) {
      if (l.type === 'infrastructure_expense') {
        const infra = infraById.get(l.targetId);
        const label = infra ? t('docs.linkedInfra', { name: infra.name }) : t('docs.linkedInfraDeleted');
        if (!links.has(d.id)) links.set(d.id, []);
        links.get(d.id).push({ kind: 'infra', label });
      } else if (l.type === 'expense_payment') {
        const pay = paymentById.get(l.targetId);
        const exp = pay ? expensesById.get(pay.expenseId) : null;
        const label = pay && exp
          ? t('docs.linkedExpensePayment', { name: exp.name, ym: `${pay.year}/${String(pay.month).padStart(2,'0')}` })
          : t('docs.linkedExpensePaymentDeleted');
        if (!links.has(d.id)) links.set(d.id, []);
        links.get(d.id).push({ kind: 'expense_payment', label });
      }
    }
  }

  setHTML(main, `
    ${renderPageHeader({
      title: t('docs.title'),
      subtitle: t('docs.subtitle', { count: docs.length, size: formatBytes(totalSize) }),
      actions: isAdmin ? `<button class="btn btn--primary" id="upload">${Icon.upload} ${esc(t('docs.upload'))}</button>` : '',
    })}

    <div class="callout">${esc(t('docs.security'))}</div>

    ${docs.length === 0 ? renderEmpty({
      title: t('docs.empty.title'),
      hint: t('docs.empty.hint'),
      action: isAdmin ? `<button class="btn btn--primary" id="upload-empty">${Icon.upload} ${esc(t('docs.upload'))}</button>` : '',
    }) : `
      <div class="card card--padless">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>${esc(t('docs.col.name'))}</th>
                <th>${esc(t('docs.col.type'))}</th>
                <th class="num">${esc(t('docs.col.size'))}</th>
                <th>${esc(t('docs.col.uploaded'))}</th>
                <th>${esc(t('docs.col.linked'))}</th>
                <th class="actions">${esc(t('common.actions'))}</th>
              </tr>
            </thead>
            <tbody>
              ${docs.map(d => {
                // displayName comes from document_meta (server coalesces to filename
                // when no display_name is set). The original filename is kept as a
                // tooltip + the download attribute so the file lands with its real name.
                const display = d.displayName || d.name;
                const showFilename = display !== d.name;
                return `
                <tr>
                  <td>
                    <strong>${esc(display)}</strong>
                    ${showFilename ? `<div class="muted" style="font-size:11px">${esc(d.name)}</div>` : ''}
                  </td>
                  <td>${esc(d.mimeType?.split('/')[1] || '—')}</td>
                  <td class="num">${formatBytes(d.size)}</td>
                  <td>${fmtDate(d.uploadedAt)}</td>
                  <td>${(links.get(d.id) || []).map(l => `<div class="muted" style="font-size:12px">${esc(l.label)}</div>`).join('') || `<span class="muted">${esc(t('docs.unlinked'))}</span>`}</td>
                  <td class="actions">
                    <a class="btn btn--sm" href="${api.documentURL(d.id)}" target="_blank" rel="noopener">${esc(t('common.view'))}</a>
                    <a class="btn btn--sm" href="${api.documentURL(d.id)}" download="${esc(d.name)}">${Icon.download}</a>
                    ${isAdmin ? `
                      <button class="btn btn--sm btn--icon" data-act="ren" data-id="${d.id}" data-name="${esc(display)}" title="${esc(t('docs.rename'))}">${Icon.edit}</button>
                      <button class="btn btn--sm btn--icon" data-act="del" data-id="${d.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>
                    ` : ''}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `}
  `);

  document.getElementById('upload')?.addEventListener('click', openUploadDialog);
  document.getElementById('upload-empty')?.addEventListener('click', openUploadDialog);
  document.querySelectorAll('[data-act="del"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const ok = await confirmDialog({ title: t('docs.delete.title'), message: t('docs.delete.message'), danger: true, confirmText: t('common.delete') });
    if (ok) {
      try { await deleteDocument(b.dataset.id); toast(t('contacts.deleted'), 'success'); renderDocuments(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }
  }));
  document.querySelectorAll('[data-act="ren"]').forEach(b => b.addEventListener('click', () => {
    if (!requireAdmin()) return;
    openRenameDialog({ id: b.dataset.id, currentName: b.dataset.name });
  }));
}

// Upload dialog — file picker + optional display name. When the admin picks a
// file, the name field is auto-populated with the filename (sans extension).
// Multi-file upload uses each file's filename (the name field is hidden then).
function openUploadDialog() {
  if (!requireAdmin()) return;
  const m = openModal({
    title: t('docs.upload'),
    body: `
      <form id="upload-form" class="vstack" autocomplete="off">
        <div class="field field--required">
          <label class="field__label">${esc(t('docs.upload.file'))}</label>
          <input class="input" id="up-file" type="file" accept="image/*,application/pdf" multiple />
        </div>
        <div class="field" id="up-name-wrap">
          <label class="field__label">${esc(t('docs.upload.displayName'))}</label>
          <input class="input" id="up-name" type="text" maxlength="200" placeholder="${esc(t('docs.upload.displayName.placeholder'))}" />
          <div class="field__hint">${esc(t('docs.upload.displayName.hint'))}</div>
        </div>
      </form>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save" disabled>${esc(t('docs.upload'))}</button>
    `,
  });
  const fileInput = m.bodyEl.querySelector('#up-file');
  const nameInput = m.bodyEl.querySelector('#up-name');
  const nameWrap = m.bodyEl.querySelector('#up-name-wrap');
  const saveBtn = m.footerEl.querySelector('[data-act="save"]');
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    saveBtn.disabled = files.length === 0;
    // Multi-file → hide the name field (we'll use each filename).
    nameWrap.style.display = files.length > 1 ? 'none' : 'block';
    if (files.length === 1 && !nameInput.value.trim()) {
      const fn = files[0].name || '';
      const dot = fn.lastIndexOf('.');
      nameInput.value = dot > 0 ? fn.slice(0, dot) : fn;
    }
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  saveBtn.addEventListener('click', async () => {
    const files = Array.from(fileInput.files || []);
    if (!files.length) return;
    saveBtn.disabled = true;
    const displayName = files.length === 1 ? (nameInput.value || '').trim() : null;
    let added = 0;
    for (const file of files) {
      try {
        await uploadDocument(file, null, displayName);
        added++;
      } catch (err) {
        toast(`${file.name}: ${err.message || t('common.error')}`, 'danger');
      }
    }
    if (added) toast(t('docs.uploaded', { n: added }), 'success');
    m.close();
    renderDocuments();
  });
}

// Rename dialog — sets the document's display_name (or clears it on empty input).
function openRenameDialog({ id, currentName }) {
  const m = openModal({
    title: t('docs.rename'),
    body: `
      <form id="rename-form" class="vstack" autocomplete="off">
        <div class="field field--required">
          <label class="field__label">${esc(t('docs.upload.displayName'))}</label>
          <input class="input" id="rn-name" type="text" maxlength="200" value="${esc(currentName)}" autofocus />
          <div class="field__hint">${esc(t('docs.rename.hint'))}</div>
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
    const newName = (m.bodyEl.querySelector('#rn-name').value || '').trim();
    try {
      await api.renameDocument(id, newName);
      toast(t('common.saveDone'), 'success');
      m.close();
      // Force a refetch so the new displayName flows back through the cache.
      const { refreshAll } = await import('../store.js');
      await refreshAll();
      renderDocuments();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}
