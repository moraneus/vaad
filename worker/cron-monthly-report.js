// Standalone Cloudflare Worker that fires once a month and triggers two
// monthly housekeeping endpoints on the Pages deployment:
//
//   1. /api/admin/auto-extend-monthly-cron  — pushes monthly-expense
//      end_dates forward by one month for opt-in rows. Runs FIRST so the
//      report (next step) reflects the freshly-extended date range.
//   2. /api/admin/monthly-report-cron       — generates + sends the monthly
//      PDF report email to subscribed residents.
//
// Why a separate worker?  Cloudflare Pages Functions don't support scheduled
// triggers — only standalone Workers do.  This worker has its own deployment
// (see worker/wrangler.toml) and authenticates to Pages with a shared secret.
//
// Failures in step 1 don't block step 2 — auto-extend is best-effort and the
// monthly report is a separate concern.

async function callPages(env, path) {
  if (!env.PAGES_ORIGIN || !env.CRON_SECRET) {
    console.log(`${path}: missing PAGES_ORIGIN or CRON_SECRET — skipping.`);
    return { status: 0, body: 'skipped' };
  }
  try {
    const res = await fetch(`${env.PAGES_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cron-secret': env.CRON_SECRET },
      body: JSON.stringify({}),
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch (err) {
    console.error(`${path} fetch failed:`, err);
    return { status: 0, body: String(err?.message || err) };
  }
}

export default {
  async scheduled(event, env, ctx) {
    const ext = await callPages(env, '/api/admin/auto-extend-monthly-cron');
    console.log(`Auto-extend cron: ${ext.status} — ${ext.body.slice(0, 200)}`);
    const rep = await callPages(env, '/api/admin/monthly-report-cron');
    console.log(`Monthly report cron: ${rep.status} — ${rep.body.slice(0, 200)}`);
  },

  // Allow a manual GET trigger for testing (with the same shared secret).
  // /run        → both endpoints (same as the schedule)
  // /run-extend → only the auto-extend endpoint (useful when verifying that
  //               flow alone)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get('x-cron-secret') !== env.CRON_SECRET) {
      return new Response('Not found', { status: 404 });
    }
    if (!env.PAGES_ORIGIN) return new Response('PAGES_ORIGIN not set', { status: 500 });
    if (url.pathname === '/run-extend') {
      const r = await callPages(env, '/api/admin/auto-extend-monthly-cron');
      return new Response(r.body, { status: r.status || 502 });
    }
    if (url.pathname === '/run') {
      const ext = await callPages(env, '/api/admin/auto-extend-monthly-cron');
      const rep = await callPages(env, '/api/admin/monthly-report-cron');
      return new Response(JSON.stringify({ extend: ext, report: rep }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
};
