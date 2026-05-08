// Standalone Cloudflare Worker that fires once a month and triggers the
// monthly-report endpoint on the Pages deployment.
//
// Why a separate worker?  Cloudflare Pages Functions don't support scheduled
// triggers — only standalone Workers do.  This worker has its own deployment
// (see worker/wrangler.toml) and shares the same D1 binding so it can call
// the report endpoint authenticated with a shared secret.
//
// Two integration options:
//   1. Worker calls the Pages /api/admin/monthly-report endpoint with a
//      shared CRON_SECRET header. Pages function checks the header.
//   2. Worker has the D1 binding directly and runs the report logic inline.
//
// Option 1 keeps the "send report" logic single-source-of-truth on the Pages
// side. We use it.

export default {
  async scheduled(event, env, ctx) {
    if (!env.PAGES_ORIGIN || !env.CRON_SECRET) {
      console.log('Cron Worker missing PAGES_ORIGIN or CRON_SECRET env. Skipping.');
      return;
    }
    try {
      const res = await fetch(`${env.PAGES_ORIGIN}/api/admin/monthly-report-cron`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cron-secret': env.CRON_SECRET,
        },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      console.log(`Monthly report cron: ${res.status} — ${text.slice(0, 200)}`);
    } catch (err) {
      console.error('Monthly report cron failed:', err);
    }
  },

  // Allow a manual GET trigger for testing (with the same shared secret).
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run' || request.headers.get('x-cron-secret') !== env.CRON_SECRET) {
      return new Response('Not found', { status: 404 });
    }
    if (!env.PAGES_ORIGIN) return new Response('PAGES_ORIGIN not set', { status: 500 });
    const res = await fetch(`${env.PAGES_ORIGIN}/api/admin/monthly-report-cron`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cron-secret': env.CRON_SECRET },
      body: JSON.stringify({}),
    });
    return new Response(await res.text(), { status: res.status });
  },
};
