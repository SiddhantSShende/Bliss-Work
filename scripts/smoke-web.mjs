/**
 * Does the deployed web app actually WORK — not merely answer 200.
 *
 *   node scripts/smoke-web.mjs https://app.example.com
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The deploy's smoke test used to be `curl https://$DOMAIN/`. That passed while
 * the app was completely broken, twice, for two different reasons:
 *
 *   1. A missing VITE_* build var made the bundle throw on boot. index.html was
 *      served, every asset was 200, and the first user got a blank page.
 *   2. index.html referenced a bundle that no longer existed on disk, so the
 *      HTML loaded and the JavaScript 404'd.
 *
 * A status code cannot see either. This runs three checks, cheapest first, and
 * each one catches a failure the one before it cannot:
 *
 *   A. index.html is served and looks like the app.
 *   B. Every asset it references resolves — catches a stale or half-published
 *      bundle (failure 2).
 *   C. The app BOOTS in a real browser with no uncaught error and renders
 *      something — catches failure 1, and anything else that only shows up when
 *      the JavaScript actually runs.
 *
 * Check C needs Playwright and a browser. Where they are absent it WARNS and
 * skips rather than failing: refusing to deploy because a CI image lacks
 * Chromium would be its own kind of broken. A and B always run and always gate.
 */
const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!base) {
  console.error("usage: node scripts/smoke-web.mjs https://your-domain");
  process.exit(2);
}

const TIMEOUT_MS = 20_000;
let failed = false;

const fail = (msg) => { console.error(`  ✗ ${msg}`); failed = true; };
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.warn(`  ! ${msg}`);

async function get(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctl.signal, redirect: "follow", ...opts });
  } finally {
    clearTimeout(t);
  }
}

// ── A. the shell ─────────────────────────────────────────────────────────────
// /app rather than /: the SPA entry is what users load, and on this deployment
// `/` may be a separate marketing site.
const appUrl = `${base}/app`;
let html = "";
try {
  const res = await get(appUrl);
  if (!res.ok) fail(`${appUrl} -> HTTP ${res.status}`);
  else {
    html = await res.text();
    if (!/<div id="root"|<script/i.test(html)) fail(`${appUrl} served no app shell`);
    else ok(`${appUrl} serves the app shell`);
  }
} catch (e) {
  fail(`${appUrl} unreachable: ${e.message}`);
}

// ── B. every referenced asset resolves ───────────────────────────────────────
// The failure this catches is asymmetric: the HTML is fresh (it is served
// no-cache precisely so it always is) while the bundle it names is gone.
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
if (html && assets.length === 0) {
  fail("the app shell references no /assets/* files — did the bundle publish?");
} else {
  for (const path of assets) {
    try {
      const res = await get(base + path, { method: "GET", headers: { range: "bytes=0-0" } });
      if (!res.ok && res.status !== 206) fail(`asset ${path} -> HTTP ${res.status}`);
      else ok(`asset ${path} resolves`);
    } catch (e) {
      fail(`asset ${path} unreachable: ${e.message}`);
    }
  }
}

// ── C. it boots ──────────────────────────────────────────────────────────────
let chromium = null;
try {
  ({ chromium } = await import("playwright"));
} catch {
  warn("playwright not installed — skipping the boot check (A and B still gated)");
}

if (chromium && !failed) {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    warn(`no browser available — skipping the boot check (${e.message.split("\n")[0]})`);
  }
  if (browser) {
    try {
      const page = await browser.newPage();
      const uncaught = [];
      page.on("pageerror", (e) => uncaught.push(String(e).split("\n")[0]));
      await page.goto(appUrl, { waitUntil: "networkidle", timeout: TIMEOUT_MS });
      // React needs a tick after the network settles to commit its first render.
      await page.waitForTimeout(2000);

      const rendered = await page.evaluate(() => {
        const r = document.getElementById("root");
        return r ? r.childElementCount : -1;
      });

      // An uncaught error is the exact signature of the boot failure that
      // shipped: "Missing required build-time env vars: VITE_TELEMETRY_BASE".
      if (uncaught.length) uncaught.forEach((u) => fail(`uncaught in the browser: ${u}`));
      else ok("no uncaught errors on boot");

      if (rendered < 0) fail("#root is missing from the page");
      else if (rendered === 0) fail("#root is empty — the app mounted nothing");
      else ok(`app rendered (#root has ${rendered} child element(s))`);
    } catch (e) {
      fail(`boot check failed: ${e.message.split("\n")[0]}`);
    } finally {
      await browser.close();
    }
  }
}

if (failed) {
  console.error("\nweb smoke test FAILED — the deployed app is not serving correctly.");
  process.exit(1);
}
console.log("\nweb smoke test passed.");
