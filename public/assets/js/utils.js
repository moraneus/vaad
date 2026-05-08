// General utilities — locale-aware formatters delegate to i18n.

import { fmtCurrency as _fmtCurrency, fmtNumber as _fmtNumber, fmtDate as _fmtDate, fmtMonth as _fmtMonth, fmtMonthShort as _fmtMonthShort, monthName, formatBytes as _formatBytes } from './i18n.js';

export const fmtCurrency = _fmtCurrency;
export const fmtNumber = _fmtNumber;
export const fmtDate = _fmtDate;
export const fmtMonth = _fmtMonth;
export const fmtMonthShort = _fmtMonthShort;
export const formatBytes = _formatBytes;

// Backwards-compat: name arrays (used in older callsites for indexed access)
export const HE_MONTHS = Array.from({ length: 12 }, (_, i) => monthName(i + 1));
export const HE_MONTHS_SHORT = Array.from({ length: 12 }, (_, i) => monthName(i + 1, true));

// Convert a Date or ISO string to YYYY-MM-DD (local)
export const toISODate = (d) => {
  const date = d instanceof Date ? d : new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// "YYYY-MM" helpers
export const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
export const parseMonthKey = (k) => {
  const [y, m] = k.split('-').map(Number);
  return { year: y, month: m };
};

// month in [start, end?] inclusive (string YYYY-MM-DD or YYYY-MM)
export const isMonthInRange = (year, month, startDate, endDate) => {
  const cur = year * 12 + (month - 1);
  if (startDate) {
    const s = new Date(startDate);
    const sIdx = s.getFullYear() * 12 + s.getMonth();
    if (cur < sIdx) return false;
  }
  if (endDate) {
    const e = new Date(endDate);
    const eIdx = e.getFullYear() * 12 + e.getMonth();
    if (cur > eIdx) return false;
  }
  return true;
};

// Iterate months between two dates inclusive (yields {year, month})
export function* iterMonths(startDate, endDate) {
  const s = new Date(startDate);
  const e = new Date(endDate);
  let y = s.getFullYear();
  let m = s.getMonth() + 1;
  const endY = e.getFullYear();
  const endM = e.getMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    yield { year: y, month: m };
    m++;
    if (m > 12) { m = 1; y++; }
  }
}

// Generate a UUID-ish id (no external dep)
export const uid = (prefix = '') => {
  const part = () => Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}-${part()}${part()}`.replace(/^-/, '');
};

// SHA-256 hash via Web Crypto. Note: for UX gating only — see README security notes.
export const sha256 = async (text) => {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
};

// HTML escape
export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Read the `from` (or `effectiveFrom`) date from a history entry.
const histFrom = (item) => item.from || item.effectiveFrom;

// Find the active value in a dated history list for a specific YYYY-MM.
// The most recent entry whose date is <= target is chosen.
export const valueAtMonth = (history, year, month) => {
  if (!history || !history.length) return null;
  const target = year * 12 + (month - 1);
  let best = null;
  for (const item of history) {
    const f = histFrom(item);
    if (!f) continue;
    const d = new Date(f);
    const idx = d.getFullYear() * 12 + d.getMonth();
    if (idx <= target && (!best || idx >= best.idx)) best = { idx, item };
  }
  if (!best) return null;
  return { ...best.item, from: histFrom(best.item) };
};

// Sort history ascending by date (supports `from` or `effectiveFrom`)
export const sortHistory = (history) => [...history].sort((a, b) => {
  const af = histFrom(a) || ''; const bf = histFrom(b) || '';
  return af < bf ? -1 : af > bf ? 1 : 0;
});

// Download Blob as file
export const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
};

// Read File as Base64 data URL
export const fileToDataURL = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

export const todayISO = () => toISODate(new Date());

// Current YYYY-MM
export const currentMonthKey = () => {
  const d = new Date();
  return monthKey(d.getFullYear(), d.getMonth() + 1);
};

// Add months to a Date
export const addMonths = (date, n) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
};

// Compare YYYY-MM[-DD] strings
export const cmpDateStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Clone deep (structuredClone fallback)
export const deepClone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
