// Reminders — central view: active / upcoming / acknowledged history.
// Reminders may be standalone or linked to an expense (one per expense).

import { getReminders, getExpenses, getSession, upsertReminder, deleteReminder, acknowledgeReminder, unacknowledgeReminder } from '../store.js';
import { activeReminders, upcomingReminders, acknowledgedReminders } from '../calc.js';
import { fmtDate, esc, todayISO } from '../utils.js';
import { t } from '../i18n.js';
import { setHTML, renderPageHeader, renderEmpty, openModal, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';

export function renderReminders() {
  const main = document.getElementById('app-main');
  const session = getSession();
  const isAdmin = session.role === 'admin';

  const active = activeReminders();
  const upcoming = upcomingReminders();
  const history = acknowledgedReminders();
  const expenses = getExpenses();
  const expById = new Map(expenses.map(e => [e.id, e]));

  setHTML(main, `
    ${renderPageHeader({
      title: t('reminders.title'),
      subtitle: t('reminders.subtitle'),
      actions: isAdmin ? `<button class="btn btn--primary" id="add-rem">${Icon.plus} ${esc(t('reminders.add'))}</button>` : '',
    })}

    <div class="card" style="margin-bottom:18px">
      <div class="hstack" style="margin-bottom:12px">
        <h3 style="margin:0">${esc(t('reminders.section.active'))}</h3>
        <span class="badge ${active.length ? 'badge--warning' : ''}">${active.length}</span>
      </div>
      ${active.length === 0
        ? `<p class="muted" style="margin:0">${esc(t('reminders.empty.active'))}</p>`
        : `<div class="vstack" style="gap:10px">${active.map(r => renderReminderRow(r, expById, isAdmin, true)).join('')}</div>`}
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="hstack" style="margin-bottom:12px">
        <h3 style="margin:0">${esc(t('reminders.section.upcoming'))}</h3>
        <span class="badge">${upcoming.length}</span>
      </div>
      ${upcoming.length === 0
        ? `<p class="muted" style="margin:0">${esc(t('reminders.empty.upcoming'))}</p>`
        : `<div class="vstack" style="gap:10px">${upcoming.map(r => renderReminderRow(r, expById, isAdmin, false)).join('')}</div>`}
    </div>

    <div class="card">
      <div class="hstack" style="margin-bottom:12px">
        <h3 style="margin:0">${esc(t('reminders.section.history'))}</h3>
        <span class="badge">${history.length}</span>
      </div>
      ${history.length === 0
        ? `<p class="muted" style="margin:0">${esc(t('reminders.empty.history'))}</p>`
        : `<div class="vstack" style="gap:8px">${history.map(r => renderHistoryRow(r, expById, isAdmin)).join('')}</div>`}
    </div>
  `);

  document.getElementById('add-rem')?.addEventListener('click', () => openReminderDialog());

  document.querySelectorAll('[data-act="ack-rem"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    try { await acknowledgeReminder(b.dataset.id); toast(t('reminders.acknowledged'), 'success'); renderReminders(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));
  document.querySelectorAll('[data-act="unack-rem"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    try { await unacknowledgeReminder(b.dataset.id); renderReminders(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));
  document.querySelectorAll('[data-act="edit-rem"]').forEach(b => b.addEventListener('click', () => {
    const r = getReminders().find(x => x.id === b.dataset.id);
    if (r) openReminderDialog(r);
  }));
  document.querySelectorAll('[data-act="del-rem"]').forEach(b => b.addEventListener('click', async () => {
    if (!requireAdmin()) return;
    const ok = await confirmDialog({ title: t('reminders.delete.title'), message: t('reminders.delete.message'), danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    try { await deleteReminder(b.dataset.id); toast(t('reminders.deleted'), 'success'); renderReminders(); }
    catch (err) { toast(err.message || t('common.error'), 'danger'); }
  }));
}

function renderReminderRow(r, expById, isAdmin, active) {
  const exp = r.expenseId ? expById.get(r.expenseId) : null;
  const dueLabel = relativeDueLabel(r);
  const dueClass = active ? 'text-danger' : 'muted';
  return `
    <div class="card" style="padding:12px 14px; background:${active ? 'var(--c-warning-soft)' : 'transparent'}; border:1px solid ${active ? 'var(--c-warning)' : 'var(--c-border)'}">
      <div class="hstack" style="margin-bottom:6px">
        <strong>${esc(r.title)}</strong>
        <span class="${dueClass}" style="font-size:13px">${esc(dueLabel)} · ${fmtDate(r.dueDate)}</span>
        <div class="spacer"></div>
        ${isAdmin ? `
          <button class="btn btn--sm btn--accent" data-act="ack-rem" data-id="${r.id}">${Icon.check} ${esc(t('reminders.acknowledge'))}</button>
          <button class="btn btn--sm btn--icon" data-act="edit-rem" data-id="${r.id}" title="${esc(t('common.edit'))}">${Icon.edit}</button>
          <button class="btn btn--sm btn--icon" data-act="del-rem" data-id="${r.id}" title="${esc(t('common.delete'))}">${Icon.trash}</button>
        ` : ''}
      </div>
      ${r.note ? `<div class="muted" style="font-size:13px">${esc(r.note)}</div>` : ''}
      ${exp ? `<div class="muted" style="font-size:12px; margin-top:6px">${esc(t('reminders.linkedExpense', { name: exp.name }))}</div>` : ''}
    </div>
  `;
}

function renderHistoryRow(r, expById, isAdmin) {
  const exp = r.expenseId ? expById.get(r.expenseId) : null;
  return `
    <div class="hstack" style="padding:8px 12px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-bg-soft)">
      <div>
        <div><strong>${esc(r.title)}</strong> <span class="muted" style="font-size:12px">· ${fmtDate(r.dueDate)}</span></div>
        ${exp ? `<div class="muted" style="font-size:12px">${esc(t('reminders.linkedExpense', { name: exp.name }))}</div>` : ''}
      </div>
      <div class="spacer"></div>
      ${isAdmin ? `
        <button class="btn btn--sm" data-act="unack-rem" data-id="${r.id}">${esc(t('reminders.unacknowledge'))}</button>
        <button class="btn btn--sm btn--icon" data-act="del-rem" data-id="${r.id}">${Icon.trash}</button>
      ` : ''}
    </div>
  `;
}

function relativeDueLabel(r) {
  const now = new Date();
  const due = new Date(r.dueDate);
  const ms = due.getTime() - new Date(now.toDateString()).getTime();
  const days = Math.round(ms / 86400000);
  if (days > 0) return t('reminders.daysUntil', { n: days });
  if (days === 0) return t('reminders.dueToday');
  return t('reminders.daysOverdue', { n: -days });
}

// ----- Reminder dialog -----
// Used both from this view and from the expense form (with prefill + locking).
export function openReminderDialog(reminder = null, opts = {}) {
  if (!requireAdmin()) return;
  const isEdit = !!reminder?.id;
  const expenses = getExpenses();
  const lockedExpenseId = opts.lockedExpenseId || null;
  const onSaved = opts.onSaved;

  const m = openModal({
    title: isEdit ? t('reminders.dialog.edit') : t('reminders.dialog.add'),
    body: `
      <form id="rem-form" class="form-grid">
        <div class="field field--required" style="grid-column:1/-1">
          <label class="field__label">${esc(t('reminders.field.title'))}</label>
          <input class="input" name="title" required value="${esc(reminder?.title || opts.defaultTitle || '')}" />
        </div>
        <div class="field field--required">
          <label class="field__label">${esc(t('reminders.field.dueDate'))}</label>
          <input class="input" name="dueDate" type="date" required value="${esc(reminder?.dueDate || opts.defaultDueDate || todayISO())}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('reminders.field.leadDays'))}</label>
          <input class="input" name="leadDays" type="number" min="0" value="${reminder?.leadDays ?? opts.defaultLeadDays ?? 0}" />
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('reminders.field.note'))}</label>
          <textarea class="textarea" name="note" rows="2">${esc(reminder?.note || '')}</textarea>
        </div>
        ${lockedExpenseId ? `<input type="hidden" name="expenseId" value="${esc(lockedExpenseId)}" />` : `
          <div class="field" style="grid-column:1/-1">
            <label class="field__label">${esc(t('reminders.field.expense'))}</label>
            <select class="select" name="expenseId">
              <option value="">${esc(t('reminders.field.expense.none'))}</option>
              ${expenses.map(e => `<option value="${esc(e.id)}" ${reminder?.expenseId === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
            </select>
          </div>
        `}
      </form>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#rem-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!data.title) { toast(t('reminders.titleRequired'), 'warning'); return; }
    if (!data.dueDate) { toast(t('reminders.dueDateRequired'), 'warning'); return; }
    try {
      const saved = await upsertReminder({
        id: reminder?.id,
        title: data.title,
        dueDate: data.dueDate,
        leadDays: Number(data.leadDays || 0),
        note: data.note || null,
        expenseId: data.expenseId || null,
      });
      toast(isEdit ? t('reminders.updated') : t('reminders.added'), 'success');
      m.close();
      if (onSaved) onSaved(saved);
      else if (location.hash === '#reminders') renderReminders();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}
