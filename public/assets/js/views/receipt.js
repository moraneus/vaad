// Receipt issuance + opening the printable view.
// The actual HTML is rendered server-side at /api/receipts?id=X&format=html
// — it sets a per-response CSP that allows inline scripts (auto-print) and
// inline event handlers (Print/Close buttons), which the global app CSP
// otherwise forbids.

import { getSession, createReceipt, fetchReceipt, fetchReceipts, getApartments } from '../store.js';
import { fmtCurrency, esc } from '../utils.js';
import { t, monthName } from '../i18n.js';
import { confirmDialog, toast, openModal, setHTML, Icon } from '../ui.js';

// Format the displayed receipt number — uses the running serial as the
// canonical "id", with apt/period as readable context.
export function formatReceiptNumber(receipt) {
  const padded = String(receipt.serial).padStart(5, '0');
  const mm = String(receipt.month).padStart(2, '0');
  return `${padded}/${receipt.apartmentNumber}/${mm}-${receipt.year}`;
}

// Issue a receipt for (apartmentId, year, month) and open the printable view.
export async function issueReceiptAndOpen(apartmentId, year, month) {
  const apt = getApartments().find(a => a.id === apartmentId);
  if (!apt) throw new Error('Apartment not found');
  const ok = await confirmDialog({
    title: t('receipts.issue.title'),
    message: t('receipts.issue.message', { number: apt.number, month: `${monthName(month)} ${year}` }),
    confirmText: t('receipts.issue'),
  });
  if (!ok) return null;
  const receipt = await createReceipt({ apartmentId, year, month });
  toast(t('receipts.issued'), 'success');
  openReceiptWindow(receipt);
  return receipt;
}

// Open the server-rendered receipt HTML in a new window. The page itself
// auto-triggers the print dialog and exposes "Print" / "Close" buttons.
export function openReceiptWindow(receipt) {
  const url = `/api/receipts?id=${encodeURIComponent(receipt.id)}&format=html`;
  const w = window.open(url, '_blank', 'width=720,height=920');
  if (!w) {
    toast('הדפדפן חסם את חלון ההדפסה — אפשר חלונות קופצים', 'warning');
  }
}

// ----- Receipt history modal -----
// Tenants see their own receipts; admins see everyone's.
export async function openReceiptHistory() {
  const session = getSession();
  const isAdmin = session.role === 'admin';
  const m = openModal({
    title: isAdmin ? t('receipts.history.titleAdmin') : t('receipts.history.title'),
    size: 'lg',
    body: '<div id="receipts-content" class="muted">…</div>',
    footer: `<button class="btn" data-act="close">${esc(t('common.close'))}</button>`,
  });
  m.footerEl.querySelector('[data-act="close"]').addEventListener('click', () => m.close());

  const list = await fetchReceipts().catch(() => []);
  const c = m.bodyEl.querySelector('#receipts-content');
  if (list.length === 0) {
    setHTML(c, `<p class="muted" style="margin:0">${esc(t('receipts.history.empty'))}</p>`);
    return;
  }
  setHTML(c, `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>${esc(t('receipts.history.col.serial'))}</th>
            ${isAdmin ? `<th>${esc(t('receipts.history.col.apt'))}</th>` : ''}
            <th>${esc(t('receipts.history.col.period'))}</th>
            <th class="num">${esc(t('receipts.history.col.amount'))}</th>
            <th>${esc(t('receipts.history.col.issued'))}</th>
            <th class="actions"></th>
          </tr>
        </thead>
        <tbody>
          ${list.map(r => `
            <tr>
              <td><strong>${esc(formatReceiptNumber(r))}</strong></td>
              ${isAdmin ? `<td>${esc(r.apartmentNumber)}</td>` : ''}
              <td>${esc(monthName(r.month))} ${r.year}</td>
              <td class="num">${esc(fmtCurrency(r.totalAmount))}</td>
              <td class="muted">${esc(r.issuedAt ? new Date(r.issuedAt).toLocaleDateString('he-IL') : '—')}</td>
              <td class="actions"><button class="btn btn--sm" data-act="open-rcp" data-id="${esc(r.id)}">${Icon.download} ${esc(t('receipts.history.download'))}</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `);
  c.querySelectorAll('[data-act="open-rcp"]').forEach(b => b.addEventListener('click', () => {
    openReceiptWindow({ id: b.dataset.id });
  }));
}
