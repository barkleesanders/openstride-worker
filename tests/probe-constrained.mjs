// Constrained-browser probe for openstride.barkleesanders.com (Pattern 43, /ship silent-outcome gate,
// added 2026-09-20 HOME-ce2un). Drives the PUBLIC surface in a headless Chromium
// with NO WebGL and NO geolocation (a datacentre VM agent), auto-dismisses native
// dialogs, intercepts every same-origin POST matching INTERCEPT (nothing costly is
// ever sent), stops at the origin boundary (a direct off-origin request is aborted; a
// redirect chain that leaves the origin — OAuth, Cloudflare Access — is recorded by
// where the page landed and never signed in), taps each primary-action control and
// records what the page did. A tap that neither POSTs, nor leaves the origin, nor
// changes something visible is the silent class this probe exists for.
// Public surface: the landing page only. Every form (plan builder, calendar, proposals)
// lives under /app, which Cloudflare Access gates (src/access.ts validates the
// Cf-Access-Jwt-Assertion; there is no local bypass), so an anonymous VM agent can only
// reach the CTA. The CTA's outcome is the hop to esbe.cloudflareaccess.com, recorded here.
// Needs Playwright (not a dependency of this repo): from a checkout that has it,
//   ln -s /path/with/node_modules tests/node_modules   (gitignored)
//   npm run dev                                         # wrangler dev on :8787
//   ASSERT=1 node tests/probe-constrained.mjs probe
// Env: PROBE_URL=<origin> — default http://localhost:8787 (the local candidate; an
//      empty PROBE_URL means the same); ASSERT=1 to exit non-zero on the first
//      silent tap or any native dialog. This is what `npm run probe:constrained` runs.
// Output: probe-<run>.json + .png beside the script. Exit 2 = UNMEASURED (origin down).
import fs from 'node:fs';
import { chromium } from 'playwright';

const RUN = process.argv[3] || '1';
const OUT = new URL(`./probe-${RUN}`, import.meta.url).pathname;
const ORIGIN = new URL(process.env.PROBE_URL || 'http://localhost:8787').origin;
/** Same-origin POST paths that are never allowed through (cost or side effects). */
const INTERCEPT = /^\/api\//;

const alive = await fetch(`${ORIGIN}/`, { method: 'HEAD' }).then(
  (r) => r.status < 500,
  () => false,
);

if (!alive) {
  console.error(
    `PROBE UNMEASURED: ${ORIGIN} is not serving / (start \`npm run dev\` or set PROBE_URL)`,
  );
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-gpu',
    '--disable-webgl',
    '--disable-webgl2',
    '--disable-3d-apis',
    '--use-gl=disabled',
    '--disable-software-rasterizer',
  ],
});

// No geolocation grant, no GPS: what a VM agent has.
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 openstride-probe',
});

const log = { dialogs: [], console: [], posts: [], popups: [], choosers: [], offsite: [] };
const page = await ctx.newPage();

page.on('dialog', async (d) => {
  log.dialogs.push({ type: d.type(), message: d.message(), t: Date.now() });
  await d.dismiss();
});
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type()))
    log.console.push({ type: m.type(), text: m.text().slice(0, 300) });
});
page.on('pageerror', (e) => log.console.push({ type: 'pageerror', text: String(e).slice(0, 300) }));
page.on('popup', (p) => log.popups.push(p.url()));
page.on('filechooser', (fc) => log.choosers.push({ t: Date.now(), multiple: fc.isMultiple() }));

await ctx.route('**/*', async (route) => {
  const req = route.request();
  const url = new URL(req.url());

  // Leaving the origin (OAuth, Cloudflare Access) is a visible outcome of the tap;
  // record the hop and stop there — never sign anything in. Playwright does not route
  // the redirect-followed hop itself, so tap() also reads where the page landed.
  if (url.origin !== ORIGIN) {
    if (req.isNavigationRequest()) log.offsite.push({ url: req.url(), t: Date.now() });
    return route.abort('blockedbyclient');
  }

  if (req.method() === 'POST' && INTERCEPT.test(url.pathname)) {
    log.posts.push({ url: req.url(), t: Date.now(), bodyLen: (req.postData() || '').length });
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'PROBE_INTERCEPT' }),
    });
  }

  if (req.method() === 'POST') log.posts.push({ url: req.url(), t: Date.now(), passed: true });

  return route.continue();
});

const steps = [];
const taps = [];

/** Run one tap and record what changed while it ran. */
async function tap(label, act, visible) {
  const before = {
    dialogs: log.dialogs.length,
    posts: log.posts.length,
    popups: log.popups.length,
    choosers: log.choosers.length,
    offsite: log.offsite.length,
  };
  let failed = null;

  await act().catch((e) => {
    failed = e.message.split('\n')[0];
  });
  await page.waitForTimeout(2500);

  const s = {
    label,
    failed,
    visible: await visible().catch((e) => ({ reporterFailed: e.message.split('\n')[0] })),
    delta: {
      dialogs: log.dialogs.slice(before.dialogs),
      posts: log.posts.slice(before.posts),
      popups: log.popups.slice(before.popups),
      choosers: log.choosers.slice(before.choosers),
      offsite: log.offsite.slice(before.offsite),
      landed: new URL(page.url()).origin !== ORIGIN ? page.url() : null,
    },
  };

  steps.push(s);
  taps.push(s);

  return s;
}

async function open(path, expectSel) {
  await page.goto(`${ORIGIN}${path}`, { waitUntil: 'load', timeout: 60000 });
  steps.push({
    label: `loaded ${path}`,
    url: page.url(),
    webgl: await page.evaluate(() => {
      try {
        const c = document.createElement('canvas');

        return !!(c.getContext('webgl') || c.getContext('webgl2'));
      } catch {
        return false;
      }
    }),
    mounted: await page.evaluate((s) => !!document.querySelector(s), expectSel),
  });
}

// ---------------------------------------------------------------- scenarios
await open('/', 'a.button[href="/app/new"]');

await tap(
  'home-build-my-plan',
  () => page.click('a.button[href="/app/new"]', { timeout: 5000 }),
  async () => ({}),
);
// ---------------------------------------------------------------- report

await page.screenshot({ path: `${OUT}.png`, fullPage: true }).catch(() => {});
fs.writeFileSync(`${OUT}.json`, JSON.stringify({ log, steps }, null, 2));

const summary = taps.map((s) => ({
  tap: s.label,
  posts: s.delta.posts.map((p) => new URL(p.url).pathname),
  offsite: s.delta.offsite.map((o) => new URL(o.url).host),
  landed: s.delta.landed && new URL(s.delta.landed).host,
  choosers: s.delta.choosers.length,
  dialogs: s.delta.dialogs.length,
  visible: s.visible,
  failed: s.failed,
}));

console.log(
  JSON.stringify(
    {
      origin: ORIGIN,
      run: RUN,
      loaded: steps.filter((s) => s.mounted !== undefined),
      taps: summary,
    },
    null,
    1,
  ),
);

await browser.close();

// ASSERT mode: every tap must POST (intercepted or passed), OR leave the origin,
// OR open a chooser, OR change something visible. Never none. Zero native
// dialogs, zero popups, every page mounted its expected control.
if (process.env.ASSERT === '1') {
  const failures = [];

  for (const s of taps) {
    const posted = s.delta.posts.length > 0;
    const left = s.delta.offsite.length > 0 || !!s.delta.landed;
    const shown =
      s.delta.choosers.length > 0 ||
      (s.visible && !s.visible.reporterFailed && Object.values(s.visible).some(Boolean));

    if (!posted && !left && !shown)
      failures.push(`${s.label}: no POST, no navigation, nothing visible changed`);
  }

  for (const s of steps)
    if (s.mounted === false) failures.push(`${s.label}: expected control did not mount`);

  if (log.dialogs.length)
    failures.push(`native dialogs opened: ${log.dialogs.map((d) => d.type).join(',')}`);
  if (log.popups.length) failures.push(`popups opened: ${log.popups.join(',')}`);

  if (failures.length) {
    console.error(`SILENT-OUTCOME FAIL (${RUN}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }

  console.log(`SILENT-OUTCOME OK (${RUN}): ${summary.length} taps, 0 silent, 0 dialogs`);
}
