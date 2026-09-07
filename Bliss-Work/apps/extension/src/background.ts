/**
 * MV3 service worker: watch the active tab, batch spans, post them.
 *
 * Everything here is written for a worker that WILL be killed. MV3 terminates
 * an idle service worker after ~30s, so:
 *
 *   * no long-lived timers — `chrome.alarms` survives termination, `setInterval`
 *     does not;
 *   * no in-memory queue as the source of truth — the open span and the pending
 *     batch live in `chrome.storage.session`, which survives a worker restart
 *     within the browser session;
 *   * every entry point re-reads its state rather than assuming module scope
 *     still holds what it held a minute ago.
 *
 * The decisions about WHAT may be recorded live in tracker.ts, deliberately free
 * of `chrome.*` so they can be tested.
 */
import { recordableSite, selfDomain, SELF, toAgentEvent, toVisit, type Candidate } from "./tracker";
import { provisionToken } from "./provisioning";

/**
 * Which browser this build reports as, for `detail.browser`.
 *
 * Injected by esbuild's `define` at BUILD time (see build.mjs's `--target`
 * flag), never sniffed from a user agent or feature-detected at runtime — a
 * build's own identity is a fact the build process already knows, and
 * runtime sniffing is the kind of thing that quietly drifts (a new Chromium
 * fork ships, the UA string changes format, an extension update lags a
 * rename) in a way a compile-time constant cannot. `__BROWSER__` is replaced
 * with a literal string during bundling; there is no such global at runtime,
 * so running this file un-bundled (e.g. under vitest) would throw — which is
 * why background.ts itself is never imported directly by a test, only
 * tracker.ts and siteEnrichment.ts are (see their own "free of chrome.*"
 * docblocks). Defaults to "chrome" only via build.mjs's own `--target`
 * default, not via a runtime fallback in this file.
 */
declare const __BROWSER__: string;
const BROWSER = __BROWSER__;

const FLUSH_ALARM = "blisswork-flush";
const FLUSH_MINUTES = 1;
const MAX_QUEUED = 300;
/** Chrome's own idle detector. Time with the machine locked is not browsing. */
const IDLE_SECONDS = 300;

interface OpenSpan {
  url: string;
  incognito: boolean;
  startedAt: number;
  /**
   * The site the user was on immediately before this one — a registrable
   * domain, or the BlissWork marker. Absent when this is the first span of the
   * session, or when the previous site was one that may not be recorded.
   *
   * Stored on the span rather than recomputed at close time because by then the
   * previous tab's URL is gone: `chrome.storage.session` holds one open span,
   * and MV3 kills the worker between events, so anything not written down here
   * does not survive to the moment the row is built.
   */
  from?: string;
  /**
   * The tab's title, refreshed on every event that touches this span (a title
   * that changes without a URL change — a SPA setting `document.title`, a page
   * finishing its load — updates this in place rather than waiting for the
   * next navigation). What closeSpan reports is therefore the freshest title
   * seen while the span was open, not necessarily the one present at the very
   * first moment it opened.
   */
  title?: string;
}

interface Config {
  token?: string;
  apiBase?: string;
  paused?: boolean;
  blocked?: string[];
  /** Drop the sensitive-category floor. Per-DEVICE only (read from local storage,
   *  never from managed policy) and OFF unless explicitly set — so the aggressive
   *  mode cannot be pushed to a fleet, and the shipped default protects
   *  health/finance/gov/legal browsing. */
  captureAll?: boolean;
  /** Record incognito windows. Same per-device, default-off, not-policy-controllable
   *  semantics as captureAll. */
  captureIncognito?: boolean;
}

/**
 * The effective config, merging admin enrollment with the member's own settings.
 *
 * A managed policy (MDM) may provision the ingest `token`, the `apiBase`, and an
 * org opt-out list, so a fleet browser is configured without the member pasting
 * anything. The member's LOCAL settings — their own pairing, their pause — win
 * over managed.
 *
 * The capture-scope flags (`captureAll`, `captureIncognito`) are read from LOCAL
 * ONLY, deliberately absent from the managed set below. Comprehensive capture of
 * protected categories and private windows therefore cannot be switched on across
 * a fleet from a single policy change — it would take hands-on access to each
 * device, which is the point.
 */
async function config(): Promise<Config> {
  const local = (await chrome.storage.local.get([
    "token", "apiBase", "paused", "blocked", "captureAll", "captureIncognito",
  ])) as Config;
  let managed: Partial<Config> = {};
  try {
    managed = (await chrome.storage.managed.get(["token", "apiBase", "blocked"])) as Partial<Config>;
  } catch {
    // Unmanaged browser: managed storage is empty/throws; the member self-pairs.
  }
  return { ...managed, ...local };
}

/** The capture options for `toVisit`. SAFE by default: the sensitive-category
 *  floor applies and incognito is skipped unless a flag is explicitly set true
 *  on this device. An org's own `blocked` opt-outs are always honoured. */
function captureOpts(cfg: Config) {
  return {
    captureAll: cfg.captureAll === true,
    captureIncognito: cfg.captureIncognito === true,
    extraBlocked: cfg.blocked ?? [],
  };
}

async function getOpen(): Promise<OpenSpan | null> {
  const { open } = await chrome.storage.session.get("open");
  return (open as OpenSpan) ?? null;
}

async function setOpen(open: OpenSpan | null): Promise<void> {
  if (open) await chrome.storage.session.set({ open });
  else await chrome.storage.session.remove("open");
}

// Serializes every read-modify-write against the "queue" key. chrome.storage
// gives no transaction guarantee, and MV3 dispatches listeners concurrently,
// so enqueue() and flush() — each independently a get-then-set — could
// otherwise interleave: flush() reads the queue, a concurrent enqueue() reads
// the same stale value and writes queue+[C], then flush()'s own pending write
// (computed from its earlier read) overwrites that, silently dropping C. This
// chain forces every mutation to fully apply before the next one reads.
let queueLock: Promise<unknown> = Promise.resolve();
function withQueue<T>(mutate: (queue: unknown[]) => { queue: unknown[]; result: T }): Promise<T> {
  const run = queueLock.then(async () => {
    const { queue = [] } = await chrome.storage.session.get("queue");
    const { queue: next, result } = mutate(queue as unknown[]);
    await chrome.storage.session.set({ queue: next });
    return result;
  });
  queueLock = run.catch(() => {}); // keep the chain alive past a rejection
  return run;
}

async function enqueue(events: unknown[]): Promise<void> {
  if (!events.length) return;
  await withQueue((queue) => ({
    // Drop the OLDEST past the cap: after a long offline stretch the recent
    // spans are the ones worth keeping.
    queue: [...queue, ...events].slice(-MAX_QUEUED),
    result: undefined,
  }));
}

/** Close the open span, decide whether it may be recorded, and buffer it. */
async function closeSpan(now = Date.now()): Promise<void> {
  const open = await getOpen();
  await setOpen(null);
  if (!open) return;
  const cfg = await config();
  const candidate: Candidate = { url: open.url, incognito: open.incognito, title: open.title };
  const visit = toVisit(
    candidate, open.startedAt, now - open.startedAt, captureOpts(cfg), open.from,
  );
  if (!visit) return;
  const event = toAgentEvent(visit);
  // `browser` is a per-BUILD fact, not something tracker.ts's pure functions
  // can know — set here rather than threading it through Visit/toAgentEvent,
  // which stay browser-agnostic so the same tracker.ts serves every build.
  await enqueue([{ ...event, detail: { ...event.detail, browser: BROWSER } }]);
}

/**
 * Where the user is switching AWAY from, as a name that may be recorded.
 *
 * Runs the departing tab back through the SAME capture rules the arriving one
 * faces. Without that, a hop from a bank to an ordinary site would name the bank
 * on the ordinary site's row — publishing, as a side effect of a feature about
 * destinations, precisely the visit the blocklist refused to store.
 *
 * The member's own BlissWork tab resolves to the marker, because "switched from
 * BlissWork to YouTube" is the fact worth reading; naming the host the workspace
 * is served from would be technically true and useless.
 */
function sourceName(open: OpenSpan | null, cfg: Config): string | undefined {
  if (!open) return undefined;
  const site = recordableSite({ url: open.url, incognito: open.incognito }, captureOpts(cfg));
  if (!site) return undefined;
  return site.domain === selfDomain(cfg.apiBase) ? SELF : site.domain;
}

/** Point the tracker at a new tab, closing whatever was open. */
async function focus(url: string | undefined, incognito: boolean, title?: string): Promise<void> {
  const cfg = await config();
  if (!cfg.token || cfg.paused) return;
  // Read the outgoing span BEFORE closeSpan clears it — that tab is the answer
  // to "where did they come from" for the one being opened.
  const from = sourceName(await getOpen(), cfg);
  await closeSpan();
  if (!url) return;
  await setOpen({
    url, incognito, startedAt: Date.now(),
    ...(from ? { from } : {}), ...(title ? { title } : {}),
  });
}

/**
 * Refresh the open span's title without touching its URL, start time, or
 * `from` — the same tab, later, with a title the page changed after it loaded
 * (a SPA setting `document.title`, a page whose <title> was empty at first
 * paint and filled in afterward). Silently a no-op if the update is for some
 * OTHER tab than the one currently open, or if the title is unchanged.
 */
async function refreshTitle(url: string | undefined, title: string | undefined): Promise<void> {
  if (!title) return;
  const open = await getOpen();
  if (!open || open.url !== url || open.title === title) return;
  await setOpen({ ...open, title });
}

async function flush(): Promise<void> {
  const cfg = await config();
  if (!cfg.token || !cfg.apiBase) return;
  const batch = await withQueue((queue) => ({
    queue: queue.slice(200),
    result: queue.slice(0, 200),
  }));
  if (!batch.length) return;
  try {
    const res = await fetch(`${cfg.apiBase}/telemetry/ingest/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Ingest-Token": cfg.token },
      body: JSON.stringify({ events: batch }),
    });
    if (res.status === 401) {
      // Revoked — by the person, or automatically because their membership
      // ended. Forget the token and everything buffered: there is nothing to
      // recover, and retrying would be a former colleague's browser repeatedly
      // reporting into a workspace it no longer belongs to.
      //
      // "everything buffered" includes the in-progress open span, not just
      // the queue — an open span left behind here survives this token and
      // sits inert (focus() early-returns without cfg.token) until this
      // machine is re-paired with a DIFFERENT token. reconcile() then finds
      // paused:true on the new pairing and calls closeSpan(), flushing this
      // stale, possibly weeks-old span under the NEW identity: one person's
      // leftover browsing attributed to whoever re-paired the device.
      // Mirrors options.ts's disconnect handler, which already clears both.
      await chrome.storage.local.remove("token");
      await chrome.storage.session.remove(["queue", "open"]);
      await setBadge("!");
      return;
    }
    if (!res.ok) await enqueue(batch); // server trouble; try again next alarm
  } catch {
    await enqueue(batch); // offline
  }
}

async function setBadge(text: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text });
  } catch {
    /* badge is cosmetic */
  }
}

/** Re-read config and reflect it immediately — badge, and closing an open
 *  span if pairing/pausing just made recording it wrong — rather than waiting
 *  for the next tab event or flush alarm to notice. Shared by the internal
 *  "the options page changed something" message and the external automatic
 *  provisioning handoff below: both are "config just changed" from this
 *  worker's point of view. */
async function reconcile(): Promise<void> {
  const cfg = await config();
  await setBadge(cfg.token && !cfg.paused ? "" : "off");
  if (!cfg.token || cfg.paused) await closeSpan();
}

/** Confirm a freshly-provisioned credential actually works, independent of
 *  the person having clicked Resume yet — the desktop app's activity-
 *  agent.ts does the identical thing for the identical reason: it is what
 *  lets a client show CONNECTED before consent, rather than a "paired" state
 *  nobody has verified reaches the server. Best-effort: provisionToken()
 *  already verified the token once via a real ingest call, so a failure here
 *  only means telemetry-svc's lastSeenAt stays stale until the next one. */
async function pingStatus(token: string, apiBase: string): Promise<void> {
  try {
    await fetch(`${apiBase}/telemetry/tokens/status`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Ingest-Token": token },
      body: JSON.stringify({ version: chrome.runtime.getManifest().version, platform: BROWSER }),
    });
  } catch {
    /* best-effort — see docstring */
  }
}

// ── Events ───────────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await focus(tab.url, tab.incognito === true, tab.title);
  } catch {
    /* the tab closed between the event and the lookup */
  }
});

chrome.tabs.onUpdated.addListener(async (_id, change, tab) => {
  // A committed URL change opens a new span. `status: loading` fires for every
  // in-page state change on modern sites and would shred one visit into
  // dozens, so only `change.url` triggers a switch.
  if (change.url && tab.active) {
    await focus(change.url, tab.incognito === true, tab.title);
    return;
  }
  // A title change with NO url change is the same page updating its own
  // title after the span already opened — a SPA route, a page whose <title>
  // fills in after first paint, a YouTube tab reaching the point where the
  // video's real title replaces a loading placeholder. Refreshed in place
  // rather than opening a new span, which would record one video as several
  // shorter, less accurate visits.
  if (change.title && tab.active && tab.url) {
    await refreshTitle(tab.url, change.title);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // The browser lost focus entirely — the person is in another application,
    // and continuing to accrue time against the frontmost tab would be a lie.
    await closeSpan();
    await flush();
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) await focus(tab.url, tab.incognito === true, tab.title);
  } catch {
    /* window vanished */
  }
});

chrome.idle.setDetectionInterval(IDLE_SECONDS);
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === "active") return;
  // Idle or locked: close the span at the point we stopped believing it.
  await closeSpan();
  await flush();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== FLUSH_ALARM) return;
  // Close and immediately reopen the current span so a long-lived tab is
  // recorded in increments rather than as one enormous entry at the end.
  const open = await getOpen();
  if (open) {
    await closeSpan();
    // Re-opened WITHOUT `from`: the switch that started this span has already
    // been reported on the increment just closed, and repeating it on every
    // subsequent hour of the same tab would put a switch that happened once on
    // the timeline once per minute.
    await setOpen({ url: open.url, incognito: open.incognito, startedAt: Date.now() });
  }
  await flush();
});

function ensureAlarm(): void {
  void chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_MINUTES });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
// Also on plain worker wake-up: an alarm that was somehow lost would otherwise
// leave the extension silently doing nothing.
ensureAlarm();

// The options page tells the worker when pairing state changed, so it starts or
// stops immediately rather than at the next alarm.
chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, reply) => {
  if (msg?.type === "config-changed") {
    void reconcile().then(() => reply({ ok: true }));
    return true; // async reply
  }
  return false;
});

/**
 * Whether a provisioning message's caller-supplied `apiBase` is one the
 * sending page is actually entitled to name.
 *
 * `externally_connectable.matches` (Chrome-enforced before this listener ever
 * runs) restricts WHO can send `blisswork:provision`; it says nothing about
 * WHAT `apiBase` that sender may put in the message body. Left unchecked, any
 * trusted origin could repoint the extension's telemetry destination — and
 * its stored ingest token — at an arbitrary third-party host simply by naming
 * it. Requiring `apiBase` to share the sender's own origin closes that off
 * without needing a second, separately-maintained host allowlist: every
 * production deployment reverse-proxies its API under the same origin as the
 * page that serves it (see .env.prod's VITE_*_BASE values, all
 * `https://communication.rnrtechs.com/api/...`), so this costs the real flow
 * nothing. A deployment where that does not hold still has the unrestricted
 * manual "paste a code" flow in options.ts as a fallback — the same fallback
 * PlatformConfig.chromeExtensionId's own doc comment already describes for
 * "no automatic path configured" today.
 */
function apiBaseMatchesSender(apiBase: string | undefined, senderOrigin: string | undefined): boolean {
  if (!apiBase || !senderOrigin) return false;
  try {
    return new URL(apiBase).origin === senderOrigin;
  } catch {
    return false;
  }
}

/**
 * Automatic provisioning from a signed-in BlissWork tab — the officially
 * supported alternative to the manual copy/paste flow in options.ts.
 *
 * Reachable ONLY from origins the manifest's `externally_connectable.matches`
 * lists; Chrome enforces that at the platform level before this listener ever
 * sees a message, so there is no second check to keep in sync for WHO may
 * send one. `apiBaseMatchesSender` above is the separate check for WHAT a
 * sender may claim as its `apiBase`.
 *
 *   blisswork:ping        -> { connected, version } for the calling page to
 *                             decide whether to offer "Connect" or nothing.
 *   blisswork:provision    -> verify-then-store a freshly minted token, same
 *                             contract as options.ts's manual connect (see
 *                             provisionToken's own docstring on why both
 *                             paths share it) — never immediately recording;
 *                             provisioning is not consent.
 */
chrome.runtime.onMessageExternal.addListener(
  (msg: { type?: string; token?: string; apiBase?: string }, sender, reply) => {
    if (msg?.type === "blisswork:ping") {
      void config().then((cfg) =>
        reply({ connected: !!cfg.token, version: chrome.runtime.getManifest().version }),
      );
      return true;
    }
    if (msg?.type === "blisswork:provision") {
      void (async () => {
        if (!apiBaseMatchesSender(msg.apiBase, sender.origin)) {
          reply({ ok: false, reason: "bad-request" });
          return;
        }
        const result = await provisionToken(msg.token ?? "", msg.apiBase ?? "");
        if (result.ok) {
          await reconcile();
          void pingStatus(msg.token as string, msg.apiBase as string);
        }
        reply(result);
      })();
      return true;
    }
    return false;
  },
);
