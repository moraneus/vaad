// Contacts directory

import { getContacts, upsertContact, deleteContact } from '../store.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { setHTML, renderPageHeader, renderEmpty, openModal, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';
import { getSession } from '../store.js';

let searchTerm = '';

export function renderContacts() {
  const main = document.getElementById('app-main');
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const all = [...getContacts()].sort((a, b) => (a.company || '').localeCompare(b.company || ''));
  const list = searchTerm
    ? all.filter(c => {
        const q = searchTerm.toLowerCase();
        return ['company', 'name', 'phone', 'role', 'email', 'notes'].some(k => (c[k] || '').toLowerCase().includes(q));
      })
    : all;

  setHTML(main, `
    ${renderPageHeader({
      title: t('contacts.title'),
      subtitle: t('contacts.subtitle'),
      actions: isAdmin ? `<button class="btn btn--primary" id="add-c">${Icon.plus} ${esc(t('contacts.add'))}</button>` : '',
    })}

    <div class="toolbar">
      <input class="input" id="search" placeholder="${esc(t('contacts.search'))}" value="${esc(searchTerm)}" style="width:280px" />
      <div class="spacer"></div>
      <div class="muted">${list.length} ${esc(t('common.outOf', { n: all.length }))}</div>
    </div>

    ${list.length === 0 ? renderEmpty({
      title: all.length === 0 ? t('contacts.empty.title') : t('contacts.empty.none'),
      hint: all.length === 0 ? t('contacts.empty.hint') : t('contacts.empty.tryAnother'),
      action: isAdmin && all.length === 0 ? `<button class="btn btn--primary" id="add-c-empty">${Icon.plus} ${esc(t('contacts.add'))}</button>` : '',
    }) : `
      <div class="card card--padless">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>${esc(t('contacts.col.company'))}</th>
                <th>${esc(t('contacts.col.name'))}</th>
                <th>${esc(t('contacts.col.role'))}</th>
                <th>${esc(t('contacts.col.phone'))}</th>
                <th>${esc(t('contacts.col.email'))}</th>
                <th>${esc(t('contacts.col.notes'))}</th>
                <th class="actions">${esc(t('common.actions'))}</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(c => renderRow(c, isAdmin)).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `}
  `);

  document.getElementById('search').addEventListener('input', (e) => { searchTerm = e.target.value; renderContacts(); });
  document.getElementById('add-c')?.addEventListener('click', () => openContactDialog());
  document.getElementById('add-c-empty')?.addEventListener('click', () => openContactDialog());
  document.querySelectorAll('[data-act="edit-c"]').forEach(b => b.addEventListener('click', () => {
    const c = getContacts().find(x => x.id === b.dataset.id);
    openContactDialog(c);
  }));
  document.querySelectorAll('[data-act="del-c"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const c = getContacts().find(x => x.id === b.dataset.id);
    const ok = await confirmDialog({ title: t('contacts.delete.title'), message: t('contacts.delete.message', { name: c.company || c.name }), danger: true, confirmText: t('common.delete') });
    if (ok) { try { await deleteContact(c.id); toast(t('contacts.deleted'), 'success'); renderContacts(); } catch (err) { toast(err.message || t('common.error'), 'danger'); } }
  }));
}

function renderRow(c, isAdmin) {
  return `
    <tr>
      <td><strong>${esc(c.company || '—')}</strong></td>
      <td>${esc(c.name || '—')}</td>
      <td>${esc(c.role || '—')}</td>
      <td>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '<span class="muted">—</span>'}</td>
      <td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '<span class="muted">—</span>'}</td>
      <td class="muted" style="max-width:280px">${esc(c.notes || '')}</td>
      <td class="actions">
        ${isAdmin ? `
          <button class="btn btn--sm btn--icon" data-act="edit-c" data-id="${c.id}" title="${esc(t('common.edit'))}">${Icon.edit}</button>
          <button class="btn btn--sm btn--icon" data-act="del-c" data-id="${c.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>
        ` : ''}
      </td>
    </tr>
  `;
}

function openContactDialog(c = null) {
  if (!requireAdmin()) return;
  const isEdit = !!c;
  const m = openModal({
    title: isEdit ? t('contacts.dialog.edit') : t('contacts.dialog.add'),
    body: `
      <form id="c-form" class="form-grid" autocomplete="off">
        <div class="field field--required" style="grid-column:1/-1">
          <label class="field__label">${esc(t('contacts.field.company'))}</label>
          <input class="input" name="company" required value="${esc(c?.company || '')}" placeholder="${esc(t('contacts.field.companyPlaceholder'))}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('contacts.field.name'))}</label>
          <input class="input" name="name" value="${esc(c?.name || '')}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('contacts.field.role'))}</label>
          <input class="input" name="role" value="${esc(c?.role || '')}" placeholder="${esc(t('contacts.field.rolePlaceholder'))}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('contacts.field.phone'))}</label>
          <input class="input" name="phone" type="tel" value="${esc(c?.phone || '')}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('contacts.field.email'))}</label>
          <input class="input" name="email" type="email" value="${esc(c?.email || '')}" />
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('common.notes'))}</label>
          <textarea class="textarea" name="notes" rows="3">${esc(c?.notes || '')}</textarea>
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
    const f = m.bodyEl.querySelector('#c-form');
    const d = Object.fromEntries(new FormData(f).entries());
    if (!d.company) { toast(t('contacts.companyRequired'), 'warning'); return; }
    try {
      await upsertContact({ id: c?.id, ...d });
      toast(isEdit ? t('contacts.updated') : t('contacts.added'), 'success');
      m.close();
      renderContacts();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}
