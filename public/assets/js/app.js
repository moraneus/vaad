// Bootstrap — entry point for the SPA. Loads session, routes views, refreshes cache.

import { refreshSession, refreshAll, getSession, getCache, subscribe, api } from './api.js';
import { renderShell, attachShellHandlers, toast, maybeShowLoginRemindersModal } from './ui.js';
import { t } from './i18n.js';
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
import { renderTickets } from './views/tickets.js';
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
  tickets: renderTickets,
  reports: renderReports,
  about: renderAbout,
  settings: renderSettings,
};

// Routes that a tenant (non-admin) is allowed to open. Anything else routes
// back to the dashboard, even if the user pasted an admin-only URL hash.
const TENANT_ROUTES = new Set(['dashboard', 'income', 'expenses', 'infrastructure', 'tickets', 'reports', 'about', 'settings']);

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
  // Compare only the route portion so `#contacts?id=ct-abc` doesn't get
  // rewritten to `#contacts` (which would strip the query string the
  // destination view wants to read).
  if (routeFromHash(location.hash) !== route) location.hash = route;
  renderApp();
}

async function renderApp() {
  const session = getSession();
  if (!session.loggedIn) {
    await renderLogin(async () => {
      const initial = routeFromHash(location.hash) || 'dashboard';
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

// A hash like `#contacts?id=ct-abc` is parsed as route="contacts" plus query
// args that the destination view can read off `location.hash`. The route
// match must ignore everything after the first `?`.
function routeFromHash(hash) {
  return (hash || '').replace(/^#/, '').split('?')[0];
}

window.addEventListener('hashchange', () => {
  const route = routeFromHash(location.hash);
  if (route in ROUTES) navigate(route);
});

// ---- Live ticket notifier (admin only) ----
// Polls /api/tickets/unread-count every 20 seconds. When the count increases
// mid-session (a tenant/owner opened a new ticket while the admin was logged
// in), surface a toast with a button that jumps to the tickets view. The
// view's mark-seen call resets the counter once the admin looks at it.
let ticketPollHandle = null;
let lastTicketCount = -1;
function startTicketNotifier() {
  if (ticketPollHandle) return;
  const poll = async () => {
    try {
      const sess = getSession();
      if (!sess.loggedIn || sess.role !== 'admin') return;
      const { count } = await api.ticketsUnreadCount();
      // The first tick after login establishes the baseline silently so we
      // don't trigger a toast on routine page loads.
      if (lastTicketCount === -1) { lastTicketCount = count; return; }
      if (count > lastTicketCount) {
        const delta = count - lastTicketCount;
        // Refresh the cached tickets list so the view shows the new rows
        // when the admin clicks through. Fire-and-forget so toast lands
        // immediately.
        refreshAll().catch(() => {});
        toast(t('tickets.unreadToast', { n: delta }), 'info');
      }
      lastTicketCount = count;
    } catch { /* network blip — try again next tick */ }
  };
  // First tick immediate (sets baseline) and then every 20s.
  poll();
  ticketPollHandle = setInterval(poll, 20_000);
}

// Boot
(async () => {
  await refreshSession();
  if (getSession().loggedIn) await refreshAll();
  const initial = routeFromHash(location.hash) || 'dashboard';
  currentRoute = isRouteAllowed(initial) ? initial : 'dashboard';
  await renderApp();
  // Show "you have N active reminders" modal once per session, after first render.
  if (getSession().loggedIn) maybeShowLoginRemindersModal(navigate);
  if (getSession().role === 'admin') startTicketNotifier();
})();

// Re-render current view when cache changes (mutations)
subscribe(() => {
  if (!getSession().loggedIn) return;
  // Rerender silently — most views are idempotent
});

window.__VAAD__ = { refreshAll, refreshSession, getCache };
