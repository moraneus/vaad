// Settings — building details, history, passwords, audit log, backup, reset

import {
  getSession, getSettings, getApartments, getOwners,
  updateSettingsBasic,
  addApartmentCountEntry, removeApartmentCountEntry, updateApartmentCountEntry,
  addMonthlyFeeEntry, removeMonthlyFeeEntry, updateMonthlyFeeEntry,
  changeAdminPassword, changeTenantPassword, adminResetApartmentPassword, adminResetOwnerPassword,
  grantApartmentAdmin, revokeApartmentAdmin, grantOwnerAdmin, revokeOwnerAdmin,
  loadAuditLog, getAuditLog, clearAuditLog,
  resetAll, exportJSON,
} from '../store.js';
import { fmtDate, fmtCurrency, esc, todayISO, downloadBlob, sortHistory } from '../utils.js';
import { t, fmtDateTime } from '../i18n.js';
import { setHTML, renderPageHeader, openModal, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';
import { api } from '../api.js';
import { wireLiveValidator, validatePassword } from '../password.js';
import { openPasswordManagerDialog } from './apartments.js';

let driveStatus = null;
let identityStatus = null;

export async function renderSettings() {
  const session = getSession();
  const isAdmin = session.role === 'admin';
  // Identity status is loaded for everyone (master admin AND apartment users)
  // since the recovery feature is per-user. The drive + audit calls are admin-only.
  const promises = [
    api.identityStatus().then(s => { identityStatus = s; }).catch(() => { identityStatus = null; }),
  ];
  if (isAdmin) {
    promises.push(
      loadAuditLog(100),
      api.driveStatus().then(s => { driveStatus = s; }).catch(() => { driveStatus = null; }),
    );
  }
  await Promise.all(promises);
  drawSettings();
}

function drawSettings() {
  const main = document.getElementById('app-main');
  const session = getSession();
  const isAdmin = session.role === 'admin';

  // Tenants get a slim view: change password + identity recovery + email opt-in.
  if (!isAdmin) {
    setHTML(main, `
      ${renderPageHeader({ title: t('settings.title'), subtitle: t('settings.password.tenantHint') })}
      <div style="max-width:560px">
        <div class="card" style="margin-bottom:14px">
          <h3 style="margin-top:0">${esc(t('settings.password'))}</h3>
          <p class="muted" style="font-size:13px">${esc(t('settings.password.tenantHint'))}</p>
          <button class="btn btn--primary" id="ch-tenant-pwd">${esc(t('settings.password.changeTenant'))}</button>
          ${identityStatus?.registered ? `
            <p class="muted" style="font-size:12px; margin-top:8px">${esc(t('settings.password.recoveryNote', { email: identityStatus.email }))}</p>
          ` : `
            <p class="muted" style="font-size:12px; margin-top:8px">${esc(t('settings.password.recoveryOptional'))}</p>
          `}
        </div>
        ${renderIdentityCard(identityStatus)}
        ${session.emailEnabled ? `
          <div class="card" id="tenant-email-card">
            <h3 style="margin-top:0">${esc(t('settings.tenantEmail.title'))}</h3>
            <p class="muted" style="font-size:13px">${esc(t('settings.tenantEmail.hint'))}</p>
            <div id="tenant-email-state" class="muted" style="font-size:13px">${esc(t('common.loading'))}</div>
          </div>
        ` : ''}
      </div>
    `);
    document.getElementById('ch-tenant-pwd')?.addEventListener('click', () => changeTenantPasswordDialog());
    document.getElementById('id-verify')?.addEventListener('click', () => startIdentityFlow('register'));
    document.getElementById('id-replace')?.addEventListener('click', () => startIdentityFlow('replace'));
    if (session.emailEnabled) refreshTenantEmailCard(session.apartmentId);
    return;
  }

  const s = getSettings();
  const ach = sortHistory(s.apartmentCountHistory || []);
  const fh = sortHistory(s.monthlyFeeHistory || []);
  const apts = [...getApartments()].sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  // Owner-side password management — list every first-class owner sorted
  // by their lowest apartment number (matches the Owners tab default sort).
  const ownerApts = new Map();
  for (const a of apts) {
    if (!a.ownerId) continue;
    const arr = ownerApts.get(a.ownerId) || [];
    arr.push(String(a.number));
    ownerApts.set(a.ownerId, arr);
  }
  for (const arr of ownerApts.values()) {
    arr.sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true }));
  }
  const ownersList = [...getOwners()].sort((a, b) => {
    const aa = ownerApts.get(a.id) || [];
    const bb = ownerApts.get(b.id) || [];
    if (!aa.length && !bb.length) return String(a.name || '').localeCompare(String(b.name || ''), 'he');
    if (!aa.length) return 1;
    if (!bb.length) return -1;
    return String(aa[0]).localeCompare(String(bb[0]), undefined, { numeric: true });
  });
  const audit = getAuditLog();

  // Helper: section header — small caps title + optional hint, with a hairline.
  const sectionHeader = (title, hint) => `
    <div style="display:flex; align-items:baseline; gap:10px; margin:28px 0 12px; padding-bottom:6px; border-bottom:1px solid var(--c-border)">
      <h2 style="margin:0; font-size:16px; font-weight:700; letter-spacing:0.02em; color:var(--c-text)">${esc(title)}</h2>
      ${hint ? `<span class="muted" style="font-size:12px">${esc(hint)}</span>` : ''}
    </div>
  `;

  setHTML(main, `
    ${renderPageHeader({ title: t('settings.title'), subtitle: t('settings.subtitle') })}

    ${!isAdmin ? `<div class="callout callout--warning">${esc(t('settings.viewerNotice'))}</div>` : ''}

    <div style="max-width:920px">

      ${sectionHeader(t('settings.section.general'))}
      <div class="card" style="margin-bottom:14px">
        <form id="basics" class="form-grid">
          <div class="field">
            <label class="field__label">${esc(t('settings.field.buildingName'))}</label>
            <input class="input" name="buildingName" value="${esc(s.buildingName || '')}" ${!isAdmin ? 'disabled' : ''} />
          </div>
          <div class="field">
            <label class="field__label">${esc(t('settings.field.buildingAddress'))}</label>
            <input class="input" name="buildingAddress" value="${esc(s.buildingAddress || '')}" ${!isAdmin ? 'disabled' : ''} />
          </div>
          ${isAdmin ? `<div style="grid-column:1/-1; text-align:start"><button class="btn btn--primary" type="submit">${esc(t('common.save'))}</button></div>` : ''}
        </form>
      </div>

      ${sectionHeader(t('settings.section.financial'))}
      <div class="card" style="margin-bottom:14px">
        <form id="financial" class="form-grid">
          <div class="field">
            <label class="field__label">${esc(t('settings.field.openingBalance'))}</label>
            <input class="input" name="openingBalance" type="number" step="0.01" value="${s.openingBalance ?? 0}" ${!isAdmin ? 'disabled' : ''} />
            <div class="field__hint">${esc(t('settings.field.openingBalanceHint'))}</div>
          </div>
          <div class="field">
            <label class="field__label">${esc(t('settings.field.openingBalanceDate'))}</label>
            <input class="input" name="openingBalanceDate" type="date" value="${esc(s.openingBalanceDate || todayISO())}" ${!isAdmin ? 'disabled' : ''} />
            <div class="field__hint">${esc(t('settings.field.openingBalanceDateHint'))}</div>
          </div>
          ${isAdmin ? `<div style="grid-column:1/-1; text-align:start"><button class="btn btn--primary" type="submit">${esc(t('common.save'))}</button></div>` : ''}
        </form>
      </div>

      <div class="card" style="margin-bottom:14px">
        <h3 style="margin:0 0 12px; font-size:15px">${esc(t('settings.display.title'))}</h3>
        <label class="checkbox" style="display:flex; gap:10px; align-items:flex-start; cursor:${isAdmin ? 'pointer' : 'default'}">
          <input type="checkbox" id="display-decimals-cb" ${s.displayDecimals ? 'checked' : ''} ${!isAdmin ? 'disabled' : ''} />
          <span>
            <span style="font-weight:500">${esc(t('settings.displayDecimals.label'))}</span>
            <div class="field__hint" style="margin-top:2px">${esc(t('settings.displayDecimals.hint'))}</div>
          </span>
        </label>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="hstack" style="margin-bottom:12px">
          <h3 style="margin:0; font-size:15px">${esc(t('settings.aptCount'))}</h3>
          <span class="muted" style="font-size:12px">${esc(t('settings.aptCount.hint'))}</span>
        </div>
        <div class="table-wrap" style="margin-bottom:12px">
          <table class="table">
            <thead><tr><th>${esc(t('settings.aptCount.col.from'))}</th><th class="num">${esc(t('settings.aptCount.col.count'))}</th>${isAdmin ? `<th class="actions"></th>` : ''}</tr></thead>
            <tbody>
              ${ach.map(e => `
                <tr>
                  <td>${fmtDate(e.effectiveFrom)}</td>
                  <td class="num">${e.count}</td>
                  ${isAdmin ? `<td class="actions">
                    <button class="btn btn--sm btn--icon" data-act="ed-cnt" data-id="${e.id}">${Icon.edit}</button>
                    ${ach.length > 1 ? `<button class="btn btn--sm btn--icon" data-act="rm-cnt" data-id="${e.id}">${Icon.trash}</button>` : ''}
                  </td>` : ''}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${isAdmin ? `<button class="btn btn--sm" id="add-cnt">${Icon.plus} ${esc(t('settings.aptCount.add'))}</button>` : ''}
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="hstack" style="margin-bottom:12px">
          <h3 style="margin:0; font-size:15px">${esc(t('settings.fee'))}</h3>
          <span class="muted" style="font-size:12px">${esc(t('settings.fee.hint'))}</span>
        </div>
        <div class="table-wrap" style="margin-bottom:12px">
          <table class="table">
            <thead><tr><th>${esc(t('settings.aptCount.col.from'))}</th><th class="num">${esc(t('settings.fee.col.amount'))}</th>${isAdmin ? `<th class="actions"></th>` : ''}</tr></thead>
            <tbody>
              ${fh.map(e => `
                <tr>
                  <td>${fmtDate(e.effectiveFrom)}</td>
                  <td class="num">${fmtCurrency(e.amount)}</td>
                  ${isAdmin ? `<td class="actions">
                    <button class="btn btn--sm btn--icon" data-act="ed-fee" data-id="${e.id}">${Icon.edit}</button>
                    ${fh.length > 1 ? `<button class="btn btn--sm btn--icon" data-act="rm-fee" data-id="${e.id}">${Icon.trash}</button>` : ''}
                  </td>` : ''}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${isAdmin ? `<button class="btn btn--sm" id="add-fee">${Icon.plus} ${esc(t('settings.fee.add'))}</button>` : ''}
      </div>

      ${sectionHeader(t('settings.section.security'))}

      ${renderIdentityCard(identityStatus)}

      ${!session.apartmentId ? `
        <!-- Master admin (no apartmentId): change-password gated on identity registration. -->
        <div class="card" style="margin-bottom:14px">
          <h3 style="margin-top:0; font-size:15px">${esc(t('settings.password'))}</h3>
          <p class="muted" style="font-size:13px">${esc(t('settings.password.adminHint'))}</p>
          ${identityStatus?.registered ? `
            <button class="btn btn--primary" id="ch-pwd-admin">${esc(t('settings.password.changeAdmin'))}</button>
            <p class="muted" style="font-size:12px; margin-top:8px">${esc(t('settings.password.recoveryNote', { email: identityStatus.email }))}</p>
          ` : `
            <div class="callout callout--warning" style="margin-bottom:10px">
              <div>${esc(t('settings.password.requiresIdentity'))}</div>
              <div class="muted" style="font-size:12px; margin-top:6px">↑ ${esc(t('settings.password.requiresIdentity.cta'))}</div>
            </div>
            <button class="btn btn--primary" id="ch-pwd-admin" disabled aria-disabled="true">${esc(t('settings.password.changeAdmin'))}</button>
          `}
        </div>
      ` : `
        <!-- Apartment user (apartment-admin OR tenant with admin grant via this view):
             change-password is for THEIR apartment, not the master admin. Identity
             registration is opt-in (recommended but not required). -->
        <div class="card" style="margin-bottom:14px">
          <h3 style="margin-top:0; font-size:15px">${esc(t('settings.password.aptTitle'))}</h3>
          <p class="muted" style="font-size:13px">${esc(t('settings.password.aptHint'))}</p>
          <button class="btn btn--primary" id="ch-pwd-tenant">${esc(t('settings.password.changeTenant'))}</button>
          ${identityStatus?.registered ? `
            <p class="muted" style="font-size:12px; margin-top:8px">${esc(t('settings.password.recoveryNote', { email: identityStatus.email }))}</p>
          ` : `
            <p class="muted" style="font-size:12px; margin-top:8px">${esc(t('settings.password.recoveryOptional'))}</p>
          `}
        </div>
      `}

      ${(session.apartmentId && session.emailEnabled) ? `
        <div class="card" id="apt-admin-email-card" style="margin-bottom:14px">
          <h3 style="margin-top:0; font-size:15px">${esc(t('settings.tenantEmail.title'))}</h3>
          <p class="muted" style="font-size:13px">${esc(t('settings.tenantEmail.hint'))}</p>
          <div id="apt-admin-email-state" class="muted" style="font-size:13px">${esc(t('common.loading'))}</div>
        </div>
      ` : ''}

      <div class="card" style="margin-bottom:14px" id="twofa-card">
        <h3 style="margin-top:0; font-size:15px">${esc(t('settings.twofa.title'))}</h3>
        <p class="muted" style="font-size:13px">${esc(t('settings.twofa.hint'))}</p>
        <div id="twofa-status" class="muted" style="font-size:13px">${esc(t('common.loading'))}</div>
        <div id="twofa-actions" style="margin-top:10px"></div>
      </div>

      <!-- Unified users card — owners as parents, their apartments (with
           renter info if rented) nested under each. Bulk-select expands all. -->
      ${(() => {
        // Build the tree shape: per-owner record + their apartments + an
        // "orphans" bucket for apartments without an apartment_owner_link.
        const aptsByOwner = new Map();
        const orphanApts = [];
        for (const a of apts) {
          if (a.ownerId && ownersList.find(o => o.id === a.ownerId)) {
            const arr = aptsByOwner.get(a.ownerId) || [];
            arr.push(a);
            aptsByOwner.set(a.ownerId, arr);
          } else {
            orphanApts.push(a);
          }
        }
        const totalRows = ownersList.length + apts.length + orphanApts.length;
        if (totalRows === 0) {
          return `
            <div class="card" style="margin-bottom:14px">
              <h3 style="margin:0 0 10px; font-size:15px">${esc(t('settings.users'))}</h3>
              <p class="muted" style="margin:0">${esc(t('settings.users.empty'))}</p>
            </div>
          `;
        }
        // Status badge helper
        const pwdBadge = (has) => has
          ? `<span class="badge badge--success">${esc(t('settings.tenantPasswords.set'))}</span>`
          : `<span class="badge badge--warning">${esc(t('settings.tenantPasswords.notSet'))}</span>`;
        // Owner row + nested RENTER rows for each owner.
        // Owner-occupied apartments contribute no sub-row — the owner row
        // already covers their login + admin grant. Only renter-occupied
        // apartments need a separate row (renter has their own password +
        // their apartment can be made admin independently).
        const ownerBlocks = ownersList.map(o => {
          const ownerApartments = (aptsByOwner.get(o.id) || [])
            .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
          const renterApts = ownerApartments.filter(a => a.occupantType === 'renter');
          const aptCount = ownerApartments.length;
          const aptList = ownerApartments.map(a => String(a.number)).join(', ');
          const expandable = renterApts.length > 0;
          const ownerAdminCell = o.isAdmin
            ? `<span class="badge badge--accent">${esc(t('settings.apartmentAdmin.yes'))}</span>`
            : `<span class="muted" style="font-size:12px">${esc(t('settings.apartmentAdmin.no'))}</span>`;
          const ownerAdminBtn = o.isAdmin
            ? `<button class="btn btn--sm" data-act="revoke-own-admin" data-id="${esc(o.id)}" data-name="${esc(o.name || '')}">${esc(t('settings.apartmentAdmin.revoke'))}</button>`
            : `<button class="btn btn--sm" data-act="grant-own-admin" data-id="${esc(o.id)}" data-name="${esc(o.name || '')}" ${!o.hasPassword ? `disabled title="${esc(t('settings.apartmentAdmin.needsPassword'))}"` : ''}>${esc(t('settings.apartmentAdmin.grant'))}</button>`;
          // Collapse the chevron button to an empty spacer when there's
          // nothing to expand — keeps the column alignment without exposing
          // a useless control.
          const chevron = expandable
            ? `<button class="btn btn--sm btn--icon users-expand" data-owner-id="${esc(o.id)}" aria-expanded="false" style="padding:2px 6px; margin-inline-end:6px">▾</button>`
            : `<span style="display:inline-block; width:32px"></span>`;
          const aptHeader = `
            <tr class="users-owner-row" data-owner-id="${esc(o.id)}">
              <td class="users-bulk-col" style="display:none"><input type="checkbox" class="users-cb" data-kind="owner" data-id="${esc(o.id)}" /></td>
              <td colspan="2">
                ${chevron}
                <span class="badge badge--success" style="font-size:10px; padding:1px 6px; margin-inline-end:6px">${esc(t('settings.users.kind.owner'))}</span>
                <strong>${esc(o.name || '—')}</strong>
                <span class="muted" style="font-size:12px; margin-inline-start:6px">${esc(t('settings.users.ownerSubtitle', { n: aptCount, list: aptList || t('settings.ownerPasswords.noApts') }))}</span>
              </td>
              <td>${pwdBadge(!!o.hasPassword)}</td>
              <td>${ownerAdminCell}</td>
              <td class="muted">${o.passwordSetAt ? fmtDate(o.passwordSetAt) : '—'}</td>
              <td class="actions">
                ${ownerAdminBtn}
                <button class="btn btn--sm" data-act="reset-own-pwd" data-id="${esc(o.id)}" data-name="${esc(o.name || '')}">${esc(t('settings.tenantPasswords.reset'))}</button>
              </td>
            </tr>
          `;
          // Only renter-occupied apartments get a sub-row. Owner-occupied
          // are absorbed into the owner row above.
          const aptRows = renterApts.map(a => {
            const adminCell = a.isAdmin
              ? `<span class="badge badge--accent">${esc(t('settings.apartmentAdmin.yes'))}</span>`
              : `<span class="muted" style="font-size:12px">${esc(t('settings.apartmentAdmin.no'))}</span>`;
            const adminBtn = a.isAdmin
              ? `<button class="btn btn--sm" data-act="revoke-admin" data-id="${esc(a.id)}" data-num="${esc(String(a.number))}">${esc(t('settings.apartmentAdmin.revoke'))}</button>`
              : `<button class="btn btn--sm" data-act="grant-admin" data-id="${esc(a.id)}" data-num="${esc(String(a.number))}" ${!a.hasPassword ? `disabled title="${esc(t('settings.apartmentAdmin.needsPassword'))}"` : ''}>${esc(t('settings.apartmentAdmin.grant'))}</button>`;
            const renterName = a.owner ? ` · ${a.owner}` : '';
            return `
              <tr class="users-apt-row" data-owner-id="${esc(o.id)}" data-apt-id="${esc(a.id)}"
                  style="display:none; background:linear-gradient(90deg, var(--c-warning-soft, #fff8eb) 0, var(--c-surface) 8px); border-inline-start:3px solid var(--c-warning, #d4a017)">
                <td class="users-bulk-col" style="display:none">
                  <input type="checkbox" class="users-cb" data-kind="apartment" data-id="${esc(a.id)}" />
                </td>
                <td style="padding-inline-start:80px; position:relative">
                  <span aria-hidden="true" style="position:absolute; inset-inline-start:36px; top:50%; width:24px; height:2px; background:var(--c-border-strong, #c8c8c8); transform:translateY(-1px)"></span>
                  <span class="badge badge--warning" style="font-size:10px; padding:1px 6px; margin-inline-end:6px">${esc(t('settings.users.kind.renter'))}</span>
                  <strong>${esc(t('settings.users.aptLabel', { number: a.number }))}</strong>
                  <span class="muted" style="font-size:12px">${esc(renterName)}</span>
                </td>
                <td class="muted" style="font-size:12px">${esc(t('settings.users.kind.renter'))}</td>
                <td>${pwdBadge(!!a.hasPassword)}</td>
                <td>${adminCell}</td>
                <td class="muted">${a.passwordSetAt ? fmtDate(a.passwordSetAt) : '—'}</td>
                <td class="actions">
                  ${adminBtn}
                  <button class="btn btn--sm" data-act="reset-apt-pwd" data-id="${esc(a.id)}" data-num="${esc(String(a.number))}">${esc(t('settings.tenantPasswords.reset'))}</button>
                </td>
              </tr>
            `;
          }).join('');
          return aptHeader + aptRows;
        }).join('');
        const orphanRows = orphanApts.map(a => {
          const isRenter = a.occupantType === 'renter';
          const residentLabel = isRenter
            ? t('settings.users.kind.renter') + (a.owner ? ` · ${a.owner}` : '')
            : t('settings.users.kind.unlinked');
          return `
            <tr>
              <td class="users-bulk-col" style="display:none"><input type="checkbox" class="users-cb" data-kind="apartment" data-id="${esc(a.id)}" /></td>
              <td><strong>${esc(t('settings.users.aptLabel', { number: a.number }))}</strong></td>
              <td class="muted" style="font-size:12px">${esc(residentLabel)}</td>
              <td>${pwdBadge(!!a.hasPassword)}</td>
              <td>${a.isAdmin ? `<span class="badge badge--accent">${esc(t('settings.apartmentAdmin.yes'))}</span>` : `<span class="muted" style="font-size:12px">${esc(t('settings.apartmentAdmin.no'))}</span>`}</td>
              <td class="muted">${a.passwordSetAt ? fmtDate(a.passwordSetAt) : '—'}</td>
              <td class="actions">
                ${a.isAdmin
                  ? `<button class="btn btn--sm" data-act="revoke-admin" data-id="${esc(a.id)}" data-num="${esc(String(a.number))}">${esc(t('settings.apartmentAdmin.revoke'))}</button>`
                  : `<button class="btn btn--sm" data-act="grant-admin" data-id="${esc(a.id)}" data-num="${esc(String(a.number))}" ${!a.hasPassword ? 'disabled title="' + esc(t('settings.apartmentAdmin.needsPassword')) + '"' : ''}>${esc(t('settings.apartmentAdmin.grant'))}</button>`}
                <button class="btn btn--sm" data-act="reset-apt-pwd" data-id="${esc(a.id)}" data-num="${esc(String(a.number))}">${esc(t('settings.tenantPasswords.reset'))}</button>
              </td>
            </tr>
          `;
        }).join('');
        return `
          <div class="card" style="margin-bottom:14px">
            <div class="hstack" style="margin-bottom:6px">
              <h3 style="margin:0; font-size:15px">${esc(t('settings.users'))}</h3>
              <div class="spacer"></div>
              <button class="btn btn--sm" id="users-bulk-toggle">${esc(t('settings.bulkPwd.toggle'))}</button>
            </div>
            <p class="muted" style="font-size:13px; margin-bottom:10px">${esc(t('settings.users.hint'))}</p>
            <div id="users-bulk-bar" class="callout" style="display:none; font-size:13px; margin-bottom:10px">
              <div class="hstack" style="gap:8px; flex-wrap:wrap">
                <span id="users-bulk-count">${esc(t('settings.bulkPwd.selected', { n: 0 }))}</span>
                <div class="spacer"></div>
                <button class="btn btn--sm" id="users-bulk-select-all">${esc(t('settings.bulkPwd.selectAll'))}</button>
                <button class="btn btn--sm" id="users-bulk-clear">${esc(t('settings.bulkPwd.clear'))}</button>
                <button class="btn btn--sm btn--primary" id="users-bulk-set" disabled>${esc(t('settings.bulkPwd.set'))}</button>
              </div>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr>
                  <th class="users-bulk-col" style="display:none; width:32px"></th>
                  <th>${esc(t('settings.users.col.name'))}</th>
                  <th>${esc(t('settings.users.col.kind'))}</th>
                  <th>${esc(t('settings.tenantPasswords.col.status'))}</th>
                  <th>${esc(t('settings.apartmentAdmin.col'))}</th>
                  <th>${esc(t('settings.tenantPasswords.col.setAt'))}</th>
                  <th class="actions"></th>
                </tr></thead>
                <tbody>
                  ${ownerBlocks}
                  ${orphanRows}
                </tbody>
              </table>
            </div>
          </div>
        `;
      })()}

      ${sectionHeader(t('settings.section.integrations'))}
      ${renderDriveCard(driveStatus)}
      ${renderEmailCard()}
      ${renderResendCard(s)}

      ${sectionHeader(t('settings.section.maintenance'))}
      <div class="card" style="margin-bottom:14px">
        <div class="hstack" style="margin-bottom:10px">
          <h3 style="margin:0; font-size:15px">${esc(t('settings.audit'))}</h3>
          <span class="badge">${audit.length}</span>
        </div>
        <p class="muted" style="font-size:12px; margin-bottom:10px">${esc(t('settings.audit.hint'))}</p>
        ${audit.length === 0 ? `<p class="muted">${esc(t('settings.audit.empty'))}</p>` : `
          <div class="table-wrap" style="max-height:380px; overflow:auto">
            <table class="table">
              <thead><tr><th>${esc(t('settings.audit.col.ts'))}</th><th>${esc(t('settings.audit.col.event'))}</th><th>${esc(t('settings.audit.col.user'))}</th><th>${esc(t('settings.audit.col.success'))}</th><th>${esc(t('settings.audit.col.ip'))}</th></tr></thead>
              <tbody>
                ${audit.slice(0, 100).map(e => `
                  <tr>
                    <td class="nowrap">${esc(fmtDateTime(e.ts))}</td>
                    <td class="muted" style="font-size:12px">${esc(t('event.' + e.event))}</td>
                    <td>${esc(e.userLabel || '—')}</td>
                    <td>${e.success ? `<span class="badge badge--success">${esc(t('settings.audit.success'))}</span>` : `<span class="badge badge--danger">${esc(t('settings.audit.failure'))}</span>`}</td>
                    <td class="muted" style="font-size:12px">${esc(e.ip || '—')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <div style="margin-top:10px"><button class="btn btn--sm" id="clear-log">${esc(t('settings.audit.clear'))}</button></div>
        `}
      </div>

      <div class="card" style="margin-bottom:14px">
        <h3 style="margin-top:0; font-size:15px">${esc(t('settings.backup'))}</h3>
        <p class="muted" style="font-size:13px">${esc(t('settings.backup.hint'))}</p>
        <button class="btn btn--primary" id="exp">${Icon.download} ${esc(t('settings.backup.export'))}</button>
      </div>

      ${sectionHeader(t('settings.section.danger'))}
      <div class="card callout--danger" style="background:var(--c-danger-soft); border:1px solid var(--c-danger); margin-bottom:14px">
        <h3 style="margin-top:0; font-size:15px; color:var(--c-danger)">${esc(t('settings.danger'))}</h3>
        <p class="muted" style="font-size:13px">${esc(t('settings.danger.hint'))}</p>
        <button class="btn btn--danger" id="reset">${esc(t('settings.danger.button'))}</button>
      </div>

    </div>
  `);

  if (isAdmin) {
    document.getElementById('basics').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      try {
        await updateSettingsBasic({
          buildingName: data.buildingName,
          buildingAddress: data.buildingAddress,
        });
        toast(t('settings.saveDone'), 'success');
        drawSettings();
      } catch (err) { toast(err.message || t('common.error'), 'danger'); }
    });

    document.getElementById('financial').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      try {
        await updateSettingsBasic({
          openingBalance: Number(data.openingBalance) || 0,
          openingBalanceDate: data.openingBalanceDate,
        });
        toast(t('settings.saveDone'), 'success');
        drawSettings();
      } catch (err) { toast(err.message || t('common.error'), 'danger'); }
    });

    // Display-decimals toggle — auto-save on change so the admin doesn't
    // need to click an extra "Save" button. refreshAll() in updateSettingsBasic
    // re-applies the flag globally via setDisplayDecimals.
    document.getElementById('display-decimals-cb')?.addEventListener('change', async (e) => {
      try {
        await updateSettingsBasic({ displayDecimals: !!e.target.checked });
        toast(t('settings.saveDone'), 'success');
        drawSettings();
      } catch (err) { toast(err.message || t('common.error'), 'danger'); }
    });

    document.getElementById('add-cnt')?.addEventListener('click', () => openCountDialog());
    document.querySelectorAll('[data-act="ed-cnt"]').forEach(b => b.addEventListener('click', () => {
      const e = (getSettings().apartmentCountHistory || []).find(x => x.id === b.dataset.id);
      if (e) openCountDialog({ id: e.id, from: e.effectiveFrom, count: e.count });
    }));
    document.querySelectorAll('[data-act="rm-cnt"]').forEach(b => b.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: t('common.delete'), message: t('common.deletePrompt'), danger: true, confirmText: t('common.delete') });
      if (!ok) return;
      try { await removeApartmentCountEntry(b.dataset.id); toast(t('contacts.deleted'), 'success'); drawSettings(); }
      catch (err) { toast(err.message || t('settings.atLeastOne'), 'warning'); }
    }));

    document.getElementById('add-fee')?.addEventListener('click', () => openFeeDialog());
    document.querySelectorAll('[data-act="ed-fee"]').forEach(b => b.addEventListener('click', () => {
      const e = (getSettings().monthlyFeeHistory || []).find(x => x.id === b.dataset.id);
      if (e) openFeeDialog({ id: e.id, from: e.effectiveFrom, amount: e.amount });
    }));
    document.querySelectorAll('[data-act="rm-fee"]').forEach(b => b.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: t('common.delete'), message: t('common.deletePrompt'), danger: true, confirmText: t('common.delete') });
      if (!ok) return;
      try { await removeMonthlyFeeEntry(b.dataset.id); toast(t('contacts.deleted'), 'success'); drawSettings(); }
      catch (err) { toast(err.message || t('settings.atLeastOne'), 'warning'); }
    }));

    document.getElementById('ch-pwd-admin')?.addEventListener('click', () => changeAdminPasswordDialog());
    document.getElementById('ch-pwd-tenant')?.addEventListener('click', () => changeTenantPasswordDialog());
    document.getElementById('id-verify')?.addEventListener('click', () => startIdentityFlow('register'));
    document.getElementById('id-replace')?.addEventListener('click', () => startIdentityFlow('replace'));
    refreshTwoFACard();
    if (session.apartmentId && session.emailEnabled) {
      // Load this card into a custom element id so it doesn't collide with the
      // tenant-only card. Reuses the same email-management UI.
      refreshTenantEmailCard(session.apartmentId, 'apt-admin-email-state');
    }
    document.getElementById('email-test-btn')?.addEventListener('click', () => openEmailTestDialog());
    document.getElementById('email-broadcast-btn')?.addEventListener('click', () => openBroadcastDialog());
    document.getElementById('email-monthly-btn')?.addEventListener('click', () => openMonthlyReportDialog());
    // Resend (admin-managed email channel) — submit, verify, resend, remove.
    document.getElementById('resend-save-btn')?.addEventListener('click', async () => {
      const apiKey = document.getElementById('resend-key-input').value.trim();
      const recipient = document.getElementById('resend-recipient-input').value.trim();
      if (!apiKey || !recipient) { toast(t('settings.resend.fillBoth'), 'warning'); return; }
      const btn = document.getElementById('resend-save-btn');
      btn.disabled = true;
      try {
        await api.resendSave(apiKey, recipient);
        toast(t('settings.resend.codeSent'), 'success');
        drawSettings();
      } catch (err) { toast(err.message || t('common.error'), 'danger'); btn.disabled = false; }
    });
    document.getElementById('resend-verify-btn')?.addEventListener('click', async () => {
      const code = document.getElementById('resend-code-input').value.trim();
      if (!/^\d{4,8}$/.test(code)) { toast(t('settings.resend.codeFormat'), 'warning'); return; }
      const btn = document.getElementById('resend-verify-btn');
      btn.disabled = true;
      try {
        await api.resendVerify(code);
        toast(t('settings.resend.verified'), 'success');
        drawSettings();
      } catch (err) { toast(err.message || t('common.error'), 'danger'); btn.disabled = false; }
    });
    document.getElementById('resend-recode-btn')?.addEventListener('click', async () => {
      try { await api.resendResendCode(); toast(t('settings.resend.codeSent'), 'success'); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    });
    document.getElementById('resend-remove-btn')?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: t('settings.resend.remove.title'), message: t('settings.resend.remove.message'), danger: true, confirmText: t('common.delete') });
      if (!ok) return;
      try { await api.resendRemove(); toast(t('settings.resend.removed'), 'success'); drawSettings(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    });
    // ----- Unified users card (owners + nested apartments) -----
    // Per-owner expand/collapse — clicking the chevron shows that owner's
    // apartments. In bulk-select mode we auto-expand everything so the admin
    // can pick any combination of owners + renters.
    const setOwnerExpanded = (ownerId, opening) => {
      const chevron = document.querySelector(`.users-expand[data-owner-id="${ownerId}"]`);
      if (chevron) {
        chevron.textContent = opening ? '▴' : '▾';
        chevron.setAttribute('aria-expanded', String(opening));
      }
      document.querySelectorAll(`tr.users-apt-row[data-owner-id="${ownerId}"]`).forEach(tr => {
        tr.style.display = opening ? '' : 'none';
      });
    };
    document.querySelectorAll('.users-expand').forEach(b => b.addEventListener('click', () => {
      const ownerId = b.dataset.ownerId;
      const isOpen = b.getAttribute('aria-expanded') === 'true';
      setOwnerExpanded(ownerId, !isOpen);
    }));

    const usersBulkToggle = document.getElementById('users-bulk-toggle');
    const usersBulkBar = document.getElementById('users-bulk-bar');
    const usersBulkSetBtn = document.getElementById('users-bulk-set');
    const usersBulkCount = document.getElementById('users-bulk-count');
    const updateUsersBulkCount = () => {
      const n = document.querySelectorAll('.users-cb:checked').length;
      if (usersBulkCount) usersBulkCount.textContent = t('settings.bulkPwd.selected', { n });
      if (usersBulkSetBtn) usersBulkSetBtn.disabled = n === 0;
    };
    usersBulkToggle?.addEventListener('click', () => {
      const visible = document.querySelector('.users-bulk-col')?.style.display === '';
      const next = !visible;
      document.querySelectorAll('.users-bulk-col').forEach(td => { td.style.display = next ? '' : 'none'; });
      if (usersBulkBar) usersBulkBar.style.display = next ? '' : 'none';
      // Bulk mode auto-expands every owner so the admin can pick from
      // anywhere. Leaving bulk mode collapses everything back.
      document.querySelectorAll('.users-expand').forEach(b => {
        const id = b.dataset.ownerId;
        setOwnerExpanded(id, next);
      });
      if (!next) document.querySelectorAll('.users-cb').forEach(cb => { cb.checked = false; });
      updateUsersBulkCount();
    });
    document.getElementById('users-bulk-select-all')?.addEventListener('click', () => {
      document.querySelectorAll('.users-cb').forEach(cb => { cb.checked = true; });
      updateUsersBulkCount();
    });
    document.getElementById('users-bulk-clear')?.addEventListener('click', () => {
      document.querySelectorAll('.users-cb').forEach(cb => { cb.checked = false; });
      updateUsersBulkCount();
    });
    document.querySelectorAll('.users-cb').forEach(cb => cb.addEventListener('change', updateUsersBulkCount));
    usersBulkSetBtn?.addEventListener('click', () => {
      const apartmentIds = [...document.querySelectorAll('.users-cb[data-kind="apartment"]:checked')].map(cb => cb.dataset.id);
      const ownerIds = [...document.querySelectorAll('.users-cb[data-kind="owner"]:checked')].map(cb => cb.dataset.id);
      const aptLabels = apartmentIds.map(id => apts.find(a => a.id === id)?.number).filter(Boolean).map(n => t('settings.users.aptLabel', { number: n }));
      const ownerLabels = ownerIds.map(id => ownersList.find(o => o.id === id)?.name).filter(Boolean);
      const summary = [...ownerLabels, ...aptLabels].join(', ');
      openBulkPasswordDialog({ apartmentIds, ownerIds, summaryLabel: summary, onDone: () => drawSettings() });
    });
    document.querySelectorAll('[data-act="reset-own-pwd"]').forEach(b => b.addEventListener('click', () => {
      const owner = ownersList.find(o => o.id === b.dataset.id);
      if (!owner) return;
      openPasswordManagerDialog({
        kind: 'owner',
        id: owner.id,
        label: t('pwMgr.subject.owner', { name: owner.name }),
        hasPassword: !!owner.hasPassword,
        passwordSetAt: owner.passwordSetAt,
        onDone: () => drawSettings(),
      });
    }));

    document.querySelectorAll('[data-act="reset-apt-pwd"]').forEach(b => b.addEventListener('click', () => {
      const apt = getApartments().find(a => a.id === b.dataset.id);
      if (!apt) return;
      // Unified password manager — admin picks: regenerate random or set
      // manually with policy validator. Replaces the old confirm-and-randomize.
      openPasswordManagerDialog({
        kind: 'apartment',
        id: apt.id,
        label: t('pwMgr.subject.aptRenter', { number: apt.number, name: apt.owner || '' }),
        hasPassword: !!apt.hasPassword,
        passwordSetAt: apt.passwordSetAt,
        onDone: () => drawSettings(),
      });
    }));
    document.querySelectorAll('[data-act="grant-admin"]').forEach(b => b.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: t('settings.apartmentAdmin.grant.title'),
        message: t('settings.apartmentAdmin.grant.message', { number: b.dataset.num }),
        confirmText: t('settings.apartmentAdmin.grant'),
      });
      if (!ok) return;
      try { await grantApartmentAdmin(b.dataset.id); toast(t('settings.apartmentAdmin.granted'), 'success'); drawSettings(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }));
    document.querySelectorAll('[data-act="revoke-admin"]').forEach(b => b.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: t('settings.apartmentAdmin.revoke.title'),
        message: t('settings.apartmentAdmin.revoke.message', { number: b.dataset.num }),
        danger: true, confirmText: t('settings.apartmentAdmin.revoke'),
      });
      if (!ok) return;
      try { await revokeApartmentAdmin(b.dataset.id); toast(t('settings.apartmentAdmin.revoked'), 'success'); drawSettings(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }));
    // Owner-admin grant / revoke — independent from apartment-admin. The
    // session derivation in functions/lib/session.js OR's both signals, so
    // an owner gets admin role if either flag is set.
    document.querySelectorAll('[data-act="grant-own-admin"]').forEach(b => b.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: t('settings.ownerAdmin.grant.title'),
        message: t('settings.ownerAdmin.grant.message', { name: b.dataset.name }),
        confirmText: t('settings.apartmentAdmin.grant'),
      });
      if (!ok) return;
      try { await grantOwnerAdmin(b.dataset.id); toast(t('settings.apartmentAdmin.granted'), 'success'); drawSettings(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }));
    document.querySelectorAll('[data-act="revoke-own-admin"]').forEach(b => b.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: t('settings.ownerAdmin.revoke.title'),
        message: t('settings.ownerAdmin.revoke.message', { name: b.dataset.name }),
        danger: true, confirmText: t('settings.apartmentAdmin.revoke'),
      });
      if (!ok) return;
      try { await revokeOwnerAdmin(b.dataset.id); toast(t('settings.apartmentAdmin.revoked'), 'success'); drawSettings(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }));
    // Drive card handlers
    document.getElementById('drive-connect')?.addEventListener('click', async () => {
      const btn = document.getElementById('drive-connect');
      btn.disabled = true;
      btn.textContent = t('drive.connecting');
      try {
        const res = await api.driveAuthInit();
        // Navigate top-level to Google's consent screen
        location.href = res.url;
      } catch (err) {
        toast(err.message || t('common.error'), 'danger');
        btn.disabled = false;
        btn.textContent = t('drive.connect');
      }
    });
    document.getElementById('drive-disconnect')?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: t('drive.disconnect.title'), message: t('drive.disconnect.message'), danger: true, confirmText: t('drive.disconnect') });
      if (!ok) return;
      try {
        await api.driveDisconnect();
        toast(t('drive.disconnected'), 'success');
        renderSettings();
      } catch (err) { toast(err.message || t('common.error'), 'danger'); }
    });

    document.getElementById('clear-log')?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: t('settings.audit.clear.title'), message: t('settings.audit.clear.message'), danger: true, confirmText: t('common.delete') });
      if (!ok) return;
      try { await clearAuditLog(); toast(t('settings.audit.cleared'), 'success'); renderSettings(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    });
    document.getElementById('reset')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: t('settings.danger.title'),
        message: t('settings.danger.message'),
        danger: true, confirmText: t('settings.danger.confirm'),
      });
      if (!ok) return;
      try { await resetAll(); toast(t('settings.danger.done'), 'success'); location.hash = ''; location.reload(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    });
  } else {
    document.getElementById('ch-tenant-pwd')?.addEventListener('click', () => changeTenantPasswordDialog());
  }

  document.getElementById('exp').addEventListener('click', async () => {
    try {
      const text = await exportJSON();
      downloadBlob(new Blob([text], { type: 'application/json' }), `vaad_snapshot_${todayISO()}.json`);
      toast(t('settings.backup.exported'), 'success');
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

function openCountDialog(entry = null) {
  const m = openModal({
    title: entry ? t('common.edit') : t('settings.aptCount.add'),
    body: `
      <form id="cnt-form" class="form-grid">
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.aptCount.col.from'))}</label>
          <input class="input" name="from" type="date" value="${esc(entry?.from || todayISO())}" required />
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.aptCount.col.count'))}</label>
          <input class="input" name="count" type="number" min="1" value="${entry?.count ?? 9}" required />
        </div>
      </form>
    `,
    footer: `<button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button><button class="btn btn--primary" data-act="ok">${esc(t('common.save'))}</button>`,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="ok"]').addEventListener('click', async () => {
    const d = Object.fromEntries(new FormData(m.bodyEl.querySelector('#cnt-form')).entries());
    if (!d.from || !d.count) { toast(t('settings.fillAll'), 'warning'); return; }
    try {
      if (entry) await updateApartmentCountEntry(entry.id, { from: d.from, count: Number(d.count) });
      else await addApartmentCountEntry({ from: d.from, count: Number(d.count) });
      m.close(); toast(t('settings.saveDone'), 'success'); drawSettings();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

function openFeeDialog(entry = null) {
  const m = openModal({
    title: entry ? t('common.edit') : t('settings.fee.add'),
    body: `
      <form id="fee-form" class="form-grid">
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.aptCount.col.from'))}</label>
          <input class="input" name="from" type="date" value="${esc(entry?.from || todayISO())}" required />
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.fee.field.amount'))}</label>
          <input class="input" name="amount" type="number" step="0.01" value="${entry?.amount ?? 280}" required />
        </div>
      </form>
    `,
    footer: `<button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button><button class="btn btn--primary" data-act="ok">${esc(t('common.save'))}</button>`,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="ok"]').addEventListener('click', async () => {
    const d = Object.fromEntries(new FormData(m.bodyEl.querySelector('#fee-form')).entries());
    if (!d.from || !d.amount) { toast(t('settings.fillAll'), 'warning'); return; }
    try {
      if (entry) await updateMonthlyFeeEntry(entry.id, { from: d.from, amount: Number(d.amount) });
      else await addMonthlyFeeEntry({ from: d.from, amount: Number(d.amount) });
      m.close(); toast(t('settings.saveDone'), 'success'); drawSettings();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

function changeAdminPasswordDialog() {
  passwordDialog(t('settings.password.dialog.admin'), async (cur, next) => {
    await changeAdminPassword(cur, next);
    toast(t('settings.password.changed'), 'success');
  });
}
function changeTenantPasswordDialog() {
  passwordDialog(t('settings.password.dialog.tenant'), async (cur, next) => {
    await changeTenantPassword(cur, next);
    toast(t('settings.password.changed'), 'success');
  });
}

function passwordDialog(title, onSubmit) {
  const m = openModal({
    title,
    body: `
      <form id="pwd-form" class="vstack">
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.password.field.current'))}</label>
          <input class="input" id="pwd-current" name="current" type="password" autocomplete="current-password" />
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.password.field.next'))}</label>
          <input class="input" id="pwd-next" name="next" type="password" autocomplete="new-password" />
          <div id="pwd-validator"></div>
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.password.field.confirm'))}</label>
          <input class="input" id="pwd-confirm" name="confirm" type="password" autocomplete="new-password" />
        </div>
      </form>
    `,
    footer: `<button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button><button class="btn btn--primary" data-act="ok" disabled>${esc(t('common.save'))}</button>`,
  });
  // Live policy validator — disables Save until all rules pass.
  const saveBtn = m.footerEl.querySelector('[data-act="ok"]');
  wireLiveValidator(
    m.bodyEl.querySelector('#pwd-next'),
    m.bodyEl.querySelector('#pwd-validator'),
    t,
    (v) => { saveBtn.disabled = !v.ok; },
  );
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  saveBtn.addEventListener('click', async () => {
    const d = Object.fromEntries(new FormData(m.bodyEl.querySelector('#pwd-form')).entries());
    if (!d.current || !d.next || !d.confirm) { toast(t('settings.fillAll'), 'warning'); return; }
    if (d.next !== d.confirm) { toast(t('login.passwordsDontMatch'), 'warning'); return; }
    if (!validatePassword(d.next).ok) { toast(t('pw.policy.failed'), 'warning'); return; }
    try { await onSubmit(d.current, d.next); m.close(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

// ----- Tenant email opt-in (slim settings) -----
// Used for both the tenant slim settings ('tenant-email-state') and the
// apartment-admin's own email card on the full settings page ('apt-admin-email-state').
async function refreshTenantEmailCard(apartmentId, stateElId = 'tenant-email-state') {
  const stateEl = document.getElementById(stateElId);
  if (!stateEl) return;
  let info;
  try { info = await api.apartmentEmail(apartmentId); }
  catch (err) { stateEl.textContent = err.message || t('common.error'); return; }

  if (info?.email) {
    setHTML(stateEl, `
      <div class="hstack" style="gap:10px; margin-bottom:10px">
        <span class="badge badge--success">${esc(t('settings.tenantEmail.subscribed'))}</span>
        <span style="direction:ltr; font-family:monospace">${esc(info.email)}</span>
      </div>
      <div class="hstack" style="gap:8px">
        <button class="btn btn--sm" id="te-change">${esc(t('settings.tenantEmail.change'))}</button>
        <button class="btn btn--sm" id="te-remove">${esc(t('settings.tenantEmail.remove'))}</button>
      </div>
    `);
    document.getElementById('te-change').addEventListener('click', () => promptTenantEmail(apartmentId, info.email, stateElId));
    document.getElementById('te-remove').addEventListener('click', async () => {
      const ok = await confirmDialog({ title: t('settings.tenantEmail.remove'), message: t('settings.tenantEmail.remove.message'), danger: true, confirmText: t('settings.tenantEmail.remove') });
      if (!ok) return;
      try { await api.removeApartmentEmail(apartmentId); toast(t('settings.tenantEmail.removed'), 'success'); refreshTenantEmailCard(apartmentId, stateElId); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    });
  } else {
    setHTML(stateEl, `
      <div style="margin-bottom:10px"><span class="badge">${esc(t('settings.tenantEmail.notSubscribed'))}</span></div>
      <button class="btn btn--primary btn--sm" id="te-add">${esc(t('settings.tenantEmail.subscribe'))}</button>
    `);
    document.getElementById('te-add').addEventListener('click', () => promptTenantEmail(apartmentId, '', stateElId));
  }
}

function promptTenantEmail(apartmentId, currentEmail = '', stateElId = 'tenant-email-state') {
  const m = openModal({
    title: t('settings.tenantEmail.dialog.title'),
    body: `
      <p style="margin-top:0; font-size:13px" class="muted">${esc(t('settings.tenantEmail.dialog.hint'))}</p>
      <form id="te-form" class="vstack">
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.tenantEmail.field.email'))}</label>
          <input class="input" name="email" type="email" required value="${esc(currentEmail)}" />
        </div>
        <label class="checkbox" style="font-size:13px">
          <input type="checkbox" name="consent" />
          <span>${esc(t('settings.tenantEmail.field.consent'))}</span>
        </label>
      </form>
    `,
    footer: `<button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button><button class="btn btn--primary" data-act="ok">${esc(t('common.save'))}</button>`,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="ok"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#te-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!data.email) { toast(t('settings.fillAll'), 'warning'); return; }
    if (!data.consent) { toast(t('login.email.consentRequired'), 'warning'); return; }
    try {
      await api.setApartmentEmail(apartmentId, data.email);
      toast(t('settings.tenantEmail.saved'), 'success');
      m.close();
      refreshTenantEmailCard(apartmentId, stateElId);
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

// ----- 2FA card -----
async function refreshTwoFACard() {
  const statusEl = document.getElementById('twofa-status');
  const actionsEl = document.getElementById('twofa-actions');
  if (!statusEl || !actionsEl) return;
  let st;
  try { st = await api.twoFAStatus(); }
  catch (err) { statusEl.textContent = err.message || t('common.error'); return; }
  if (st.enabled) {
    setHTML(statusEl, `<span class="badge badge--success">${esc(t('settings.twofa.statusOn'))}</span>`);
    setHTML(actionsEl, `<button class="btn" id="twofa-disable">${esc(t('settings.twofa.disable'))}</button>`);
    document.getElementById('twofa-disable').addEventListener('click', () => openTwoFADisableDialog());
  } else {
    setHTML(statusEl, `<span class="badge">${esc(t('settings.twofa.statusOff'))}</span>`);
    setHTML(actionsEl, `<button class="btn btn--primary" id="twofa-enable">${esc(t('settings.twofa.enable'))}</button>`);
    document.getElementById('twofa-enable').addEventListener('click', () => openTwoFASetupDialog());
  }
}

async function openTwoFASetupDialog() {
  if (!requireAdmin()) return;
  let init;
  try { init = await api.twoFASetupInit(); }
  catch (err) { toast(err.message || t('common.error'), 'danger'); return; }

  const m = openModal({
    title: t('settings.twofa.setup.title'),
    size: 'md',
    body: `
      <p style="margin-top:0">${esc(t('settings.twofa.setup.step1'))}</p>
      <ol style="padding-inline-start:20px; font-size:13px; line-height:1.7; margin:0 0 14px">
        <li>${esc(t('settings.twofa.setup.app'))}</li>
        <li>${esc(t('settings.twofa.setup.scanOrPaste'))}</li>
        <li>${esc(t('settings.twofa.setup.enterCode'))}</li>
      </ol>
      <div class="field">
        <label class="field__label">${esc(t('settings.twofa.setup.secret'))}</label>
        <input class="input" id="twofa-secret-display" value="${esc(init.secret)}" readonly style="font-family:monospace; letter-spacing:1px" />
        <div class="field__hint">${esc(t('settings.twofa.setup.secretHint'))}</div>
      </div>
      <div class="field">
        <label class="field__label">${esc(t('settings.twofa.setup.url'))}</label>
        <textarea class="textarea" rows="2" readonly style="font-family:monospace; font-size:11px">${esc(init.otpauthUrl)}</textarea>
      </div>
      <div class="field field--required">
        <label class="field__label">${esc(t('settings.twofa.setup.codeLabel'))}</label>
        <input class="input" id="twofa-verify-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456" style="font-family:monospace; letter-spacing:6px; font-size:18px; text-align:center" />
      </div>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="verify">${esc(t('settings.twofa.setup.verify'))}</button>
    `,
  });
  // Auto-select on click for easy copy of the secret/URL
  m.bodyEl.querySelectorAll('input[readonly], textarea[readonly]').forEach(el => {
    el.addEventListener('click', () => el.select());
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="verify"]').addEventListener('click', async () => {
    const code = m.bodyEl.querySelector('#twofa-verify-code').value.trim();
    if (!/^\d{6}$/.test(code)) { toast(t('settings.twofa.setup.codeInvalid'), 'warning'); return; }
    try {
      const res = await api.twoFASetupVerify({ secret: init.secret, code });
      m.close();
      showBackupCodesDialog(res.backupCodes);
      refreshTwoFACard();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

function showBackupCodesDialog(codes) {
  const m = openModal({
    title: t('settings.twofa.backup.title'),
    size: 'md',
    body: `
      <div class="callout callout--warning" style="margin-bottom:12px">${esc(t('settings.twofa.backup.warning'))}</div>
      <div style="font-family:monospace; font-size:15px; line-height:1.9; padding:14px; background:var(--c-surface-alt); border-radius:8px; text-align:center">
        ${codes.map(c => `<div>${esc(c)}</div>`).join('')}
      </div>
    `,
    footer: `<button class="btn btn--primary" data-act="close">${esc(t('settings.twofa.backup.confirm'))}</button>`,
  });
  m.footerEl.querySelector('[data-act="close"]').addEventListener('click', () => m.close());
}

function openTwoFADisableDialog() {
  if (!requireAdmin()) return;
  const m = openModal({
    title: t('settings.twofa.disable.title'),
    body: `
      <p style="margin-top:0" class="muted">${esc(t('settings.twofa.disable.hint'))}</p>
      <form id="twofa-disable-form" class="vstack">
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.password.field.current'))}</label>
          <input class="input" name="password" type="password" autocomplete="current-password" />
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.twofa.disable.codeLabel'))}</label>
          <input class="input" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" />
        </div>
      </form>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--danger" data-act="disable">${esc(t('settings.twofa.disable'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="disable"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#twofa-disable-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!data.password || !data.code) { toast(t('settings.fillAll'), 'warning'); return; }
    try {
      await api.twoFADisable({ password: data.password, code: data.code });
      toast(t('settings.twofa.disable.done'), 'success');
      m.close();
      refreshTwoFACard();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

// ----- Resend email-channel card (admin) -----
// Three states: disabled / pending (key saved, awaiting code) / enabled.
// The key itself is never shown back — only whether one is stored.
function renderResendCard(s) {
  const status = s?.ticketsEmailStatus || 'disabled';
  const recipient = s?.ticketsAdminEmail || '';
  const hasKey = !!s?.hasResendKey;
  const statusBadge = status === 'enabled'
    ? `<span class="badge badge--success">${Icon.check} ${esc(t('settings.resend.status.enabled'))}</span>`
    : status === 'pending'
      ? `<span class="badge badge--warning">${esc(t('settings.resend.status.pending'))}</span>`
      : `<span class="badge">${esc(t('settings.resend.status.disabled'))}</span>`;

  return `
    <div class="card" style="margin-bottom:14px">
      <div class="hstack" style="margin-bottom:8px; gap:8px; align-items:center; flex-wrap:wrap">
        <h3 style="margin:0; font-size:15px">${esc(t('settings.resend.title'))}</h3>
        ${statusBadge}
      </div>
      <p class="muted" style="font-size:13px; margin:0 0 14px">${esc(t('settings.resend.hint'))}</p>

      ${status === 'pending' ? `
        <div class="vstack" style="gap:8px; background:var(--c-warning-soft); padding:10px 12px; border-radius:6px; margin-bottom:14px">
          <div style="font-size:13px">${esc(t('settings.resend.pendingMessage', { email: recipient }))}</div>
          <div class="hstack" style="gap:6px; align-items:center; flex-wrap:wrap">
            <input class="input" id="resend-code-input" placeholder="${esc(t('settings.resend.codePlaceholder'))}" inputmode="numeric" pattern="\\d*" maxlength="8" style="width:140px" />
            <button class="btn btn--primary btn--sm" id="resend-verify-btn">${esc(t('settings.resend.verifyBtn'))}</button>
            <button class="btn btn--sm" id="resend-recode-btn">${esc(t('settings.resend.resendBtn'))}</button>
          </div>
        </div>
      ` : ''}

      <div class="form-grid">
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('settings.resend.field.apiKey'))}</label>
          <input class="input" id="resend-key-input" type="password" autocomplete="new-password" placeholder="${esc(hasKey ? t('settings.resend.field.apiKeyMasked') : t('settings.resend.field.apiKeyPlaceholder'))}" />
          <div class="field__hint">${esc(t('settings.resend.field.apiKeyHint'))}</div>
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('settings.resend.field.recipient'))}</label>
          <input class="input" id="resend-recipient-input" type="email" value="${esc(recipient)}" placeholder="${esc(t('settings.resend.field.recipientPlaceholder'))}" />
          <div class="field__hint">${esc(t('settings.resend.field.recipientHint'))}</div>
        </div>
        <div style="grid-column:1/-1" class="hstack" style="gap:8px; flex-wrap:wrap">
          <button class="btn btn--primary" id="resend-save-btn">${esc(hasKey ? t('settings.resend.replaceBtn') : t('settings.resend.sendCodeBtn'))}</button>
          ${hasKey ? `<button class="btn btn--danger" id="resend-remove-btn">${esc(t('settings.resend.removeBtn'))}</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

// ----- Email integration card (admin) -----
function renderEmailCard() {
  return `
    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0; font-size:15px">${esc(t('settings.email.title'))}</h3>
      <p class="muted" style="font-size:13px">${esc(t('settings.email.hint'))}</p>
      <div class="hstack" style="gap:8px; flex-wrap:wrap">
        <button class="btn" id="email-test-btn">${esc(t('settings.email.testBtn'))}</button>
        <button class="btn btn--primary" id="email-broadcast-btn">${esc(t('settings.email.broadcastBtn'))}</button>
        <button class="btn" id="email-monthly-btn">${esc(t('settings.email.monthlyBtn'))}</button>
      </div>
    </div>
  `;
}

function openEmailTestDialog() {
  const m = openModal({
    title: t('settings.email.test.title'),
    body: `
      <p style="margin-top:0; font-size:13px" class="muted">${esc(t('settings.email.test.hint'))}</p>
      <form id="etest-form" class="vstack">
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.email.test.to'))}</label>
          <input class="input" name="to" type="email" required placeholder="you@example.com" />
        </div>
      </form>
    `,
    footer: `<button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button><button class="btn btn--primary" data-act="send">${esc(t('settings.email.test.send'))}</button>`,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="send"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#etest-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!data.to) { toast(t('settings.fillAll'), 'warning'); return; }
    try { await api.emailTest(data.to); toast(t('settings.email.test.sent'), 'success'); m.close(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

function openBroadcastDialog() {
  const m = openModal({
    title: t('settings.email.broadcast.title'),
    size: 'md',
    body: `
      <p style="margin-top:0; font-size:13px" class="muted">${esc(t('settings.email.broadcast.hint'))}</p>
      <form id="ebroadcast-form" class="vstack">
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.email.broadcast.subject'))}</label>
          <input class="input" name="subject" required maxlength="200" />
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.email.broadcast.message'))}</label>
          <textarea class="textarea" name="message" rows="8" required maxlength="5000"></textarea>
        </div>
      </form>
    `,
    footer: `<button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button><button class="btn btn--primary" data-act="send">${esc(t('settings.email.broadcast.send'))}</button>`,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="send"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#ebroadcast-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!data.subject || !data.message) { toast(t('settings.fillAll'), 'warning'); return; }
    const ok = await confirmDialog({ title: t('settings.email.broadcast.confirm.title'), message: t('settings.email.broadcast.confirm.message'), confirmText: t('settings.email.broadcast.send') });
    if (!ok) return;
    try { const res = await api.emailBroadcast(data.subject, data.message); toast(t('settings.email.broadcast.sent', { n: res.sent }), 'success'); m.close(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

function openMonthlyReportDialog() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const defaultYear = prev.getFullYear();
  const defaultMonth = prev.getMonth() + 1;
  const m = openModal({
    title: t('settings.email.monthly.title'),
    body: `
      <p style="margin-top:0; font-size:13px" class="muted">${esc(t('settings.email.monthly.hint'))}</p>
      <form id="emr-form" class="form-grid">
        <div class="field">
          <label class="field__label">${esc(t('common.year'))}</label>
          <input class="input" name="year" type="number" min="2020" max="2100" value="${defaultYear}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('common.month'))}</label>
          <select class="select" name="month">
            ${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === defaultMonth ? 'selected' : ''}>${i + 1}</option>`).join('')}
          </select>
        </div>
      </form>
    `,
    footer: `<button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button><button class="btn btn--primary" data-act="send">${esc(t('settings.email.monthly.send'))}</button>`,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="send"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#emr-form');
    const data = Object.fromEntries(new FormData(f).entries());
    const ok = await confirmDialog({
      title: t('settings.email.monthly.confirm.title'),
      message: t('settings.email.monthly.confirm.message'),
      confirmText: t('settings.email.monthly.send'),
    });
    if (!ok) return;
    try {
      const res = await api.sendMonthlyReport(Number(data.year), Number(data.month));
      toast(t('settings.email.monthly.sent', { n: res.sent }), 'success');
      m.close();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

function renderDriveCard(status) {
  if (!status) {
    return `
      <div class="card" style="margin-bottom:18px">
        <h3 style="margin-top:0">${esc(t('drive.title'))}</h3>
        <p class="muted" style="font-size:13px">${esc(t('drive.subtitle'))}</p>
        <div class="callout callout--warning">${esc(t('drive.notConfigured'))}</div>
      </div>`;
  }
  if (!status.configured) {
    return `
      <div class="card" style="margin-bottom:18px">
        <h3 style="margin-top:0">${esc(t('drive.title'))}</h3>
        <p class="muted" style="font-size:13px">${esc(t('drive.subtitle'))}</p>
        <div class="callout callout--warning">${esc(t('drive.notConfigured'))}</div>
      </div>`;
  }
  if (!status.connected) {
    return `
      <div class="card" style="margin-bottom:18px">
        <h3 style="margin-top:0">${esc(t('drive.title'))}</h3>
        <p class="muted" style="font-size:13px">${esc(t('drive.subtitle'))}</p>
        <div class="callout">${esc(t('drive.notConnectedHint'))}</div>
        <button class="btn btn--primary" id="drive-connect">
          <svg width="16" height="16" viewBox="0 0 24 24" style="display:inline-block;vertical-align:-3px;margin-inline-end:6px">
            <path d="M7.71 3.5l-7.07 12.24h7.07L14.78 3.5z" fill="#1f7a52"/>
            <path d="M16.29 3.5L9.22 15.74h7.07l7.07-12.24z" fill="#c8a96a"/>
            <path d="M0.64 15.74L4.18 21.85h14.07l-3.54-6.11z" fill="#1e5b9c"/>
          </svg>
          ${esc(t('drive.connect'))}
        </button>
      </div>`;
  }
  return `
    <div class="card" style="margin-bottom:18px">
      <div class="hstack" style="margin-bottom:8px">
        <h3 style="margin:0">${esc(t('drive.title'))}</h3>
        <span class="badge badge--success">${esc(t('drive.connected'))}</span>
      </div>
      <div class="vstack" style="font-size:13px; gap:6px; margin-bottom:14px">
        ${status.accountEmail ? `<div>${esc(t('drive.connectedAs', { email: status.accountEmail }))}</div>` : ''}
        <div class="muted">${esc(t('drive.folder', { name: t('drive.folderDefault') }))}</div>
        ${status.connectedAt ? `<div class="muted">${esc(t('drive.connectedAt', { date: fmtDate(status.connectedAt) }))}</div>` : ''}
      </div>
      <button class="btn" id="drive-disconnect">${esc(t('drive.disconnect'))}</button>
    </div>`;
}

// ---------- Identity (recovery email) card ----------
// Shows the verified Google email used for password recovery. The admin
// completes a Google OAuth flow to register or replace the email — Google
// performs the verification, no email is sent.
function renderIdentityCard(status) {
  if (!status?.registered) {
    return `
      <div class="card" style="margin-bottom:14px">
        <h3 style="margin-top:0; font-size:15px">${esc(t('settings.identity.title'))}</h3>
        <p class="muted" style="font-size:13px">${esc(t('settings.identity.subtitle'))}</p>
        <div class="callout callout--warning" style="margin-bottom:12px">
          <div>${esc(t('settings.identity.notRegistered'))}</div>
        </div>
        <button class="btn btn--primary" id="id-verify">
          <svg width="16" height="16" viewBox="0 0 48 48" style="display:inline-block;vertical-align:-3px;margin-inline-end:6px">
            <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.7 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.3 0-9.7-3.4-11.3-8l-6.6 5C9.6 39.6 16.2 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.2 5.2c-.4.4 6.6-4.8 6.6-14.7 0-1.3-.1-2.6-.4-3.9z"/>
          </svg>
          ${esc(t('settings.identity.verify'))}
        </button>
      </div>`;
  }
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="hstack" style="margin-bottom:8px">
        <h3 style="margin:0; font-size:15px">${esc(t('settings.identity.title'))}</h3>
        <span class="badge badge--success">${esc(t('settings.identity.verified'))}</span>
      </div>
      <p class="muted" style="font-size:13px">${esc(t('settings.identity.subtitle'))}</p>
      <div class="vstack" style="font-size:13px; gap:6px; margin-bottom:14px">
        <div>${esc(t('settings.identity.currentEmail', { email: status.email }))}</div>
        ${status.verifiedAt ? `<div class="muted">${esc(t('settings.identity.verifiedAt', { date: fmtDateTime(status.verifiedAt) }))}</div>` : ''}
      </div>
      <button class="btn" id="id-replace">${esc(t('settings.identity.replace'))}</button>
    </div>`;
}

async function startIdentityFlow(purpose) {
  const titleKey = purpose === 'replace' ? 'settings.identity.replace.confirm.title' : 'settings.identity.verify.confirm.title';
  const messageKey = purpose === 'replace' ? 'settings.identity.replace.confirm.message' : 'settings.identity.verify.confirm.message';
  const ok = await confirmDialog({
    title: t(titleKey),
    message: t(messageKey),
    confirmText: t('settings.identity.continueToGoogle'),
  });
  if (!ok) return;
  try {
    const res = await api.identityInit(purpose);
    location.href = res.url;
  } catch (err) {
    toast(err.message || t('common.error'), 'danger');
  }
}



// Bulk password set dialog — input one password (with policy validator),
// applied to the apartments selected via checkboxes. The same password is
// stashed encrypted per apartment so the admin can re-display it later.
function openBulkPasswordDialog(opts) {
  // Accepts the new options shape { apartmentIds, ownerIds, summaryLabel,
  // onDone }. Backwards-compatible with the old positional call signature
  // (apartmentIds, summaryLabel, onDone) — auto-detected when arg #1 is an
  // array.
  let apartmentIds, ownerIds, summaryLabel, onDone;
  if (Array.isArray(opts)) {
    apartmentIds = opts;
    summaryLabel = arguments[1];
    onDone = arguments[2];
    ownerIds = [];
  } else {
    apartmentIds = opts?.apartmentIds || [];
    ownerIds = opts?.ownerIds || [];
    summaryLabel = opts?.summaryLabel || '';
    onDone = opts?.onDone;
  }
  if (!requireAdmin()) return;
  const totalCount = apartmentIds.length + ownerIds.length;
  const m = openModal({
    title: t('settings.bulkPwd.dialog.title', { n: totalCount }),
    size: 'md',
    body: `
      <div class="callout" style="font-size:13px; margin-bottom:12px">
        ${esc(t('settings.bulkPwd.dialog.intro', { list: summaryLabel }))}
      </div>
      <form id="bulk-pwd-form" class="vstack">
        <div class="field field--required">
          <label class="field__label">${esc(t('settings.bulkPwd.dialog.field'))}</label>
          <input class="input" id="bulk-pwd-input" type="text" autocomplete="new-password" placeholder="********" />
          <div id="bulk-pwd-validator"></div>
        </div>
      </form>
      <div class="muted" style="font-size:12px; margin-top:8px">${esc(t('settings.bulkPwd.dialog.hint'))}</div>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save" disabled>${esc(t('settings.bulkPwd.dialog.save'))}</button>
    `,
  });
  const saveBtn = m.footerEl.querySelector('[data-act="save"]');
  wireLiveValidator(
    m.bodyEl.querySelector('#bulk-pwd-input'),
    m.bodyEl.querySelector('#bulk-pwd-validator'),
    t,
    (v) => { saveBtn.disabled = !v.ok; },
  );
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    const pwd = m.bodyEl.querySelector('#bulk-pwd-input').value || '';
    if (!validatePassword(pwd).ok) { toast(t('pw.policy.failed'), 'warning'); return; }
    saveBtn.disabled = true;
    try {
      const res = await api.bulkResetApartmentPasswords(apartmentIds, pwd, ownerIds);
      // The endpoint resets renter passwords AND any first-class owner
      // passwords (both directly-picked and linked to selected apartments).
      // Toast mentions both counts so the admin knows both login flows are
      // usable now.
      const msgKey = res.ownerCount > 0 ? 'settings.bulkPwd.doneWithOwners' : 'settings.bulkPwd.done';
      toast(t(msgKey, { n: res.count, owners: res.ownerCount || 0 }), 'success');
      m.close();
      onDone && onDone();
    } catch (err) {
      toast(err.message || t('common.error'), 'danger');
      saveBtn.disabled = false;
    }
  });
}
