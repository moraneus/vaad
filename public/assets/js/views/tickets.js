// Tickets / building-issue reports.
// Any logged-in role can open a ticket and post comments; only admins close,
// reopen, link/create an expense, or delete.

import {
  getTickets, getSession, getExpenses, getDocuments,
  createTicket, updateTicket, closeTicket, reopenTicket,
  linkTicketExpense, deleteTicket, addTicketComment, deleteTicketComment,
  uploadDocument, detachDocument,
  refreshAll,
} from '../store.js';
import { api } from '../api.js';
import { esc, fmtDate, todayISO, downloadBlob } from '../utils.js';
import { t } from '../i18n.js';
import { setHTML, renderPageHeader, renderEmpty, openModal, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';
import { openExpenseDialog } from './expenses.js';

const CATEGORIES = ['electricity', 'plumbing', 'sewage', 'elevator', 'cleaning',
                    'garden', 'parking', 'security', 'intercom', 'renovation', 'other'];

let filterCategory = 'all';
let filterStatus = 'open';
let searchTerm = '';
let filterFrom = null;
let filterTo = null;
// Which ticket rows are currently expanded (preserved across re-renders).
const expandedTickets = new Set();

export function renderTickets() {
  const main = document.getElementById('app-main');
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const all = getTickets() || [];
  if (filterFrom === null && filterTo === null) {
    const y = new Date().getFullYear();
    filterFrom = `${y}-01-01`;
    filterTo = `${y}-12-31`;
  }

  const inRange = (iso) => {
    if (!iso) return false;
    const ti = new Date(iso).getTime();
    const fT = filterFrom ? new Date(filterFrom).getTime() : -Infinity;
    const tT = filterTo ? new Date(filterTo + 'T23:59:59').getTime() : Infinity;
    return ti >= fT && ti <= tT;
  };
  const filtered = all.filter(tk => {
    if (filterStatus !== 'all' && tk.status !== filterStatus) return false;
    if (filterCategory !== 'all' && tk.category !== filterCategory) return false;
    if (!inRange(tk.openedAt)) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const hay = `${tk.title || ''} ${tk.description || ''} ${tk.customCategory || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  setHTML(main, `
    ${renderPageHeader({
      title: t('tickets.title'),
      subtitle: t('tickets.subtitle', { count: all.length }),
      actions: `<button class="btn btn--primary" id="add-tk">${Icon.plus} ${esc(t('tickets.add'))}</button>`,
    })}

    <div class="toolbar">
      <input class="input" id="tk-search" placeholder="${esc(t('tickets.searchPlaceholder'))}" value="${esc(searchTerm)}" style="width:220px" />
      <select class="select" id="tk-cat" style="width:180px">
        <option value="all">${esc(t('tickets.cat.all'))}</option>
        ${CATEGORIES.map(c => `<option value="${c}" ${filterCategory===c?'selected':''}>${esc(t('tickets.cat.' + c))}</option>`).join('')}
      </select>
      <select class="select" id="tk-status" style="width:140px">
        <option value="all" ${filterStatus==='all'?'selected':''}>${esc(t('tickets.status.all'))}</option>
        <option value="open" ${filterStatus==='open'?'selected':''}>${esc(t('tickets.status.open'))}</option>
        <option value="closed" ${filterStatus==='closed'?'selected':''}>${esc(t('tickets.status.closed'))}</option>
      </select>
      <div class="spacer"></div>
      <div class="muted">${filtered.length}</div>
    </div>

    <div class="toolbar" style="margin-top:-6px; gap:6px; flex-wrap:nowrap; overflow-x:auto">
      <select class="select" id="tk-preset" style="width:auto">
        <option value="custom">${esc(t('income.export.preset.custom'))}</option>
        <option value="thisYear">${esc(t('exp.filter.preset.thisYear'))}</option>
        <option value="last3">${esc(t('exp.filter.preset.last3'))}</option>
        <option value="lastYear">${esc(t('exp.filter.preset.lastYear'))}</option>
        <option value="all">${esc(t('exp.filter.preset.all'))}</option>
      </select>
      <input class="input" id="tk-from" type="date" value="${esc(filterFrom || '')}" style="width:140px" />
      <input class="input" id="tk-to" type="date" value="${esc(filterTo || '')}" style="width:140px" />
    </div>

    ${filtered.length === 0 ? renderEmpty({
      title: t('tickets.empty.title'),
      hint: all.length === 0 ? t('tickets.empty.first') : t('tickets.empty.adjustFilter'),
      action: `<button class="btn btn--primary" id="add-tk-empty">${Icon.plus} ${esc(t('tickets.add'))}</button>`,
    }) : `
      <div class="vstack" style="gap:10px">
        ${filtered.map(tk => renderTicketCard(tk, isAdmin)).join('')}
      </div>
    `}
  `);

  // Mark unread tickets as seen — admin polling will reset to 0 on next tick.
  if (isAdmin) { api.ticketsMarkSeen().catch(() => {}); }

  document.getElementById('tk-search').addEventListener('input', (e) => { searchTerm = e.target.value; renderTickets(); });
  document.getElementById('tk-cat').addEventListener('change', (e) => { filterCategory = e.target.value; renderTickets(); });
  document.getElementById('tk-status').addEventListener('change', (e) => { filterStatus = e.target.value; renderTickets(); });
  const presetSel = document.getElementById('tk-preset');
  const flipToCustom = () => { if (presetSel) presetSel.value = 'custom'; };
  document.getElementById('tk-from')?.addEventListener('change', (e) => { filterFrom = e.target.value || null; flipToCustom(); renderTickets(); });
  document.getElementById('tk-to')?.addEventListener('change', (e) => { filterTo = e.target.value || null; flipToCustom(); renderTickets(); });
  presetSel?.addEventListener('change', () => {
    const today = new Date(); const y = today.getFullYear(); const v = presetSel.value;
    if (v === 'thisYear') { filterFrom = `${y}-01-01`; filterTo = `${y}-12-31`; }
    else if (v === 'lastYear') { filterFrom = `${y-1}-01-01`; filterTo = `${y-1}-12-31`; }
    else if (v === 'last3') {
      const back = new Date(today); back.setMonth(today.getMonth() - 2); back.setDate(1);
      filterFrom = `${back.getFullYear()}-${String(back.getMonth()+1).padStart(2,'0')}-01`;
      filterTo = todayISO();
    } else if (v === 'all') { filterFrom = null; filterTo = null; }
    renderTickets();
  });

  document.getElementById('add-tk')?.addEventListener('click', () => openTicketDialog());
  document.getElementById('add-tk-empty')?.addEventListener('click', () => openTicketDialog());

  document.querySelectorAll('[data-act="tk-expand"]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id;
    if (expandedTickets.has(id)) expandedTickets.delete(id); else expandedTickets.add(id);
    renderTickets();
  }));

  document.querySelectorAll('[data-act="tk-edit"]').forEach(b => b.addEventListener('click', () => {
    const tk = getTickets().find(x => x.id === b.dataset.id);
    if (tk) openTicketDialog(tk);
  }));
  document.querySelectorAll('[data-act="tk-close"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const id = b.dataset.id;
    try { await closeTicket(id); toast(t('tickets.closed'), 'success'); renderTickets(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));
  document.querySelectorAll('[data-act="tk-reopen"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const id = b.dataset.id;
    try { await reopenTicket(id); toast(t('tickets.reopened'), 'success'); renderTickets(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));
  document.querySelectorAll('[data-act="tk-delete"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const id = b.dataset.id;
    const tk = getTickets().find(x => x.id === id);
    const ok = await confirmDialog({
      title: t('tickets.delete.title'),
      message: t('tickets.delete.message', { title: tk?.title || '' }),
      danger: true, confirmText: t('common.delete'),
    });
    if (!ok) return;
    try { await deleteTicket(id); toast(t('tickets.deleted'), 'success'); renderTickets(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));
  document.querySelectorAll('[data-act="tk-link-exp"]').forEach(b => b.addEventListener('click', () => {
    if (!requireAdmin()) return;
    const tk = getTickets().find(x => x.id === b.dataset.id);
    if (tk) openLinkExpenseDialog(tk);
  }));
  document.querySelectorAll('[data-act="tk-unlink-exp"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const id = b.dataset.id;
    try { await linkTicketExpense(id, null); toast(t('tickets.expense.unlinked'), 'success'); renderTickets(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));

  // Comments: post + delete
  document.querySelectorAll('form[data-act="tk-comment-form"]').forEach(f => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = f.dataset.id;
    const txt = f.querySelector('textarea').value.trim();
    if (!txt) return;
    try { await addTicketComment(id, txt); renderTickets(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));
  document.querySelectorAll('[data-act="tk-comment-del"]').forEach(b => b.addEventListener('click', async () => {
    const cid = b.dataset.cid;
    const ok = await confirmDialog({ title: t('tickets.comments.delete.title'), message: t('tickets.comments.delete.message'), danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    try { await deleteTicketComment(cid); renderTickets(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));

  // Remove image (creator+open OR admin) via the existing detach endpoint.
  document.querySelectorAll('[data-act="tk-img-rm"]').forEach(b => b.addEventListener('click', async () => {
    const did = b.dataset.did;
    const tid = b.dataset.tid;
    const ok = await confirmDialog({ title: t('tickets.image.remove.title'), message: t('tickets.image.remove.message'), danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    try { await detachDocument('ticket', tid, did); renderTickets(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));
}

function categoryLabel(tk) {
  if (tk.category === 'other') return tk.customCategory || t('tickets.cat.other');
  return t('tickets.cat.' + tk.category);
}

function categoryBadge(tk) {
  // Different categories get different tones so the cards read at a glance.
  const map = {
    electricity: 'badge--warning',
    plumbing: 'badge--info',
    sewage: 'badge--info',
    elevator: 'badge--violet',
    cleaning: 'badge--success',
    garden: 'badge--success',
    parking: 'badge--accent',
    security: 'badge--danger',
    intercom: 'badge--info',
    renovation: 'badge--accent',
    other: 'badge',
  };
  const cls = map[tk.category] || 'badge';
  return `<span class="badge ${cls}">${esc(categoryLabel(tk))}</span>`;
}

function statusBadge(tk) {
  return tk.status === 'open'
    ? `<span class="badge badge--warning">${esc(t('tickets.status.open'))}</span>`
    : `<span class="badge badge--success">${Icon.check} ${esc(t('tickets.status.closed'))}</span>`;
}

function renderTicketCard(tk, isAdmin) {
  const session = getSession();
  // Logged-in user can edit / remove images iff they are the original
  // creator AND the ticket is still open. Admin can edit anytime.
  const myKind = session.userKind === 'owner' ? 'owner'
              : (session.userKind === 'tenant' ? 'apartment-tenant' : 'admin');
  const myId = session.ownerId || session.apartmentId || null;
  const isCreator = tk.openedByKind === myKind && (tk.openedById || null) === (myId || null);
  const canEdit = isAdmin || (isCreator && tk.status === 'open');
  const expanded = expandedTickets.has(tk.id);
  const images = (tk.documents || []).map(did => getDocuments().find(d => d.id === did)).filter(Boolean);
  const thumbsToShow = expanded ? images : images.slice(0, 3);
  const linkedExpense = tk.expenseId ? getExpenses().find(e => e.id === tk.expenseId) : null;

  return `
    <div class="card" data-tk="${esc(tk.id)}">
      <div class="hstack" style="gap:10px; align-items:flex-start; flex-wrap:wrap">
        <div style="flex:1; min-width:240px">
          <div class="hstack" style="gap:8px; align-items:center; flex-wrap:wrap">
            <strong style="font-size:15px">${esc(tk.title)}</strong>
            ${categoryBadge(tk)}
            ${statusBadge(tk)}
          </div>
          <div class="muted" style="font-size:12px; margin-top:6px">
            ${esc(t('tickets.openedBy', { name: tk.openedByLabel, when: fmtDate(tk.openedAt) }))}
            ${tk.closedAt ? ` · ${esc(t('tickets.closedBy', { name: tk.closedByLabel || '', when: fmtDate(tk.closedAt) }))}` : ''}
          </div>
          ${linkedExpense ? `
            <div class="muted" style="font-size:12px; margin-top:4px">
              ${Icon.expenses} <a href="#expenses" style="text-decoration:underline">${esc(t('tickets.linkedExpense'))}: ${esc(linkedExpense.name)}</a>
              ${isAdmin ? ` · <button class="btn btn--sm btn--ghost" data-act="tk-unlink-exp" data-id="${esc(tk.id)}">${esc(t('tickets.expense.unlink'))}</button>` : ''}
            </div>
          ` : ''}
        </div>
        <div class="hstack" style="gap:6px; flex-wrap:wrap">
          <button class="btn btn--sm" data-act="tk-expand" data-id="${esc(tk.id)}">${expanded ? '▴' : '▾'} ${esc(expanded ? t('tickets.collapse') : t('tickets.expand'))}</button>
          ${canEdit ? `<button class="btn btn--sm btn--icon" data-act="tk-edit" data-id="${esc(tk.id)}" title="${esc(t('common.edit'))}">${Icon.edit}</button>` : ''}
          ${isAdmin && tk.status === 'open' ? `<button class="btn btn--sm" data-act="tk-close" data-id="${esc(tk.id)}">${esc(t('tickets.action.close'))}</button>` : ''}
          ${isAdmin && tk.status === 'closed' ? `<button class="btn btn--sm" data-act="tk-reopen" data-id="${esc(tk.id)}">${esc(t('tickets.action.reopen'))}</button>` : ''}
          ${isAdmin && !linkedExpense ? `<button class="btn btn--sm" data-act="tk-link-exp" data-id="${esc(tk.id)}">${esc(t('tickets.action.linkExpense'))}</button>` : ''}
          ${isAdmin ? `<button class="btn btn--sm btn--icon" data-act="tk-delete" data-id="${esc(tk.id)}" title="${esc(t('common.delete'))}">${Icon.trash}</button>` : ''}
        </div>
      </div>

      ${thumbsToShow.length ? `
        <div class="hstack" style="gap:6px; flex-wrap:wrap; margin-top:10px">
          ${thumbsToShow.map(d => `
            <div style="position:relative">
              <a href="${api.documentURL(d.id)}" target="_blank" rel="noopener" title="${esc(d.displayName || d.name)}">
                <img src="${api.documentURL(d.id)}" alt="${esc(d.displayName || d.name)}" style="width:88px; height:88px; object-fit:cover; border-radius:6px; border:1px solid var(--c-border); display:block" />
              </a>
              ${canEdit ? `<button class="btn btn--sm btn--icon" data-act="tk-img-rm" data-did="${esc(d.id)}" data-tid="${esc(tk.id)}" title="${esc(t('common.delete'))}" style="position:absolute; top:2px; inset-inline-end:2px; padding:1px 4px; background:rgba(255,255,255,0.9)">${Icon.trash}</button>` : ''}
            </div>
          `).join('')}
          ${(!expanded && images.length > 3) ? `<div class="muted" style="align-self:center; font-size:12px">+${images.length - 3}</div>` : ''}
        </div>
      ` : ''}

      ${expanded ? `
        <div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--c-border)">
          ${tk.description ? `<div style="white-space:pre-wrap; margin-bottom:14px">${esc(tk.description)}</div>` : ''}

          <h4 style="margin:0 0 8px; font-size:13px">${esc(t('tickets.comments.title', { n: (tk.comments || []).length }))}</h4>
          <div class="vstack" style="gap:8px">
            ${(tk.comments || []).map(c => renderComment(c, session, isAdmin)).join('')}
          </div>
          <form data-act="tk-comment-form" data-id="${esc(tk.id)}" style="margin-top:10px">
            <textarea class="input" rows="2" required placeholder="${esc(t('tickets.comments.placeholder'))}" style="width:100%; resize:vertical"></textarea>
            <div class="hstack" style="margin-top:6px; justify-content:flex-end">
              <button type="submit" class="btn btn--sm btn--primary">${esc(t('tickets.comments.send'))}</button>
            </div>
          </form>
        </div>
      ` : ''}
    </div>
  `;
}

function renderComment(c, session, isAdmin) {
  const myKind = session.userKind === 'owner' ? 'owner'
              : (session.userKind === 'tenant' ? 'apartment-tenant' : 'admin');
  const myId = session.ownerId || session.apartmentId || null;
  const isAuthor = c.authorKind === myKind && (c.authorId || null) === (myId || null);
  const canDelete = isAdmin || isAuthor;
  return `
    <div style="background:var(--c-surface-2); padding:8px 10px; border-radius:6px">
      <div class="hstack" style="justify-content:space-between; align-items:baseline">
        <div style="font-size:13px"><strong>${esc(c.authorLabel)}</strong> <span class="muted" style="font-size:11px">· ${esc(fmtDate(c.createdAt))}</span></div>
        ${canDelete ? `<button class="btn btn--sm btn--icon" data-act="tk-comment-del" data-cid="${esc(c.id)}" title="${esc(t('common.delete'))}">${Icon.trash}</button>` : ''}
      </div>
      <div style="white-space:pre-wrap; font-size:13px; margin-top:4px">${esc(c.body)}</div>
    </div>
  `;
}

// Create / edit ticket dialog. Image picker offers two buttons: camera
// capture (mobile) and gallery/disk. Files are queued and uploaded after
// the ticket row is created so we have an ID to attach against.
function openTicketDialog(ticket = null) {
  const session = getSession();
  if (!session.loggedIn) return;
  const isEdit = !!ticket;
  const pending = []; // { file, displayName }

  const m = openModal({
    title: isEdit ? t('tickets.dialog.edit') : t('tickets.dialog.add'),
    size: 'lg',
    body: `
      <form id="tk-form" class="form-grid">
        <div class="field field--required" style="grid-column:1/-1">
          <label class="field__label">${esc(t('tickets.field.title'))}</label>
          <input class="input" name="title" required maxlength="200" value="${esc(ticket?.title || '')}" />
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('tickets.field.description'))}</label>
          <textarea class="input" name="description" rows="4" maxlength="4000" placeholder="${esc(t('tickets.field.descriptionPlaceholder'))}">${esc(ticket?.description || '')}</textarea>
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('tickets.field.category'))}</label>
          <select class="select" name="category" id="tk-cat-sel">
            ${CATEGORIES.map(c => `<option value="${c}" ${ticket?.category===c?'selected':''}>${esc(t('tickets.cat.' + c))}</option>`).join('')}
          </select>
        </div>
        <div class="field" id="tk-cat-custom-wrap" style="display:${ticket?.category==='other'?'flex':'none'}">
          <label class="field__label">${esc(t('tickets.field.customCategory'))}</label>
          <input class="input" name="customCategory" maxlength="100" value="${esc(ticket?.customCategory || '')}" placeholder="${esc(t('tickets.field.customCategoryPlaceholder'))}" />
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('tickets.field.images'))}</label>
          <div class="hstack" style="gap:8px; flex-wrap:wrap">
            <label class="btn btn--sm" style="cursor:pointer">
              ${Icon.camera || '📷'} ${esc(t('tickets.field.takePhoto'))}
              <input type="file" accept="image/*" capture="environment" multiple style="display:none" id="tk-cam" />
            </label>
            <label class="btn btn--sm" style="cursor:pointer">
              ${Icon.document} ${esc(t('tickets.field.uploadImage'))}
              <input type="file" accept="image/*" multiple style="display:none" id="tk-gal" />
            </label>
          </div>
          <div class="field__hint">${esc(t('tickets.field.imagesHint'))}</div>
          <div id="tk-img-queue" class="hstack" style="gap:6px; flex-wrap:wrap; margin-top:8px"></div>
        </div>
      </form>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save">${esc(isEdit ? t('common.save') : t('tickets.action.create'))}</button>
    `,
  });
  if (!m) return;

  // Show / hide the custom-category text field based on the selected option.
  m.bodyEl.querySelector('#tk-cat-sel').addEventListener('change', (e) => {
    m.bodyEl.querySelector('#tk-cat-custom-wrap').style.display = e.target.value === 'other' ? 'flex' : 'none';
  });

  const queueEl = m.bodyEl.querySelector('#tk-img-queue');
  const renderQueue = () => {
    setHTML(queueEl, pending.map((p, i) => `
      <div style="position:relative">
        <img src="${URL.createObjectURL(p.file)}" alt="${esc(p.file.name)}" style="width:72px; height:72px; object-fit:cover; border-radius:6px; border:1px solid var(--c-border); display:block" />
        <button class="btn btn--sm btn--icon" data-rm="${i}" title="${esc(t('common.delete'))}" style="position:absolute; top:2px; inset-inline-end:2px; padding:1px 4px; background:rgba(255,255,255,0.9)">${Icon.trash}</button>
      </div>
    `).join(''));
    queueEl.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      pending.splice(Number(b.dataset.rm), 1);
      renderQueue();
    }));
  };
  const onPick = (input) => {
    for (const f of input.files || []) pending.push({ file: f });
    input.value = '';
    renderQueue();
  };
  m.bodyEl.querySelector('#tk-cam').addEventListener('change', (e) => onPick(e.target));
  m.bodyEl.querySelector('#tk-gal').addEventListener('change', (e) => onPick(e.target));

  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#tk-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!data.title?.trim()) { toast(t('tickets.field.titleRequired'), 'warning'); return; }
    if (!data.category) { toast(t('tickets.field.categoryRequired'), 'warning'); return; }
    if (data.category === 'other' && !data.customCategory?.trim()) {
      toast(t('tickets.field.customCategoryRequired'), 'warning'); return;
    }
    const saveBtn = m.footerEl.querySelector('[data-act="save"]');
    saveBtn.disabled = true;
    try {
      const saved = isEdit ? await updateTicket(ticket.id, data) : await createTicket(data);
      const id = saved?.id || ticket?.id;
      // Upload queued images (best-effort).
      let fails = 0;
      for (const p of pending) {
        try { await uploadDocument(p.file, { type: 'ticket', id }); }
        catch { fails++; }
      }
      if (fails) toast(t('tickets.field.imagesPartialFail', { n: fails }), 'warning');
      else toast(isEdit ? t('tickets.updated') : t('tickets.created'), 'success');
      m.close();
      renderTickets();
    } catch (err) {
      toast(err.message || t('common.error'), 'danger');
      saveBtn.disabled = false;
    }
  });
}

// Admin-only: link an existing expense, OR open the expense creation
// dialog and link the newly-saved expense back to this ticket.
function openLinkExpenseDialog(ticket) {
  const m = openModal({
    title: t('tickets.linkExpense.title'),
    size: 'md',
    body: `
      <div class="vstack" style="gap:14px">
        <div>
          <div class="field__label">${esc(t('tickets.linkExpense.pickExisting'))}</div>
          <select class="select" id="exp-sel" style="width:100%">
            <option value="">${esc(t('tickets.linkExpense.choosePlaceholder'))}</option>
            ${getExpenses().map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}
          </select>
          <div class="hstack" style="justify-content:flex-end; margin-top:8px">
            <button class="btn btn--primary btn--sm" id="link-existing">${esc(t('tickets.linkExpense.linkBtn'))}</button>
          </div>
        </div>
        <div style="height:1px; background:var(--c-border)"></div>
        <div>
          <div class="field__label">${esc(t('tickets.linkExpense.createNew'))}</div>
          <div class="muted" style="font-size:12px; margin-bottom:8px">${esc(t('tickets.linkExpense.createHint'))}</div>
          <button class="btn btn--accent btn--sm" id="create-new">${Icon.plus} ${esc(t('tickets.linkExpense.createBtn'))}</button>
        </div>
      </div>
    `,
    footer: `<button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>`,
  });
  if (!m) return;
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());

  m.bodyEl.querySelector('#link-existing').addEventListener('click', async () => {
    const expenseId = m.bodyEl.querySelector('#exp-sel').value;
    if (!expenseId) { toast(t('tickets.linkExpense.pickFirst'), 'warning'); return; }
    try {
      await linkTicketExpense(ticket.id, expenseId);
      toast(t('tickets.expense.linked'), 'success');
      m.close();
      renderTickets();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
  m.bodyEl.querySelector('#create-new').addEventListener('click', () => {
    // Close this picker, then open the existing expense dialog with a
    // callback that links the new expense back to the ticket.
    m.close();
    openExpenseDialog(null, {
      onSaved: async (savedExpense) => {
        if (!savedExpense?.id) return;
        try {
          await linkTicketExpense(ticket.id, savedExpense.id);
          toast(t('tickets.expense.linkedAndCreated'), 'success');
          renderTickets();
        } catch (err) { toast(err.message || t('common.error'), 'danger'); }
      },
    });
  });
}
