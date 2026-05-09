// Bootstrap — entry point for the SPA. Loads session, routes views, refreshes cache.

import { refreshSession, refreshAll, getSession, getCache, subscribe } from './api.js';
import { renderShell, attachShellHandlers, toast, maybeShowLoginRemindersModal } from './ui.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderApartments } from './views/apartments.js';
import { renderOwners } from './views/owners.js';
import { renderIncome } from './views/income.js';
import { renderExpenses } from './views/expenses.js';
import { renderInfrastructure } from './views/infrastructure.js';
import { renderContacts } from './views/contacts.js';
import { renderDocuments } from './views/documents.js';
import { renderReminders } from './views/reminders.js';
import { renderReports } from './views/reports.js';
import { renderAbout } from './views/about.js';
import { renderSettings } from './views/settings.js';

const ROUTES = {
  dashboard: renderDashboard,
  apartments: renderApartments,
  owners: renderOwners,
  income: renderIncome,
  expenses: renderExpenses,
  infrastructure: renderInfrastructure,
  contacts: renderContacts,
  documents: renderDocuments,
  reminders: renderReminders,
  reports: renderReports,
  about: renderAbout,
  settings: renderSettings,
};

// Routes that a tenant (non-admin) is allowed to open. Anything else routes
// back to the dashboard, even if the user pasted an admin-only URL hash.
const TENANT_ROUTES = new Set(['dashboard', 'income', 'expenses', 'infrastructure', 'reports', 'about', 'settings']);

function isRouteAllowed(route) {
  if (!ROUTES[route]) return false;
  const role = getSession().role;
  if (role === 'admin') return true;
  return TENANT_ROUTES.has(route);
}

let currentRoute = 'dashboard';

function navigate(route) {
  if (!isRouteAllowed(route)) route = 'dashboard';
  currentRoute = route;
  if (location.hash !== `#${route}`) location.hash = route;
  renderApp();
}

async function renderApp() {
  const session = getSession();
  if (!session.loggedIn) {
    await renderLogin(async () => {
      const initial = (location.hash || '#dashboard').slice(1);
      navigate(initial in ROUTES ? initial : 'dashboard');
      // Show reminders modal after a fresh login as well.
      maybeShowLoginRemindersModal(navigate);
    });
    return;
  }
  const root = document.getElementById('app');
  root.innerHTML = renderShell(currentRoute);
  attachShellHandlers(navigate);
  try {
    const result = ROUTES[currentRoute]();
    if (result && typeof result.catch === 'function') result.catch(err => toast(err.message || 'שגיאה', 'danger'));
  } catch (err) {
    toast(err.message || 'שגיאת תצוגה', 'danger');
  }
  document.getElementById('app-sidebar')?.classList.remove('app-sidebar--open');
  document.getElementById('scrim')?.classList.remove('scrim--show');
}

window.addEventListener('hashchange', () => {
  const route = location.hash.slice(1);
  if (route in ROUTES) navigate(route);
});

// Boot
(async () => {
  await refreshSession();
  if (getSession().loggedIn) await refreshAll();
  const initial = (location.hash || '#dashboard').slice(1);
  currentRoute = isRouteAllowed(initial) ? initial : 'dashboard';
  await renderApp();
  // Show "you have N active reminders" modal once per session, after first render.
  if (getSession().loggedIn) maybeShowLoginRemindersModal(navigate);
})();

// Re-render current view when cache changes (mutations)
subscribe(() => {
  if (!getSession().loggedIn) return;
  // Rerender silently — most views are idempotent
});

window.__VAAD__ = { refreshAll, refreshSession, getCache };
