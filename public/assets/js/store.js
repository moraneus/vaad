// Compatibility wrapper around api.js — preserves the synchronous read API
// that views depend on, exposes async mutators that hit the server and refresh
// the local cache.

import { api, getCache, getSession as _getSession, getSettings as _getSettings, getApartments, getPayments, getExpenses, getExpensePayments, getContacts, getDocuments, getReminders, getAdjustments, getAdjustmentPayments, getFeeOverrides, getOwners, getInfrastructureExpenses, getInfrastructureDemands, getInfrastructurePayments, getVaadMembers, refreshAll, refreshSession, subscribe } from './api.js';

export { subscribe, refreshAll, refreshSession };
export const getSession = _getSession;
export const getSettings = _getSettings;
export { getApartments, getPayments, getExpenses, getExpensePayments, getContacts, getDocuments, getReminders, getAdjustments, getAdjustmentPayments, getFeeOverrides, getOwners, getInfrastructureExpenses, getInfrastructureDemands, getInfrastructurePayments, getVaadMembers };

// Read-only helpers
export const getDocument = (id) => getDocuments().find(d => d.id === id);
export const getAuditLog = () => getCache().audit || [];

// ---- Apartments ----
export async function upsertApartment(apt) {
  const saved = apt.id ? await api.updateApartment(apt.id, apt) : await api.createApartment(apt);
  await refreshAll();
  return saved;
}
// Returns the API response so callers can detect an orphaned owner and
// optionally offer to delete them.
export async function deleteApartmentWithResult(id) {
  const res = await api.deleteApartment(id);
  await refreshAll();
  return res;
}
export async function deleteApartment(id) {
  await api.deleteApartment(id);
  await refreshAll();
}

// ---- Payments ----
export async function upsertPayment(p) {
  if (p.id) await api.updatePayment(p.id, p);
  else await api.createPayment(p);
  await refreshAll();
}
export async function deletePayment(id) {
  await api.deletePayment(id);
  await refreshAll();
}

// ---- Expenses ----
export async function upsertExpense(e) {
  const res = e.id ? await api.updateExpense(e.id, e) : await api.createExpense(e);
  await refreshAll();
  return res;
}
export async function deleteExpense(id) {
  await api.deleteExpense(id);
  await refreshAll();
}
export async function addExpenseRate(expenseId, { from, amount }) {
  await api.addExpenseRate({ expenseId, effectiveFrom: from, amount });
  await refreshAll();
}
export async function upsertExpensePayment(p) {
  if (p.id) await api.updateExpensePayment(p.id, p);
  else await api.createExpensePayment(p);
  await refreshAll();
}
export async function deleteExpensePayment(id) {
  await api.deleteExpensePayment(id);
  await refreshAll();
}
export async function removeExpenseRate(expenseId, rateId) {
  try { await api.deleteExpenseRate(rateId); await refreshAll(); return true; }
  catch { return false; }
}

// ---- Contacts ----
export async function upsertContact(c) {
  const res = c.id ? await api.updateContact(c.id, c) : await api.createContact(c);
  await refreshAll();
  return res;
}
export async function deleteContact(id) {
  await api.deleteContact(id);
  await refreshAll();
}

// ---- Documents ----
export async function uploadDocument(file, target = null, displayName = null) {
  const res = await api.uploadDocument(file, target, displayName);
  await refreshAll();
  return res.id;
}
export async function deleteDocument(id) {
  await api.deleteDocument(id);
  await refreshAll();
}
export async function attachDocument(target, refId, docId) {
  await api.attachDocument(docId, target, refId);
  await refreshAll();
}
export async function detachDocument(target, refId, docId) {
  await api.detachDocument(docId, target, refId);
  await refreshAll();
}

// ---- Settings ----
export async function updateSettingsBasic(payload) {
  await api.updateSettings(payload);
  await refreshAll();
}
export async function addApartmentCountEntry({ from, count }) {
  await api.saveCountHistory({ effectiveFrom: from, count });
  await refreshAll();
}
export async function updateApartmentCountEntry(id, patch) {
  await api.saveCountHistory({ id, effectiveFrom: patch.from, count: patch.count });
  await refreshAll();
}
export async function removeApartmentCountEntry(id) {
  try { await api.deleteCountHistory(id); await refreshAll(); return true; }
  catch { return false; }
}
export async function addMonthlyFeeEntry({ from, amount }) {
  await api.saveFeeHistory({ effectiveFrom: from, amount });
  await refreshAll();
}
export async function updateMonthlyFeeEntry(id, patch) {
  await api.saveFeeHistory({ id, effectiveFrom: patch.from, amount: patch.amount });
  await refreshAll();
}
export async function removeMonthlyFeeEntry(id) {
  try { await api.deleteFeeHistory(id); await refreshAll(); return true; }
  catch { return false; }
}

// ---- Auth helpers ----
export async function changeAdminPassword(currentPassword, newPassword) {
  await api.changePassword({ kind: 'admin', currentPassword, newPassword });
}
export async function changeTenantPassword(currentPassword, newPassword) {
  await api.changePassword({ kind: 'tenant', currentPassword, newPassword });
}
// Returns the API response so callers can show the initialPassword once.
export async function adminResetApartmentPassword(apartmentId, optsOrUserKind = 'tenant') {
  const opts = typeof optsOrUserKind === 'string' ? { userKind: optsOrUserKind } : optsOrUserKind;
  const res = await api.resetApartment(apartmentId, opts);
  await refreshAll();
  return res;
}
// Reset (or set custom) password for an owner. Returns the response so the
// caller can display the new initialPassword.
export async function adminResetOwnerPassword(ownerId, newPassword = null) {
  const res = await api.resetOwnerPassword(ownerId, newPassword);
  await refreshAll();
  return res;
}
export async function grantApartmentAdmin(apartmentId) {
  await api.grantApartmentAdmin(apartmentId);
  await refreshAll();
}
export async function revokeApartmentAdmin(apartmentId) {
  await api.revokeApartmentAdmin(apartmentId);
  await refreshAll();
}
export async function grantOwnerAdmin(ownerId) {
  await api.grantOwnerAdmin(ownerId);
  await refreshAll();
}
export async function revokeOwnerAdmin(ownerId) {
  await api.revokeOwnerAdmin(ownerId);
  await refreshAll();
}

// ---- Reminders ----
export async function upsertReminder(r) {
  const res = r.id ? await api.updateReminder(r.id, r) : await api.createReminder(r);
  await refreshAll();
  return res;
}
export async function deleteReminder(id) {
  await api.deleteReminder(id);
  await refreshAll();
}
export async function acknowledgeReminder(id) {
  await api.acknowledgeReminder(id);
  await refreshAll();
}
export async function unacknowledgeReminder(id) {
  await api.unacknowledgeReminder(id);
  await refreshAll();
}

// ---- Apartment adjustments (charges/credits) ----
export async function createAdjustment(payload) {
  const res = await api.createAdjustment(payload);
  await refreshAll();
  return res;
}
export async function deleteAdjustment(id) {
  await api.deleteAdjustment(id);
  await refreshAll();
}

// ---- Adjustment payments (payments toward a specific charge) ----
export async function createAdjustmentPayment(payload) {
  const res = await api.createAdjustmentPayment(payload);
  await refreshAll();
  return res;
}
export async function deleteAdjustmentPayment(id) {
  await api.deleteAdjustmentPayment(id);
  await refreshAll();
}

// ---- Owners (PR E) ----
export async function createOwner(payload) {
  const res = await api.createOwner(payload);
  await refreshAll();
  return res;
}
export async function updateOwner(id, payload) {
  const res = await api.updateOwner(id, payload);
  await refreshAll();
  return res;
}
export async function deleteOwner(id) {
  await api.deleteOwner(id);
  await refreshAll();
}

// ---- Per-apartment per-month fee overrides ----
export async function setFeeOverride({ apartmentId, year, month, amount, notes }) {
  const res = await api.setFeeOverride({ apartmentId, year, month, amount, notes });
  await refreshAll();
  return res;
}
export async function clearFeeOverride({ apartmentId, year, month }) {
  await api.clearFeeOverride({ apartmentId, year, month });
  await refreshAll();
}

// ---- Infrastructure expenses (capital-style) ----
export async function createInfrastructureExpense(payload) {
  const res = await api.createInfrastructureExpense(payload);
  await refreshAll();
  return res;
}
export async function updateInfrastructureExpense(id, payload) {
  const res = await api.updateInfrastructureExpense(id, payload);
  await refreshAll();
  return res;
}
export async function deleteInfrastructureExpense(id) {
  await api.deleteInfrastructureExpense(id);
  await refreshAll();
}
export async function updateInfrastructureDemand(id, payload) {
  const res = await api.updateInfrastructureDemand(id, payload);
  await refreshAll();
  return res;
}
export async function createInfrastructurePayment(payload) {
  const res = await api.createInfrastructurePayment(payload);
  await refreshAll();
  return res;
}
export async function deleteInfrastructurePayment(id) {
  await api.deleteInfrastructurePayment(id);
  await refreshAll();
}

// ---- Receipts ----
export async function createReceipt(payload) {
  const res = await api.createReceipt(payload);
  return res;
}
export async function fetchReceipt(id) {
  return api.getReceipt(id);
}
export async function fetchReceipts(apartmentId) {
  const res = await api.receipts(apartmentId);
  return res?.receipts || [];
}

// ---- Vaad (committee) members ----
export async function upsertVaadMember(m) {
  const res = m.id ? await api.updateVaadMember(m.id, m) : await api.createVaadMember(m);
  await refreshAll();
  return res;
}
export async function deleteVaadMember(id) {
  await api.deleteVaadMember(id);
  await refreshAll();
}

// ---- System ----
export async function resetAll() { await api.resetSystem(); await refreshAll(); await refreshSession(); }
export async function logout() { await api.logout(); await refreshSession(); }

// Audit log loader (admin only)
export async function loadAuditLog(limit = 100) {
  try {
    const r = await api.audit(limit);
    getCache().audit = r.entries || [];
  } catch {
    getCache().audit = [];
  }
}
export async function clearAuditLog() {
  await api.clearAudit();
  getCache().audit = [];
}

// Snapshot of the in-memory cache as JSON — used by Settings → Backup → Export.
// Document binaries are not included (they live in Drive); only metadata is exported.
export const exportJSON = async () => {
  const c = getCache();
  return JSON.stringify({
    version: 1,
    settings: c.settings,
    apartments: c.apartments,
    payments: c.payments,
    expenses: c.expenses,
    contacts: c.contacts,
    documents: c.documents.map(({ ...d }) => d),
    exportedAt: new Date().toISOString(),
  }, null, 2);
};
