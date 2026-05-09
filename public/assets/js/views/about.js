// About — bank details, committee members, and free-form description.
// Tenants see read-only; admins can edit each section.

import { getSession, getSettings, getVaadMembers, getOwners, getApartments, updateSettingsBasic, upsertVaadMember, deleteVaadMember } from '../store.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { setHTML, renderPageHeader, openModal, confirmDialog, toast, requireAdmin, Icon } from '../ui.js';

export function renderAbout() {
  const main = document.getElementById('app-main');
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const s = getSettings();
  const members = getVaadMembers();

  setHTML(main, `
    ${renderPageHeader({ title: t('about.title'), subtitle: t('about.subtitle') })}

    ${!isAdmin ? `<div class="callout">${esc(t('about.viewerNotice'))}</div>` : ''}

    <div class="card" style="margin-bottom:18px">
      <div class="hstack" style="margin-bottom:14px">
        <h3 style="margin:0">${esc(t('about.bank.title'))}</h3>
      </div>
      ${isAdmin ? renderBankForm(s) : renderBankView(s)}
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="hstack" style="margin-bottom:14px">
        <h3 style="margin:0">${esc(t('about.bit.title'))}</h3>
      </div>
      ${isAdmin ? renderBitForm(s) : renderBitView(s)}
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="hstack" style="margin-bottom:14px">
        <h3 style="margin:0">${esc(t('about.paybox.title'))}</h3>
      </div>
      ${isAdmin ? renderPayboxForm(s) : renderPayboxView(s)}
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="hstack" style="margin-bottom:14px">
        <h3 style="margin:0">${esc(t('about.members.title'))}</h3>
        <span class="badge">${members.length}</span>
        <div class="spacer"></div>
        ${isAdmin ? `<button class="btn btn--sm btn--primary" id="add-member">${Icon.plus} ${esc(t('about.members.add'))}</button>` : ''}
      </div>
      ${members.length === 0
        ? `<p class="muted" style="margin:0">${esc(t('about.members.empty'))}</p>`
        : `<div class="vstack" style="gap:10px">${members.map(m => renderMemberCard(m, isAdmin)).join('')}</div>`}
    </div>

    <div class="card">
      <div class="hstack" style="margin-bottom:14px">
        <h3 style="margin:0">${esc(t('about.text.title'))}</h3>
      </div>
      ${isAdmin ? renderTextForm(s) : renderTextView(s)}
    </div>
  `);

  if (isAdmin) {
    document.getElementById('bank-form')?.addEventListener('submit', handleBankSubmit);
    document.getElementById('bit-form')?.addEventListener('submit', handleBitSubmit);
    document.getElementById('paybox-form')?.addEventListener('submit', handlePayboxSubmit);
    document.getElementById('about-text-form')?.addEventListener('submit', handleTextSubmit);
    document.getElementById('add-member')?.addEventListener('click', () => openMemberDialog());
    document.querySelectorAll('[data-act="edit-vm"]').forEach(b => b.addEventListener('click', () => {
      const m = getVaadMembers().find(x => x.id === b.dataset.id);
      if (m) openMemberDialog(m);
    }));
    document.querySelectorAll('[data-act="del-vm"]').forEach(b => b.addEventListener('click', async () => {
      if (!requireAdmin()) return;
      const m = getVaadMembers().find(x => x.id === b.dataset.id);
      const ok = await confirmDialog({
        title: t('about.members.delete.title'),
        message: t('about.members.delete.message', { name: m.name }),
        danger: true, confirmText: t('common.delete'),
      });
      if (!ok) return;
      try { await deleteVaadMember(m.id); toast(t('about.members.deleted'), 'success'); renderAbout(); }
      catch (err) { toast(err.message || t('common.error'), 'danger'); }
    }));
  }
}

// ----- Bank section -----
function renderBankForm(s) {
  return `
    <form id="bank-form" class="form-grid">
      <div class="field">
        <label class="field__label">${esc(t('about.bank.field.name'))}</label>
        <input class="input" name="bankName" value="${esc(s.bankName || '')}" />
      </div>
      <div class="field">
        <label class="field__label">${esc(t('about.bank.field.branch'))}</label>
        <input class="input" name="bankBranch" value="${esc(s.bankBranch || '')}" />
      </div>
      <div class="field">
        <label class="field__label">${esc(t('about.bank.field.accountNumber'))}</label>
        <input class="input" name="bankAccountNumber" value="${esc(s.bankAccountNumber || '')}" />
      </div>
      <div class="field">
        <label class="field__label">${esc(t('about.bank.field.accountHolder'))}</label>
        <input class="input" name="bankAccountHolder" value="${esc(s.bankAccountHolder || '')}" />
      </div>
      <div class="field">
        <label class="field__label">${esc(t('about.bank.field.iban'))}</label>
        <input class="input" name="bankIban" value="${esc(s.bankIban || '')}" />
      </div>
      <div class="field" style="grid-column:1/-1">
        <label class="field__label">${esc(t('about.bank.field.notes'))}</label>
        <textarea class="textarea" name="bankNotes" rows="2">${esc(s.bankNotes || '')}</textarea>
      </div>
      <div style="grid-column:1/-1; text-align:start">
        <button class="btn btn--primary" type="submit">${esc(t('common.save'))}</button>
      </div>
    </form>
  `;
}

function renderBankView(s) {
  const hasAny = s.bankName || s.bankBranch || s.bankAccountNumber || s.bankAccountHolder || s.bankIban || s.bankNotes;
  if (!hasAny) return `<p class="muted" style="margin:0">${esc(t('about.bank.empty'))}</p>`;
  const row = (label, value) => value ? `
    <div class="hstack" style="gap:6px; padding:6px 0; border-bottom:1px solid var(--c-border)">
      <span class="muted" style="min-width:140px; font-size:13px">${esc(label)}</span>
      <strong>${esc(value)}</strong>
    </div>
  ` : '';
  return `
    <div class="vstack" style="gap:0">
      ${row(t('about.bank.field.name'), s.bankName)}
      ${row(t('about.bank.field.branch'), s.bankBranch)}
      ${row(t('about.bank.field.accountNumber'), s.bankAccountNumber)}
      ${row(t('about.bank.field.accountHolder'), s.bankAccountHolder)}
      ${row(t('about.bank.field.iban'), s.bankIban)}
      ${s.bankNotes ? `<div style="padding:10px 0 0; font-size:14px; white-space:pre-line">${esc(s.bankNotes)}</div>` : ''}
    </div>
  `;
}

async function handleBankSubmit(ev) {
  ev.preventDefault();
  if (!requireAdmin()) return;
  const data = Object.fromEntries(new FormData(ev.target).entries());
  try {
    await updateSettingsBasic({
      bankName: data.bankName,
      bankBranch: data.bankBranch,
      bankAccountNumber: data.bankAccountNumber,
      bankAccountHolder: data.bankAccountHolder,
      bankIban: data.bankIban,
      bankNotes: data.bankNotes,
    });
    toast(t('about.bank.saved'), 'success');
    renderAbout();
  } catch (err) { toast(err.message || t('common.error'), 'danger'); }
}

// ----- Bit section -----
function renderBitForm(s) {
  return `
    <form id="bit-form" class="form-grid">
      <div class="field">
        <label class="field__label">${esc(t('about.bit.field.phone'))}</label>
        <input class="input" name="bitPhone" type="tel" value="${esc(s.bitPhone || '')}" placeholder="050-..." />
      </div>
      <div class="field">
        <label class="field__label">${esc(t('about.bit.field.holder'))}</label>
        <input class="input" name="bitHolder" value="${esc(s.bitHolder || '')}" />
      </div>
      <div class="field" style="grid-column:1/-1">
        <label class="field__label">${esc(t('about.bit.field.notes'))}</label>
        <textarea class="textarea" name="bitNotes" rows="2">${esc(s.bitNotes || '')}</textarea>
      </div>
      <div style="grid-column:1/-1; text-align:start">
        <button class="btn btn--primary" type="submit">${esc(t('common.save'))}</button>
      </div>
    </form>
  `;
}

function renderBitView(s) {
  const hasAny = s.bitPhone || s.bitHolder || s.bitNotes;
  if (!hasAny) return `<p class="muted" style="margin:0">${esc(t('about.bit.empty'))}</p>`;
  const row = (label, value) => value ? `
    <div class="hstack" style="gap:6px; padding:6px 0; border-bottom:1px solid var(--c-border)">
      <span class="muted" style="min-width:140px; font-size:13px">${esc(label)}</span>
      <strong>${esc(value)}</strong>
    </div>
  ` : '';
  return `
    <div class="vstack" style="gap:0">
      ${row(t('about.bit.field.phone'), s.bitPhone)}
      ${row(t('about.bit.field.holder'), s.bitHolder)}
      ${s.bitNotes ? `<div style="padding:10px 0 0; font-size:14px; white-space:pre-line">${esc(s.bitNotes)}</div>` : ''}
    </div>
  `;
}

async function handleBitSubmit(ev) {
  ev.preventDefault();
  if (!requireAdmin()) return;
  const data = Object.fromEntries(new FormData(ev.target).entries());
  try {
    await updateSettingsBasic({
      bitPhone: data.bitPhone,
      bitHolder: data.bitHolder,
      bitNotes: data.bitNotes,
    });
    toast(t('about.bit.saved'), 'success');
    renderAbout();
  } catch (err) { toast(err.message || t('common.error'), 'danger'); }
}

// ----- PayBox section -----
function renderPayboxForm(s) {
  return `
    <form id="paybox-form" class="form-grid">
      <div class="field">
        <label class="field__label">${esc(t('about.paybox.field.phone'))}</label>
        <input class="input" name="payboxPhone" type="tel" value="${esc(s.payboxPhone || '')}" placeholder="050-..." />
      </div>
      <div class="field">
        <label class="field__label">${esc(t('about.paybox.field.holder'))}</label>
        <input class="input" name="payboxHolder" value="${esc(s.payboxHolder || '')}" />
      </div>
      <div class="field" style="grid-column:1/-1">
        <label class="field__label">${esc(t('about.paybox.field.link'))}</label>
        <input class="input" name="payboxLink" type="url" value="${esc(s.payboxLink || '')}" placeholder="https://payboxapp.page.link/..." />
        <div class="field__hint">${esc(t('about.paybox.field.linkHint'))}</div>
      </div>
      <div class="field" style="grid-column:1/-1">
        <label class="field__label">${esc(t('about.paybox.field.notes'))}</label>
        <textarea class="textarea" name="payboxNotes" rows="2">${esc(s.payboxNotes || '')}</textarea>
      </div>
      <div style="grid-column:1/-1; text-align:start">
        <button class="btn btn--primary" type="submit">${esc(t('common.save'))}</button>
      </div>
    </form>
  `;
}

function renderPayboxView(s) {
  const hasAny = s.payboxPhone || s.payboxHolder || s.payboxLink || s.payboxNotes;
  if (!hasAny) return `<p class="muted" style="margin:0">${esc(t('about.paybox.empty'))}</p>`;
  const row = (label, value) => value ? `
    <div class="hstack" style="gap:6px; padding:6px 0; border-bottom:1px solid var(--c-border)">
      <span class="muted" style="min-width:140px; font-size:13px">${esc(label)}</span>
      <strong>${esc(value)}</strong>
    </div>
  ` : '';
  return `
    <div class="vstack" style="gap:0">
      ${row(t('about.paybox.field.phone'), s.payboxPhone)}
      ${row(t('about.paybox.field.holder'), s.payboxHolder)}
      ${s.payboxLink ? `
        <div class="hstack" style="gap:6px; padding:6px 0; border-bottom:1px solid var(--c-border)">
          <span class="muted" style="min-width:140px; font-size:13px">${esc(t('about.paybox.field.link'))}</span>
          <a href="${esc(s.payboxLink)}" target="_blank" rel="noopener" style="color:var(--c-primary); word-break:break-all">${esc(s.payboxLink)}</a>
        </div>
      ` : ''}
      ${s.payboxNotes ? `<div style="padding:10px 0 0; font-size:14px; white-space:pre-line">${esc(s.payboxNotes)}</div>` : ''}
    </div>
  `;
}

async function handlePayboxSubmit(ev) {
  ev.preventDefault();
  if (!requireAdmin()) return;
  const data = Object.fromEntries(new FormData(ev.target).entries());
  try {
    await updateSettingsBasic({
      payboxPhone: data.payboxPhone,
      payboxHolder: data.payboxHolder,
      payboxLink: data.payboxLink,
      payboxNotes: data.payboxNotes,
    });
    toast(t('about.paybox.saved'), 'success');
    renderAbout();
  } catch (err) { toast(err.message || t('common.error'), 'danger'); }
}

// ----- Members section -----
// Builds the source-list for the picker: every owner first, then every
// renter-occupied apartment. Each option carries `kind` ('owner' or
// 'apartment') and the source id, so the server can re-snapshot phone/email.
function buildPickerOptions() {
  const apts = getApartments();
  const aptByOwnerId = new Map();
  for (const a of apts) {
    if (!a.ownerId) continue;
    const arr = aptByOwnerId.get(a.ownerId) || [];
    arr.push(String(a.number));
    aptByOwnerId.set(a.ownerId, arr);
  }
  const opts = [];
  for (const o of [...getOwners()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'he'))) {
    const apartments = (aptByOwnerId.get(o.id) || [])
      .sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true }))
      .join(', ');
    const suffix = apartments ? ` · ${t('about.members.picker.aptsSuffix', { list: apartments })}` : '';
    opts.push({
      key: `owner:${o.id}`,
      kind: 'owner',
      id: o.id,
      label: `${t('about.members.picker.ownerPrefix')}${o.name || '—'}${suffix}`,
    });
  }
  for (const a of apts.filter(x => x.occupantType === 'renter')) {
    const renterName = a.owner || '—';
    opts.push({
      key: `apartment:${a.id}`,
      kind: 'apartment',
      id: a.id,
      label: `${t('about.members.picker.renterPrefix', { number: a.number })}${renterName}`,
    });
  }
  return opts;
}

function lookupPickerLabel(kind, id) {
  if (!kind || !id) return null;
  if (kind === 'owner') {
    const o = getOwners().find(x => x.id === id);
    return o ? `${t('about.members.picker.ownerPrefix')}${o.name || '—'}` : t('about.members.picker.deleted');
  }
  if (kind === 'apartment') {
    const a = getApartments().find(x => x.id === id);
    return a ? `${t('about.members.picker.renterPrefix', { number: a.number })}${a.owner || '—'}` : t('about.members.picker.deleted');
  }
  return null;
}

function renderMemberCard(m, isAdmin) {
  // Show the link-source badge under the name (e.g., "בעלים · יוסף כהן")
  // when the row is linked. Falls back gracefully when the source row was
  // deleted after the snapshot.
  const linkLabel = lookupPickerLabel(m.linkedKind, m.linkedId);
  return `
    <div class="card" style="padding:12px 14px">
      <div class="hstack" style="gap:10px; flex-wrap:wrap">
        <div>
          <div style="font-weight:700; font-size:15px">${esc(m.name)}</div>
          ${m.role ? `<div class="muted" style="font-size:13px">${esc(m.role)}</div>` : ''}
          ${linkLabel ? `<div class="muted" style="font-size:11px; margin-top:2px">${esc(linkLabel)}</div>` : ''}
        </div>
        <div class="spacer"></div>
        ${isAdmin ? `
          <button class="btn btn--sm btn--icon" data-act="edit-vm" data-id="${esc(m.id)}" title="${esc(t('common.edit'))}">${Icon.edit}</button>
          <button class="btn btn--sm btn--icon" data-act="del-vm" data-id="${esc(m.id)}" title="${esc(t('common.delete'))}">${Icon.trash}</button>
        ` : ''}
      </div>
      ${(m.phone || m.email) ? `
        <div class="hstack" style="gap:14px; margin-top:8px; font-size:13px; flex-wrap:wrap">
          ${m.phone ? `<a href="tel:${esc(m.phone)}" style="color:var(--c-primary)">${Icon.phone} ${esc(m.phone)}</a>` : ''}
          ${m.email ? `<a href="mailto:${esc(m.email)}" style="color:var(--c-primary)">${esc(m.email)}</a>` : ''}
        </div>
      ` : ''}
      ${m.notes ? `<div class="muted" style="margin-top:6px; font-size:13px; white-space:pre-line">${esc(m.notes)}</div>` : ''}
    </div>
  `;
}

function openMemberDialog(member = null) {
  if (!requireAdmin()) return;
  const isEdit = !!member;
  const opts = buildPickerOptions();
  if (!opts.length) {
    toast(t('about.members.noPeopleAvailable'), 'warning');
    return;
  }
  const initialKey = isEdit && member.linkedKind && member.linkedId
    ? `${member.linkedKind}:${member.linkedId}`
    : '';
  const m = openModal({
    title: isEdit ? t('about.members.dialog.edit') : t('about.members.dialog.add'),
    body: `
      <form id="vm-form" class="form-grid">
        <div class="field field--required" style="grid-column:1/-1">
          <label class="field__label">${esc(t('about.members.field.person'))}</label>
          <select class="select" id="vm-person" required>
            <option value="" ${!initialKey ? 'selected' : ''}>${esc(t('about.members.field.person.choose'))}</option>
            ${opts.map(o => `<option value="${esc(o.key)}" ${o.key === initialKey ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>
          <div class="field__hint">${esc(t('about.members.field.person.hint'))}</div>
        </div>
        <div class="field">
          <label class="field__label">${esc(t('about.members.field.role'))}</label>
          <input class="input" name="role" value="${esc(member?.role || '')}" placeholder="${esc(t('about.members.field.rolePlaceholder'))}" />
        </div>
        <div class="field">
          <label class="field__label">${esc(t('about.members.field.order'))}</label>
          <input class="input" name="displayOrder" type="number" min="0" value="${member?.displayOrder ?? 0}" />
        </div>
        <div class="field" style="grid-column:1/-1">
          <label class="field__label">${esc(t('about.members.field.notes'))}</label>
          <textarea class="textarea" name="notes" rows="2">${esc(member?.notes || '')}</textarea>
        </div>
        <div class="muted" style="grid-column:1/-1; font-size:12px">${esc(t('about.members.field.snapshotHint'))}</div>
      </form>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const f = m.bodyEl.querySelector('#vm-form');
    const data = Object.fromEntries(new FormData(f).entries());
    const personKey = m.bodyEl.querySelector('#vm-person').value;
    if (!personKey) { toast(t('about.members.personRequired'), 'warning'); return; }
    const [linkedKind, linkedId] = personKey.split(':');
    try {
      await upsertVaadMember({
        id: member?.id,
        linkedKind,
        linkedId,
        role: data.role || null,
        notes: data.notes || null,
        displayOrder: Number(data.displayOrder || 0),
      });
      toast(isEdit ? t('about.members.updated') : t('about.members.added'), 'success');
      m.close();
      renderAbout();
    } catch (err) { toast(err.message || t('common.error'), 'danger'); }
  });
}

// ----- Free text section -----
function renderTextForm(s) {
  return `
    <form id="about-text-form">
      <div class="field">
        <textarea class="textarea" name="aboutText" rows="5" placeholder="${esc(t('about.text.placeholder'))}">${esc(s.aboutText || '')}</textarea>
      </div>
      <div style="text-align:start">
        <button class="btn btn--primary" type="submit">${esc(t('common.save'))}</button>
      </div>
    </form>
  `;
}

function renderTextView(s) {
  if (!s.aboutText) return `<p class="muted" style="margin:0">${esc(t('about.text.empty'))}</p>`;
  return `<div style="font-size:14px; line-height:1.7; white-space:pre-line">${esc(s.aboutText)}</div>`;
}

async function handleTextSubmit(ev) {
  ev.preventDefault();
  if (!requireAdmin()) return;
  const data = Object.fromEntries(new FormData(ev.target).entries());
  try {
    await updateSettingsBasic({ aboutText: data.aboutText });
    toast(t('about.text.saved'), 'success');
    renderAbout();
  } catch (err) { toast(err.message || t('common.error'), 'danger'); }
}
