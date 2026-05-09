// Owners management page (admin-only). Lists all property owners with
// apartment count + login status. Click a row → opens the owner edit dialog
// (defined in views/apartments.js — reused for consistency with the
// expand-row link in the apartments table).

import { getOwners, getApartments, deleteOwner } from '../store.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { setHTML, renderPageHeader, renderEmpty, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';
import { openOwnerDialog, openCreateOwnerDialog, openPasswordManagerDialog } from './apartments.js';

// Sort mode for the owners list. Persists per-tab so a navigate-away and back
// returns to the chosen sort. Default: by apartment number — that's the
// shared mental model in the building (residents identify by apartment, not
// by family name).
let sortMode = 'apartment';

// Renders the phones cell for the owners table. New owners have an array of
// { label, phone } in `phones`; legacy rows just have a single `phone` string.
// Display each entry as a tel: link with an optional "(label)" suffix.
function renderPhonesCell(owner) {
  const phones = Array.isArray(owner.phones) && owner.phones.length
    ? owner.phones
    : (owner.phone ? [{ phone: owner.phone, label: '' }] : []);
  if (!phones.length) return '<span class="muted">—</span>';
  return `<div class="vstack" style="gap:2px">${phones.map(p => `
    <span><a href="tel:${esc(p.phone)}" class="muted">${esc(p.phone)}</a>${p.label ? `<span class="muted" style="font-size:11px"> · ${esc(p.label)}</span>` : ''}</span>
  `).join('')}</div>`;
}

// Builds Map<owner_id, sorted apartment numbers[]> from the apartments cache.
// Used both for sorting and for rendering the apartment-count cell as a list
// of numbers (more useful than a bare count).
function apartmentsByOwner() {
  const map = new Map();
  for (const a of getApartments()) {
    if (!a.ownerId) continue;
    const arr = map.get(a.ownerId) || [];
    arr.push(String(a.number));
    map.set(a.ownerId, arr);
  }
  // Numeric-aware sort within each list — "2" before "10".
  for (const arr of map.values()) {
    arr.sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true }));
  }
  return map;
}

export function renderOwners() {
  const main = document.getElementById('app-main');
  const aptsByOwner = apartmentsByOwner();
  const owners = [...getOwners()];

  // Sort owners according to the chosen mode.
  if (sortMode === 'name') {
    owners.sort((a, b) => String(a.name).localeCompare(String(b.name), 'he'));
  } else {
    // 'apartment' — by the lowest apartment number each owner holds (numeric
    // collation). Owners with no apartments sink to the bottom; among them,
    // alphabetical by name.
    owners.sort((a, b) => {
      const aa = aptsByOwner.get(a.id) || [];
      const bb = aptsByOwner.get(b.id) || [];
      if (!aa.length && !bb.length) return String(a.name).localeCompare(String(b.name), 'he');
      if (!aa.length) return 1;
      if (!bb.length) return -1;
      return String(aa[0]).localeCompare(String(bb[0]), undefined, { numeric: true });
    });
  }

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
      <div class="hstack" style="margin-bottom:10px; gap:8px; align-items:center">
        <label class="muted" style="font-size:12px">${esc(t('owners.sortBy'))}</label>
        <select id="owners-sort" class="select" style="width:auto">
          <option value="apartment" ${sortMode === 'apartment' ? 'selected' : ''}>${esc(t('owners.sort.apartment'))}</option>
          <option value="name" ${sortMode === 'name' ? 'selected' : ''}>${esc(t('owners.sort.name'))}</option>
        </select>
      </div>
      <div class="card card--padless">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>${esc(t('owners.col.apartments'))}</th>
                <th>${esc(t('owners.col.name'))}</th>
                <th>${esc(t('owners.col.phone'))}</th>
                <th>${esc(t('owners.col.email'))}</th>
                <th>${esc(t('owners.col.loginEmail'))}</th>
                <th class="actions">${esc(t('common.actions'))}</th>
              </tr>
            </thead>
            <tbody>
              ${owners.map(o => {
                const nums = aptsByOwner.get(o.id) || [];
                const aptsCell = nums.length
                  ? `<strong>${esc(nums.join(', '))}</strong>`
                  : `<span class="muted">${esc(t('owners.col.apartments.none'))}</span>`;
                return `
                <tr>
                  <td>${aptsCell}</td>
                  <td>${esc(o.name)}</td>
                  <td>${renderPhonesCell(o)}</td>
                  <td>${o.email ? `<a href="mailto:${esc(o.email)}" class="muted" style="direction:ltr">${esc(o.email)}</a>` : '<span class="muted">—</span>'}</td>
                  <td>${o.loginEmail ? `<span style="direction:ltr">${esc(o.loginEmail)}</span> ${o.hasPassword ? `<span class="badge badge--success" style="font-size:10px; padding:1px 6px">${esc(t('owners.badge.canLogin'))}</span>` : ''}` : `<span class="muted">${esc(t('owners.col.loginEmail.notSet'))}</span>`}</td>
                  <td class="actions">
                    <button class="btn btn--sm btn--icon" data-act="edit-own" data-id="${o.id}" title="${esc(t('common.edit'))}">${Icon.edit}</button>
                    <button class="btn btn--sm btn--icon" data-act="pw-own" data-id="${o.id}" title="${esc(t('pwMgr.tooltip'))}">🔑</button>
                    <button class="btn btn--sm btn--icon" data-act="del-own" data-id="${o.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>
                  </td>
                </tr>
              `;}).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `}
  `);

  document.getElementById('owners-sort')?.addEventListener('change', (e) => {
    sortMode = e.target.value === 'name' ? 'name' : 'apartment';
    renderOwners();
  });

  const openCreate = () => openCreateOwnerDialog(() => renderOwners());
  document.getElementById('add-owner')?.addEventListener('click', openCreate);
  document.getElementById('add-owner-empty')?.addEventListener('click', openCreate);
  document.querySelectorAll('[data-act="edit-own"]').forEach(b => b.addEventListener('click', () => {
    const owner = owners.find(o => o.id === b.dataset.id);
    if (owner) openOwnerDialog(owner, () => renderOwners());
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
