// Shared UI: modal, toast, confirm, app shell + language switch

import { esc, fmtDate } from './utils.js';
import { getSession, logout, acknowledgeReminder, getExpenses, getReminders } from './store.js';
import { activeReminders } from './calc.js';
import { t, getLanguage, setLanguage } from './i18n.js';

// Helper for rendering: wraps the standard DOM API. All dynamic data must be
// escaped at the call site via esc(). This centralizes the call so it is easy
// to swap to a sanitizer if the threat model changes.
export const setHTML = (el, str) => { el.innerHTML = str; };
export const appendHTML = (el, str) => { el.insertAdjacentHTML('beforeend', str); };

// ----- Toast -----
let toastSeq = 0;
export function toast(message, kind = 'info', timeout = 2400) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const id = `toast-${++toastSeq}`;
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.id = id;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 280);
  }, timeout);
}

// ----- Modal -----
export function openModal({ title, body, footer, size = 'md', onClose }) {
  const root = document.getElementById('modal-root');
  if (!root) return null;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  setHTML(backdrop, `
    <div class="modal modal--${size}" role="dialog" aria-modal="true" aria-label="${esc(title || 'חלון')}">
      <header class="modal__header">
        <h3 class="modal__title">${esc(title || '')}</h3>
        <button class="modal__close" type="button" aria-label="סגירה">✕</button>
      </header>
      <div class="modal__body"></div>
      ${footer === false ? '' : '<div class="modal__footer"></div>'}
    </div>
  `);
  const modalEl = backdrop.querySelector('.modal');
  const bodyEl = backdrop.querySelector('.modal__body');
  const footerEl = backdrop.querySelector('.modal__footer');
  const closeBtn = backdrop.querySelector('.modal__close');

  if (typeof body === 'string') setHTML(bodyEl, body);
  else if (body instanceof Node) bodyEl.appendChild(body);

  if (footerEl && footer) {
    if (typeof footer === 'string') setHTML(footerEl, footer);
    else if (footer instanceof Node) footerEl.appendChild(footer);
  }

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);

  root.appendChild(backdrop);
  setTimeout(() => {
    const focusable = modalEl.querySelector('input, select, textarea, button:not(.modal__close)');
    focusable?.focus();
  }, 30);

  return { close, modalEl, bodyEl, footerEl };
}

export function confirmDialog({ title, message, confirmText, cancelText, danger = false } = {}) {
  const ttl = title || t('common.confirm');
  const okTxt = confirmText || t('common.ok');
  const cancelTxt = cancelText || t('common.cancel');
  return new Promise((resolve) => {
    const m = openModal({
      title: ttl,
      body: `<p style="margin:0">${esc(message)}</p>`,
      footer: `
        <button class="btn" data-act="cancel">${esc(cancelTxt)}</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-act="ok">${esc(okTxt)}</button>
      `,
    });
    if (!m) return resolve(false);
    m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => { m.close(); resolve(false); });
    m.footerEl.querySelector('[data-act="ok"]').addEventListener('click', () => { m.close(); resolve(true); });
  });
}

export function promptDialog({ title = 'הזנה', message = '', placeholder = '', defaultValue = '', type = 'text', okText = 'אישור' } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: `
        ${message ? `<p style="margin-top:0">${esc(message)}</p>` : ''}
        <div class="field">
          <input class="input" type="${esc(type)}" value="${esc(defaultValue)}" placeholder="${esc(placeholder)}" />
        </div>
      `,
      footer: `
        <button class="btn" data-act="cancel">ביטול</button>
        <button class="btn btn--primary" data-act="ok">${esc(okText)}</button>
      `,
    });
    if (!m) return resolve(null);
    const input = m.bodyEl.querySelector('input');
    setTimeout(() => input?.focus(), 50);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { m.close(); resolve(input.value); } });
    m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => { m.close(); resolve(null); });
    m.footerEl.querySelector('[data-act="ok"]').addEventListener('click', () => { m.close(); resolve(input.value); });
  });
}

// ----- Icons (inline SVGs) -----
export const Icon = {
  dashboard: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
  apartments: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21V8l9-5 9 5v13"/><path d="M9 21V12h6v9"/></svg>',
  income: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M5 9l7-7 7 7"/></svg>',
  expenses: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22V2M5 15l7 7 7-7"/></svg>',
  reports: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6M9 9h2"/></svg>',
  contacts: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  documents: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  settings: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  logout: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline-block;vertical-align:-3px"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  print: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
  document: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:-2px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline-block;vertical-align:-2px"><polyline points="20 6 9 17 4 12"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline-block;vertical-align:-2px"><path d="M12 2L2 22h20L12 2z"/><path d="M12 9v5M12 18h.01"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:-2px"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  reminders: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  about: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  tickets: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v4a2 2 0 0 1 0 4v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4a2 2 0 0 1 0-4z"/><path d="M9 7v10"/></svg>',
  camera: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:-3px"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
};

export function renderShell(currentRoute) {
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const lang = getLanguage();

  // Tenants get a read-only view of the building's finances: dashboard,
  // income, expenses, reports (download), about (committee + bank info),
  // and settings (password change). Apartment management, contacts,
  // document library and reminders stay admin-only. They can still see
  // documents *linked to* expenses/payments through the detail dialogs.
  const allNavItems = [
    { id: 'dashboard',     icon: Icon.dashboard,  tenant: true  },
    { id: 'apartments',    icon: Icon.apartments, tenant: false },
    { id: 'owners',        icon: Icon.contacts,   tenant: false },
    { id: 'income',        icon: Icon.income,     tenant: true  },
    { id: 'expenses',      icon: Icon.expenses,   tenant: true  },
    { id: 'infrastructure', icon: Icon.expenses,  tenant: true  },
    { id: 'contacts',      icon: Icon.contacts,   tenant: false },
    { id: 'documents',     icon: Icon.documents,  tenant: false },
    { id: 'reminders',     icon: Icon.reminders,  tenant: false },
    { id: 'tickets',       icon: Icon.tickets,    tenant: true  },
    { id: 'reports',       icon: Icon.reports,    tenant: true  },
    { id: 'about',         icon: Icon.about,      tenant: true  },
    { id: 'settings',      icon: Icon.settings,   tenant: true  },
  ];
  const navItems = allNavItems.filter(it => isAdmin || it.tenant);

  return `
    <div class="app-shell" id="app-shell">
      <header class="app-header">
        <div class="hstack" style="gap:16px">
          <button class="menu-toggle" id="menu-toggle" aria-label="${esc(t('menu.open'))}">${Icon.menu}</button>
          <div class="app-header__brand">
            <div class="app-header__brand-mark">${esc(t('app.brand.short'))}</div>
            <div>
              ${esc(t('app.title'))}
              <span class="app-header__brand-sub">${esc(t('app.subtitle'))}</span>
            </div>
          </div>
        </div>
        <div class="app-header__actions" style="gap:10px">
          ${langToggleHTML(lang)}
          ${isAdmin ? reminderBellHTML() : ''}
          ${renderUserChip(session)}
          <button class="btn btn--sm btn--ghost" id="logout-btn" title="${esc(t('logout'))}" aria-label="${esc(t('logout'))}" style="display:inline-flex; align-items:center; gap:6px">
            ${Icon.logout || ''}
            <span class="hide-on-narrow">${esc(t('logout'))}</span>
          </button>
        </div>
      </header>

      <aside class="app-sidebar" id="app-sidebar">
        <nav class="nav">
          <div class="nav__group-title">${esc(t('nav.menu'))}</div>
          ${navItems.map(it => `
            <button class="nav__item ${it.id === currentRoute ? 'nav__item--active' : ''}" data-route="${it.id}">
              ${it.icon}
              <span>${esc(t('nav.' + it.id))}</span>
            </button>
          `).join('')}
        </nav>
      </aside>

      <main class="app-main" id="app-main"></main>
      <div class="scrim" id="scrim"></div>
    </div>
  `;
}

// ----- User chip (top-bar) -----
// Renders the signed-in identity as a single rounded chip:
//   [avatar circle]  Display name        · role tag
// The avatar carries a single Hebrew letter derived from the userLabel; its
// color reflects the role (gold for admin, success-green for owner, neutral
// for renter). Display name and role tag are derived from the session shape:
//   - Master admin   → "מנהל"  + admin
//   - Owner-occupied → owner name + (owner / owner-admin)
//   - Renter         → "דירה N" + (renter / renter-admin)
function renderUserChip(session) {
  const isAdmin = session.role === 'admin';
  const isOwnerSession = !!session.ownerId;
  const isApartmentSession = !!session.apartmentId;
  const isMasterAdmin = isAdmin && !isOwnerSession && !isApartmentSession;
  // Derive the role tag (separate from the kind of login).
  let roleKey = 'role.tenant';
  if (isMasterAdmin) roleKey = 'role.admin';
  else if (isOwnerSession) roleKey = isAdmin ? 'role.ownerAdmin' : 'role.owner';
  else if (isApartmentSession) roleKey = isAdmin ? 'role.apartmentAdmin' : 'role.renter';
  // Derive a clean display name. The userLabel often contains parenthetical
  // suffixes like "(בעלים)" or "(מנהל)" that duplicate the role tag — strip
  // those for the chip, and keep the role tag as the single source of role.
  const rawLabel = session.userLabel || '';
  const cleanName = rawLabel.replace(/\s*\([^)]*\)\s*$/, '').trim() || rawLabel || '—';
  // Avatar tone — gold for any admin, green for owner-only, neutral for renter
  const tone = isAdmin ? 'admin' : (isOwnerSession ? 'owner' : 'renter');
  const initial = (cleanName[0] || '?').toUpperCase();
  const tooltip = t('app.loggedInAs', { label: rawLabel });
  return `
    <div class="user-chip user-chip--${tone}" title="${esc(tooltip)}"
         style="display:inline-flex; align-items:center; gap:8px; padding:4px 10px 4px 4px; border:1px solid var(--c-border); border-radius:999px; background:var(--c-surface); transition:background 0.15s">
      <span aria-hidden="true"
            style="width:30px; height:30px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; color:#fff; background:${tone === 'admin' ? 'var(--c-warning, #c89221)' : tone === 'owner' ? 'var(--c-success, #1f7a52)' : 'var(--c-text-muted, #6b7280)'}">${esc(initial)}</span>
      <span style="display:inline-flex; flex-direction:column; line-height:1.15; max-width:170px">
        <span style="font-weight:600; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(cleanName)}</span>
        <span style="font-size:11px; color:var(--c-text-muted, #6b7280); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(t(roleKey))}</span>
      </span>
    </div>
  `;
}

// ----- Reminder bell -----
// The bell lives in app-header. Renders as a button + optional badge.
// On click opens a small dropdown panel listing the active reminders.
function reminderBellHTML() {
  const active = activeReminders();
  const count = active.length;
  return `
    <div class="bell-wrap" id="bell-wrap" style="position:relative">
      <button class="btn btn--sm btn--ghost btn--icon" id="bell-btn" title="${esc(t('reminders.bell.openLabel'))}" aria-label="${esc(t('reminders.bell.openLabel'))}">
        ${Icon.bell}
        ${count > 0 ? `<span class="bell-badge">${count}</span>` : ''}
      </button>
    </div>
  `;
}

// Renders the bell dropdown panel under the bell button. All dynamic strings
// pass through esc() — same pattern used throughout this file.
function openBellPanel(navigate) {
  const wrap = document.getElementById('bell-wrap');
  if (!wrap) return;
  const existing = document.getElementById('bell-panel');
  if (existing) { existing.remove(); return; }

  const active = activeReminders();
  const expById = new Map(getExpenses().map(e => [e.id, e]));

  const panel = document.createElement('div');
  panel.id = 'bell-panel';
  panel.className = 'bell-panel';
  setHTML(panel, `
    <div class="bell-panel__header">
      <strong>${esc(t('reminders.bell.title'))}</strong>
      <span class="muted" style="font-size:12px">${active.length}</span>
    </div>
    <div class="bell-panel__list">
      ${active.length === 0 ? `<div class="muted" style="padding:14px; text-align:center">${esc(t('reminders.bell.empty'))}</div>` : active.slice(0, 5).map(r => {
        const exp = r.expenseId ? expById.get(r.expenseId) : null;
        return `
          <div class="bell-panel__item">
            <div style="flex:1; min-width:0">
              <div style="font-weight:600">${esc(r.title)}</div>
              <div class="muted" style="font-size:12px">${esc(fmtDate(r.dueDate))}${exp ? ` · ${esc(exp.name)}` : ''}</div>
            </div>
            <button class="btn btn--sm btn--accent" data-act="bell-ack" data-id="${esc(r.id)}">${Icon.check}</button>
          </div>
        `;
      }).join('')}
    </div>
    <div class="bell-panel__footer">
      <button class="btn btn--sm btn--ghost" id="bell-view-all">${esc(t('reminders.bell.viewAll'))}</button>
    </div>
  `);
  wrap.appendChild(panel);

  panel.querySelectorAll('[data-act="bell-ack"]').forEach(b => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const id = b.dataset.id;
    b.disabled = true;
    try {
      await acknowledgeReminder(id);
      panel.remove();
      refreshBell();
      if (location.hash === '#reminders') {
        const mod = await import('./views/reminders.js');
        mod.renderReminders();
      }
    } catch (err) { toast(err.message || t('common.error'), 'danger'); b.disabled = false; }
  }));
  panel.querySelector('#bell-view-all')?.addEventListener('click', () => {
    panel.remove();
    if (typeof navigate === 'function') navigate('reminders');
    else location.hash = 'reminders';
  });

  // Close on outside click
  setTimeout(() => {
    const close = (ev) => {
      if (!panel.contains(ev.target) && !document.getElementById('bell-btn')?.contains(ev.target)) {
        panel.remove();
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}

// Re-render only the bell button (count update) without re-rendering whole shell.
export function refreshBell() {
  const wrap = document.getElementById('bell-wrap');
  if (!wrap || !wrap.parentElement) return;
  // Replace the wrap's inner content (badge count). We rebuild the markup
  // and reinstall the click handler.
  const active = activeReminders();
  const count = active.length;
  setHTML(wrap, `
    <button class="btn btn--sm btn--ghost btn--icon" id="bell-btn" title="${esc(t('reminders.bell.openLabel'))}" aria-label="${esc(t('reminders.bell.openLabel'))}">
      ${Icon.bell}
      ${count > 0 ? `<span class="bell-badge">${count}</span>` : ''}
    </button>
  `);
  document.getElementById('bell-btn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openBellPanel();
  });
}

// Login modal — shown once per session if there are active reminders.
// Tenants don't manage reminders, so this is admin-only.
let loginModalShownThisSession = false;
export function maybeShowLoginRemindersModal(navigate) {
  if (loginModalShownThisSession) return;
  if (getSession().role !== 'admin') return;
  const active = activeReminders();
  if (active.length === 0) return;
  loginModalShownThisSession = true;

  const expById = new Map(getExpenses().map(e => [e.id, e]));
  const titleKey = active.length === 1 ? 'reminders.loginModal.title.single' : 'reminders.loginModal.title';
  const m = openModal({
    title: t(titleKey, { n: active.length }),
    size: 'md',
    body: `
      <div class="vstack" style="gap:8px; max-height:400px; overflow:auto">
        ${active.map(r => {
          const exp = r.expenseId ? expById.get(r.expenseId) : null;
          return `
            <label class="hstack" style="gap:10px; padding:10px 12px; border:1px solid var(--c-border); border-radius:8px; cursor:pointer">
              <input type="checkbox" data-rem-id="${esc(r.id)}" checked />
              <div style="flex:1; min-width:0">
                <div style="font-weight:600">${esc(r.title)}</div>
                <div class="muted" style="font-size:12px">${esc(fmtDate(r.dueDate))}${exp ? ` · ${esc(exp.name)}` : ''}</div>
                ${r.note ? `<div class="muted" style="font-size:12px; margin-top:4px">${esc(r.note)}</div>` : ''}
              </div>
            </label>
          `;
        }).join('')}
      </div>
    `,
    footer: `
      <button class="btn" data-act="dismiss">${esc(t('reminders.loginModal.dismiss'))}</button>
      <button class="btn btn--primary" data-act="ack-selected">${Icon.check} ${esc(t('reminders.loginModal.acknowledge'))}</button>
    `,
  });
  if (!m) return;
  m.footerEl.querySelector('[data-act="dismiss"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="ack-selected"]').addEventListener('click', async () => {
    const ids = Array.from(m.bodyEl.querySelectorAll('input[data-rem-id]:checked')).map(el => el.dataset.remId);
    try {
      for (const id of ids) await acknowledgeReminder(id);
      m.close();
      refreshBell();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

function langToggleHTML(lang) {
  return `
    <div class="segmented" id="lang-toggle" style="padding:2px">
      <button class="segmented__opt ${lang === 'he' ? 'segmented__opt--active' : ''}" data-lang="he" style="padding:4px 10px; font-size:12px">עברית</button>
      <button class="segmented__opt ${lang === 'en' ? 'segmented__opt--active' : ''}" data-lang="en" style="padding:4px 10px; font-size:12px">EN</button>
    </div>
  `;
}

export function attachShellHandlers(navigate) {
  document.querySelectorAll('[data-route]').forEach(b => {
    b.addEventListener('click', () => navigate(b.dataset.route));
  });
  document.getElementById('bell-btn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openBellPanel(navigate);
  });
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try { await logout(); } catch (e) { /* ignore */ }
    location.hash = '';
    location.reload();
  });
  // Language toggle
  document.querySelectorAll('#lang-toggle [data-lang]').forEach(b => b.addEventListener('click', () => {
    setLanguage(b.dataset.lang);
    location.reload();
  }));
  const sidebar = document.getElementById('app-sidebar');
  const scrim = document.getElementById('scrim');
  document.getElementById('menu-toggle')?.addEventListener('click', () => {
    sidebar.classList.toggle('app-sidebar--open');
    scrim.classList.toggle('scrim--show');
  });
  scrim?.addEventListener('click', () => {
    sidebar.classList.remove('app-sidebar--open');
    scrim.classList.remove('scrim--show');
  });
}

export function renderPageHeader({ title, subtitle, actions = '' }) {
  return `
    <div class="page-header">
      <div>
        <h1 class="page-header__title">${esc(title)}</h1>
        ${subtitle ? `<p class="page-header__subtitle">${esc(subtitle)}</p>` : ''}
      </div>
      <div class="page-header__actions">${actions}</div>
    </div>
  `;
}

export function renderEmpty({ title, hint, action = '' }) {
  return `
    <div class="empty">
      <div class="empty__icon">${Icon.document}</div>
      <div class="empty__title">${esc(title)}</div>
      ${hint ? `<div>${esc(hint)}</div>` : ''}
      ${action ? `<div style="margin-top:14px">${action}</div>` : ''}
    </div>
  `;
}

export function requireAdmin() {
  const session = getSession();
  if (session.role !== 'admin') {
    toast(t('common.unauthorized'), 'warning');
    return false;
  }
  return true;
}
