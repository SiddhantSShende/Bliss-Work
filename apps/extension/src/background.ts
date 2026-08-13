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
import { toAgentEvent, toVisit, type Candidate } from "./tracker";

const FLUSH_ALARM = "blisswork-flush";
const FLUSH_MINUTES = 1;
const MAX_QUEUED = 300;
/** Chrome's own idle detector. Time with the machine locked is not browsing. */
const IDLE_SECONDS = 300;

interface OpenSpan {
  url: string;
  incognito: boolean;
  startedAt: number;
}

interface Config {
  token?: string;
  apiBase?: string;
  paused?: boolean;
  blocked?: string[];
}

async function config(): Promise<Config> {
  return (await chrome.storage.local.get(["token", "apiBase", "paused", "blocked"])) as Config;
}

async function getOpen(): Promise<OpenSpan | null> {
  const { open } = await chrome.storage.session.get("open");
  return (open as OpenSpan) ?? null;
}

async function setOpen(open: OpenSpan | null): Promise<void> {
  if (open) await chrome.storage.session.set({ open });
  else await chrome.storage.session.remove("open");
}

async function enqueue(events: unknown[]): Promise<void> {
  if (!events.length) return;
  const { queue = [] } = await chrome.storage.session.get("queue");
  // Drop the OLDEST past the cap: after a long offline stretch the recent spans
  // are the ones worth keeping.
  const next = [...(queue as unknown[]), ...events].slice(-MAX_QUEUED);
  await chrome.storage.session.set({ queue: next });
}

/** Close the open span, decide whether it may be recorded, and buffer it. */
async function closeSpan(now = Date.now()): Promise<void> {
  const open = await getOpen();
  await setOpen(null);
  if (!open) return;
  const cfg = await config();
  const candidate: Candidate = { url: open.url, incognito: open.incognito };
  const visit = toVisit(candidate, open.startedAt, now - open.startedAt, cfg.blocked ?? []);
  if (visit) await enqueue([toAgentEvent(visit)]);
}

/** Point the tracker at a new tab, closing whatever was open. */
async function focus(url: string | undefined, incognito: boolean): Promise<void> {
  const cfg = await config();
  if (!cfg.token || cfg.paused) return;
  await closeSpan();
  if (!url) return;
  await setOpen({ url, incognito, startedAt: Date.now() });
}

async function flush(): Promise<void> {
  const cfg = await config();
  if (!cfg.token || !cfg.apiBase) return;
  const { queue = [] } = await chrome.storage.session.get("queue");
  const events = queue as unknown[];
  if (!events.length) return;

  const batch = events.slice(0, 200);
  await chrome.storage.session.set({ queue: events.slice(batch.length) });
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
      await chrome.storage.local.remove("token");
      await chrome.storage.session.remove("queue");
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

// ── Events ───────────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await focus(tab.url, tab.incognito === true);
  } catch {
    /* the tab closed between the event and the lookup */
  }
});

chrome.tabs.onUpdated.addListener(async (_id, change, tab) => {
  // Only a committed URL change matters. `status: loading` fires for every
  // in-page state change on modern sites and would shred one visit into dozens.
  if (!change.url || !tab.active) return;
  await focus(change.url, tab.incognito === true);
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
    if (tab) await focus(tab.url, tab.incognito === true);
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
    await setOpen({ ...open, startedAt: Date.now() });
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
    void (async () => {
      const cfg = await config();
      await setBadge(cfg.token && !cfg.paused ? "" : "off");
      if (!cfg.token || cfg.paused) await closeSpan();
      reply({ ok: true });
    })();
    return true; // async reply
  }
  return false;
});
