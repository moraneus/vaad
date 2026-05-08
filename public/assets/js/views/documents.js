// Documents library — upload/view/download/delete via Google Drive (proxied through Pages Functions).

import { getDocuments, uploadDocument, deleteDocument, getExpenses, getPayments } from '../store.js';
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
  const links = new Map();
  for (const e of expenses) for (const id of (e.documents || [])) {
    if (!links.has(id)) links.set(id, []);
    links.get(id).push({ kind: 'expense', label: t('docs.linkedExpense', { name: e.name }) });
  }
  for (const p of payments) for (const id of (p.documents || [])) {
    if (!links.has(id)) links.set(id, []);
    links.get(id).push({ kind: 'payment', label: t('docs.linkedPayment', { ym: `${p.year}/${String(p.month).padStart(2,'0')}` }) });
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
              ${docs.map(d => `
                <tr>
                  <td><strong>${esc(d.name)}</strong></td>
                  <td>${esc(d.mimeType?.split('/')[1] || '—')}</td>
                  <td class="num">${formatBytes(d.size)}</td>
                  <td>${fmtDate(d.uploadedAt)}</td>
                  <td>${(links.get(d.id) || []).map(l => `<div class="muted" style="font-size:12px">${esc(l.label)}</div>`).join('') || `<span class="muted">${esc(t('docs.unlinked'))}</span>`}</td>
                  <td class="actions">
                    <a class="btn btn--sm" href="${api.documentURL(d.id)}" target="_blank" rel="noopener">${esc(t('common.view'))}</a>
                    <a class="btn btn--sm" href="${api.documentURL(d.id)}" download="${esc(d.name)}">${Icon.download}</a>
                    ${isAdmin ? `<button class="btn btn--sm btn--icon" data-act="del" data-id="${d.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `}
  `);

  document.getElementById('upload')?.addEventListener('click', startUpload);
  document.getElementById('upload-empty')?.addEventListener('click', startUpload);
  document.querySelectorAll('[data-act="del"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const ok = await confirmDialog({ title: t('docs.delete.title'), message: t('docs.delete.message'), danger: true, confirmText: t('common.delete') });
    if (ok) {
      try { await deleteDocument(b.dataset.id); toast(t('contacts.deleted'), 'success'); renderDocuments(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }
  }));
}

function startUpload() {
  if (!requireAdmin()) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,application/pdf';
  input.multiple = true;
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    let added = 0;
    for (const file of files) {
      try { await uploadDocument(file); added++; }
      catch (err) { toast(`${file.name}: ${err.message || t('common.error')}`, 'danger'); }
    }
    if (added) toast(t('docs.uploaded', { n: added }), 'success');
    renderDocuments();
  });
  input.click();
}
