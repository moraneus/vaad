// Client-side API wrapper. All calls go to /api/*. Cookies handle auth.

const opts = (method, body, isForm = false) => ({
  method,
  credentials: 'same-origin',
  headers: isForm ? {} : { 'content-type': 'application/json' },
  body: body == null ? undefined : (isForm ? body : JSON.stringify(body)),
});

async function call(path, init) {
  const res = await fetch(path, init);
  let data = null;
  if (res.status !== 204 && res.headers.get('content-type')?.includes('application/json')) {
    try { data = await res.json(); } catch { /* ignore */ }
  }
  if (!res.ok) {
    const err = new Error(data?.error || `שגיאה (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  // Auth
  me: () => call('/api/auth/me'),
  login: (payload) => call('/api/auth/login', opts('POST', payload)),
  logout: () => call('/api/auth/logout', opts('POST', {})),
  changePassword: (payload) => call('/api/auth/change-password', opts('POST', payload)),
  resetApartment: (apartmentId) => call('/api/auth/reset-apartment', opts('POST', { apartmentId })),
  twoFAStatus: () => call('/api/auth/2fa-status'),
  twoFASetupInit: () => call('/api/auth/2fa-setup-init', opts('POST', {})),
  twoFASetupVerify: (payload) => call('/api/auth/2fa-setup-verify', opts('POST', payload)),
  twoFADisable: (payload) => call('/api/auth/2fa-disable', opts('POST', payload)),
  identityStatus: () => call('/api/auth/identity-status'),
  identityInit: (purpose) => call('/api/auth/identity-init', opts('POST', { purpose })),
  resetPassword: (payload) => call('/api/auth/reset-password', opts('POST', payload)),

  // Settings
  getSettings: () => call('/api/settings'),
  updateSettings: (payload) => call('/api/settings', opts('PUT', payload)),
  saveCountHistory: (payload) => call('/api/settings/count-history', opts('POST', payload)),
  deleteCountHistory: (id) => call(`/api/settings/count-history?id=${encodeURIComponent(id)}`, opts('DELETE')),
  saveFeeHistory: (payload) => call('/api/settings/fee-history', opts('POST', payload)),
  deleteFeeHistory: (id) => call(`/api/settings/fee-history?id=${encodeURIComponent(id)}`, opts('DELETE')),

  // Apartments
  apartments: () => call('/api/apartments'),
  createApartment: (payload) => call('/api/apartments', opts('POST', payload)),
  updateApartment: (id, payload) => call(`/api/apartments?id=${encodeURIComponent(id)}`, opts('PUT', payload)),
  deleteApartment: (id) => call(`/api/apartments?id=${encodeURIComponent(id)}`, opts('DELETE')),
  grantApartmentAdmin: (id) => call(`/api/apartment-admin?id=${encodeURIComponent(id)}`, opts('POST', {})),
  revokeApartmentAdmin: (id) => call(`/api/apartment-admin?id=${encodeURIComponent(id)}`, opts('DELETE')),

  // Payments
  payments: ({ apartmentId, year } = {}) => {
    const q = new URLSearchParams();
    if (apartmentId) q.set('apartmentId', apartmentId);
    if (year) q.set('year', year);
    const qs = q.toString();
    return call(`/api/payments${qs ? `?${qs}` : ''}`);
  },
  createPayment: (payload) => call('/api/payments', opts('POST', payload)),
  updatePayment: (id, payload) => call(`/api/payments?id=${encodeURIComponent(id)}`, opts('PUT', payload)),
  deletePayment: (id) => call(`/api/payments?id=${encodeURIComponent(id)}`, opts('DELETE')),

  // Expenses
  expenses: () => call('/api/expenses'),
  createExpense: (payload) => call('/api/expenses', opts('POST', payload)),
  updateExpense: (id, payload) => call(`/api/expenses?id=${encodeURIComponent(id)}`, opts('PUT', payload)),
  deleteExpense: (id) => call(`/api/expenses?id=${encodeURIComponent(id)}`, opts('DELETE')),
  addExpenseRate: (payload) => call('/api/expense-rates', opts('POST', payload)),
  deleteExpenseRate: (id) => call(`/api/expense-rates?id=${encodeURIComponent(id)}`, opts('DELETE')),
  expensePayments: ({ expenseId, year } = {}) => {
    const q = new URLSearchParams();
    if (expenseId) q.set('expenseId', expenseId);
    if (year) q.set('year', year);
    const qs = q.toString();
    return call(`/api/expense-payments${qs ? `?${qs}` : ''}`);
  },
  createExpensePayment: (payload) => call('/api/expense-payments', opts('POST', payload)),
  updateExpensePayment: (id, payload) => call(`/api/expense-payments?id=${encodeURIComponent(id)}`, opts('PUT', payload)),
  deleteExpensePayment: (id) => call(`/api/expense-payments?id=${encodeURIComponent(id)}`, opts('DELETE')),

  // Contacts
  contacts: () => call('/api/contacts'),
  createContact: (payload) => call('/api/contacts', opts('POST', payload)),
  updateContact: (id, payload) => call(`/api/contacts?id=${encodeURIComponent(id)}`, opts('PUT', payload)),
  deleteContact: (id) => call(`/api/contacts?id=${encodeURIComponent(id)}`, opts('DELETE')),

  // Documents
  documents: () => call('/api/documents'),
  uploadDocument: (file, target) => {
    const fd = new FormData();
    fd.append('file', file);
    if (target) { fd.append('targetType', target.type); fd.append('targetId', target.id); }
    return call('/api/documents', opts('POST', fd, true));
  },
  deleteDocument: (id) => call(`/api/documents/${encodeURIComponent(id)}`, opts('DELETE')),
  documentURL: (id) => `/api/documents/${encodeURIComponent(id)}`,
  attachDocument: (documentId, type, targetId) => call('/api/document-links', opts('POST', { documentId, targetType: type, targetId })),
  detachDocument: (documentId, type, targetId) => call(`/api/document-links?documentId=${encodeURIComponent(documentId)}&targetType=${type}&targetId=${encodeURIComponent(targetId)}`, opts('DELETE')),

  // Reminders
  reminders: () => call('/api/reminders'),
  createReminder: (payload) => call('/api/reminders', opts('POST', payload)),
  updateReminder: (id, payload) => call(`/api/reminders?id=${encodeURIComponent(id)}`, opts('PUT', payload)),
  acknowledgeReminder: (id) => call(`/api/reminders?id=${encodeURIComponent(id)}&action=acknowledge`, opts('PUT', {})),
  unacknowledgeReminder: (id) => call(`/api/reminders?id=${encodeURIComponent(id)}&action=unacknowledge`, opts('PUT', {})),
  deleteReminder: (id) => call(`/api/reminders?id=${encodeURIComponent(id)}`, opts('DELETE')),

  // Apartment adjustments
  adjustments: (apartmentId) => {
    const qs = apartmentId ? `?apartmentId=${encodeURIComponent(apartmentId)}` : '';
    return call(`/api/apartment-adjustments${qs}`);
  },
  createAdjustment: (payload) => call('/api/apartment-adjustments', opts('POST', payload)),
  deleteAdjustment: (id) => call(`/api/apartment-adjustments?id=${encodeURIComponent(id)}`, opts('DELETE')),

  // Per-apartment per-month fee overrides
  feeOverrides: (apartmentId) => {
    const qs = apartmentId ? `?apartmentId=${encodeURIComponent(apartmentId)}` : '';
    return call(`/api/apartment-fee-overrides${qs}`);
  },
  setFeeOverride: (payload) => call('/api/apartment-fee-overrides', opts('PUT', payload)),
  clearFeeOverride: ({ apartmentId, year, month }) =>
    call(`/api/apartment-fee-overrides?apartmentId=${encodeURIComponent(apartmentId)}&year=${year}&month=${month}`, opts('DELETE')),

  // Payments against a specific charge (apartment adjustment)
  adjustmentPayments: (adjustmentId) => {
    const qs = adjustmentId ? `?adjustmentId=${encodeURIComponent(adjustmentId)}` : '';
    return call(`/api/adjustment-payments${qs}`);
  },
  createAdjustmentPayment: (payload) => call('/api/adjustment-payments', opts('POST', payload)),
  deleteAdjustmentPayment: (id) => call(`/api/adjustment-payments?id=${encodeURIComponent(id)}`, opts('DELETE')),

  // Receipts
  receipts: (apartmentId) => {
    const qs = apartmentId ? `?apartmentId=${encodeURIComponent(apartmentId)}` : '';
    return call(`/api/receipts${qs}`);
  },
  getReceipt: (id) => call(`/api/receipts?id=${encodeURIComponent(id)}`),
  createReceipt: (payload) => call('/api/receipts', opts('POST', payload)),

  // Vaad (committee) members
  vaadMembers: () => call('/api/vaad-members'),
  createVaadMember: (payload) => call('/api/vaad-members', opts('POST', payload)),
  updateVaadMember: (id, payload) => call(`/api/vaad-members?id=${encodeURIComponent(id)}`, opts('PUT', payload)),
  deleteVaadMember: (id) => call(`/api/vaad-members?id=${encodeURIComponent(id)}`, opts('DELETE')),

  // Audit
  audit: (limit = 100) => call(`/api/audit?limit=${limit}`),
  clearAudit: () => call('/api/audit', opts('DELETE')),

  // Google Drive
  driveStatus: () => call('/api/drive/status'),
  driveAuthInit: () => call('/api/drive/auth-init', opts('POST', {})),
  driveDisconnect: () => call('/api/drive/disconnect', opts('POST', {})),

  // Admin
  resetSystem: () => call('/api/admin/reset', opts('POST', { confirm: 'I-AGREE-TO-WIPE' })),

  // Apartment email opt-in
  apartmentEmail: (apartmentId) => call(`/api/apartment-email?apartmentId=${encodeURIComponent(apartmentId)}`),
  setApartmentEmail: (apartmentId, email) => call('/api/apartment-email', opts('POST', { apartmentId, email })),
  removeApartmentEmail: (apartmentId) => call(`/api/apartment-email?apartmentId=${encodeURIComponent(apartmentId)}`, opts('DELETE')),

  // Admin email features
  emailTest: (to) => call('/api/admin/email-test', opts('POST', { to })),
  emailBroadcast: (subject, message) => call('/api/admin/email-broadcast', opts('POST', { subject, message })),
  sendMonthlyReport: (year, month) => call('/api/admin/monthly-report', opts('POST', { year, month })),
};

// In-memory cached snapshot of all data, refreshed via api.refresh()
const cache = {
  session: null,
  settings: null,
  apartments: [],
  payments: [],
  expenses: [],
  expensePayments: [],
  contacts: [],
  documents: [],
  reminders: [],
  adjustments: [],
  adjustmentPayments: [],
  feeOverrides: [],
  vaadMembers: [],
};

const subscribers = new Set();
export const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
const notify = () => { for (const fn of subscribers) try { fn(); } catch (e) { console.error(e); } };

export const getCache = () => cache;

export async function refreshSession() {
  cache.session = await api.me().catch(() => ({ loggedIn: false }));
  notify();
  return cache.session;
}

export async function refreshAll() {
  if (!cache.session?.loggedIn) return;
  const [settings, apt, pay, exp, expPay, con, docs, rems, adj, adjPay, ov, vm] = await Promise.all([
    api.getSettings().catch(() => null),
    api.apartments().catch(() => ({ apartments: [] })),
    api.payments().catch(() => ({ payments: [] })),
    api.expenses().catch(() => ({ expenses: [] })),
    api.expensePayments().catch(() => ({ payments: [] })),
    api.contacts().catch(() => ({ contacts: [] })),
    api.documents().catch(() => ({ documents: [] })),
    api.reminders().catch(() => ({ reminders: [] })),
    api.adjustments().catch(() => ({ adjustments: [] })),
    api.adjustmentPayments().catch(() => ({ payments: [] })),
    api.feeOverrides().catch(() => ({ overrides: [] })),
    api.vaadMembers().catch(() => ({ members: [] })),
  ]);
  cache.settings = settings;
  cache.apartments = apt.apartments || [];
  cache.payments = pay.payments || [];
  cache.expenses = exp.expenses || [];
  cache.expensePayments = expPay.payments || [];
  cache.contacts = con.contacts || [];
  cache.documents = docs.documents || [];
  cache.reminders = rems.reminders || [];
  cache.adjustments = adj.adjustments || [];
  cache.adjustmentPayments = adjPay.payments || [];
  cache.feeOverrides = ov.overrides || [];
  cache.vaadMembers = vm.members || [];
  notify();
}

export const getSession = () => cache.session || { loggedIn: false };
export const getSettings = () => cache.settings || {};
export const getApartments = () => cache.apartments;
export const getPayments = () => cache.payments;
export const getExpenses = () => cache.expenses;
export const getContacts = () => cache.contacts;
export const getDocuments = () => cache.documents;
export const getExpensePayments = () => cache.expensePayments;
export const getReminders = () => cache.reminders;
export const getAdjustments = () => cache.adjustments;
export const getAdjustmentPayments = () => cache.adjustmentPayments;
export const getFeeOverrides = () => cache.feeOverrides;
export const getVaadMembers = () => cache.vaadMembers;
