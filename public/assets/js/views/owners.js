// Owners management page (admin-only). Lists all property owners with
// apartment count + login status. Click a row → opens the owner edit dialog
// (defined in views/apartments.js — reused for consistency with the
// expand-row link in the apartments table).

import { getOwners, deleteOwner } from '../store.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { setHTML, renderPageHeader, renderEmpty, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';
import { openOwnerDialog, openCreateOwnerDialog, openPasswordManagerDialog } from './apartments.js';

export function renderOwners() {
  const main = document.getElementById('app-main');
  const owners = [...getOwners()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'he'));

  setHTML(main, `
    ${renderPageHeader({
      title: t('owners.title'),
      subtitle: t('owners.subtitle'),
      actions: `<button class="btn btn--primary" id="add-owner">${Icon.plus} ${esc(t('owners.add'))}</button>`,
    })}
    ${owners.length === 0 ? renderEmpty({
      title: t('owners.empty.title'),
      hint: t('owners.empty.hint'),
      action: `<button class="btn btn--primary" id="add-owner-empty">${Icon.plus} ${esc(t('owners.add'))}</button>`,
    }) : `
      <div class="card card--padless">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>${esc(t('owners.col.name'))}</th>
                <th>${esc(t('owners.col.phone'))}</th>
                <th>${esc(t('owners.col.email'))}</th>
                <th>${esc(t('owners.col.loginEmail'))}</th>
                <th class="num">${esc(t('owners.col.apartments'))}</th>
                <th class="actions">${esc(t('common.actions'))}</th>
              </tr>
            </thead>
            <tbody>
              ${owners.map(o => `
                <tr>
                  <td><strong>${esc(o.name)}</strong></td>
                  <td>${o.phone ? `<a href="tel:${esc(o.phone)}" class="muted">${esc(o.phone)}</a>` : '<span class="muted">—</span>'}</td>
                  <td>${o.email ? `<a href="mailto:${esc(o.email)}" class="muted" style="direction:ltr">${esc(o.email)}</a>` : '<span class="muted">—</span>'}</td>
                  <td>${o.loginEmail ? `<span style="direction:ltr">${esc(o.loginEmail)}</span> ${o.hasPassword ? `<span class="badge badge--success" style="font-size:10px; padding:1px 6px">${esc(t('owners.badge.canLogin'))}</span>` : ''}` : `<span class="muted">${esc(t('owners.col.loginEmail.notSet'))}</span>`}</td>
                  <td class="num">${o.apartmentCount || 0}</td>
                  <td class="actions">
                    <button class="btn btn--sm btn--icon" data-act="edit-own" data-id="${o.id}" title="${esc(t('common.edit'))}">${Icon.edit}</button>
                    <button class="btn btn--sm btn--icon" data-act="pw-own" data-id="${o.id}" title="${esc(t('pwMgr.tooltip'))}">🔑</button>
                    <button class="btn btn--sm btn--icon" data-act="del-own" data-id="${o.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `}
  `);

  const openCreate = () => openCreateOwnerDialog(() => renderOwners());
  document.getElementById('add-owner')?.addEventListener('click', openCreate);
  document.getElementById('add-owner-empty')?.addEventListener('click', openCreate);
  document.querySelectorAll('[data-act="edit-own"]').forEach(b => b.addEventListener('click', () => {
    const owner = owners.find(o => o.id === b.dataset.id);
    if (owner) openOwnerDialog(owner);
  }));
  document.querySelectorAll('[data-act="pw-own"]').forEach(b => b.addEventListener('click', () => {
    if (!requireAdmin()) return;
    const owner = owners.find(o => o.id === b.dataset.id);
    if (!owner) return;
    openPasswordManagerDialog({
      kind: 'owner',
      id: owner.id,
      label: t('pwMgr.subject.owner', { name: owner.name }),
      hasPassword: !!owner.hasPassword,
      passwordSetAt: owner.passwordSetAt,
      onDone: () => renderOwners(),
    });
  }));
  document.querySelectorAll('[data-act="del-own"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const owner = owners.find(o => o.id === b.dataset.id);
    if (!owner) return;
    if ((owner.apartmentCount || 0) > 0) {
      toast(t('owners.delete.hasApts'), 'warning');
      return;
    }
    const ok = await confirmDialog({ title: t('owners.delete.title'), message: t('owners.delete.message', { name: owner.name }), confirmText: t('common.delete'), danger: true });
    if (!ok) return;
    try { await deleteOwner(owner.id); toast(t('owners.deleted'), 'success'); renderOwners(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));
}
