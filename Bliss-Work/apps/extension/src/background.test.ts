/**
 * Drives the MV3 service worker through a full
 * BlissWork -> YouTube -> GitHub -> ChatGPT -> BlissWork sequence using an
 * in-memory fake of the `chrome.*` surface `background.ts` actually touches.
 *
 * `background.ts` itself has no unit tests today — by design, per its own
 * docblock: the decisions worth pinning live in tracker.ts, deliberately free
 * of `chrome.*`. This file adds the one thing tracker.ts's tests cannot cover
 * on their own: that the SERVICE WORKER wiring — tab-switch detection, span
 * open/close, the storage.session handoff between "worker instances" — chains
 * those pure decisions into the right sequence of posted events, with correct
 * timestamps and no duplicates, exactly as MV3 would run it in a real browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeTab {
  id: number;
  url?: string;
  title?: string;
  incognito?: boolean;
  active: boolean;
  windowId: number;
}

/** Enough of chrome.storage's callback-and-promise-both API surface for
 *  background.ts's usage (`.get([...])`/`.get("key")`/`.set()`/`.remove()`,
 *  all called with `await`, never a callback here). */
function makeStorageArea() {
  const data: Record<string, unknown> = {};
  return {
    async get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, items);
    },
    async remove(key: string) {
      delete data[key];
    },
    _dump: () => ({ ...data }),
  };
}

/** Every real listener in background.ts is `async`; these types allow that so
 *  the harness can `await` a dispatch and know the handler actually finished. */
let tabs: Map<number, FakeTab>;
let activatedListeners: Array<(info: { tabId: number }) => void | Promise<void>>;
let updatedListeners: Array<
  (id: number, change: Record<string, unknown>, tab: FakeTab) => void | Promise<void>
>;
let windowFocusListeners: Array<(windowId: number) => void | Promise<void>>;
let idleListeners: Array<(state: string) => void | Promise<void>>;
let alarmListeners: Array<(alarm: { name: string }) => void | Promise<void>>;
let messageListeners: Array<(msg: unknown, sender: unknown, reply: (r: unknown) => void) => boolean>;
let externalMessageListeners: Array<
  (msg: unknown, sender: unknown, reply: (r: unknown) => void) => boolean
>;
let localStorage: ReturnType<typeof makeStorageArea>;
let sessionStorage: ReturnType<typeof makeStorageArea>;
let managedStorage: ReturnType<typeof makeStorageArea>;

const fetchMock = vi.fn(
  async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify({ accepted: 1 }), { status: 202 }),
);

function installFakeChrome(): void {
  tabs = new Map();
  activatedListeners = [];
  updatedListeners = [];
  windowFocusListeners = [];
  idleListeners = [];
  alarmListeners = [];
  messageListeners = [];
  externalMessageListeners = [];
  localStorage = makeStorageArea();
  sessionStorage = makeStorageArea();
  managedStorage = makeStorageArea();

  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: localStorage,
      session: sessionStorage,
      managed: managedStorage,
    },
    tabs: {
      onActivated: { addListener: (cb: (info: { tabId: number }) => void) => activatedListeners.push(cb) },
      onUpdated: {
        addListener: (cb: (id: number, change: Record<string, unknown>, tab: FakeTab) => void) =>
          updatedListeners.push(cb),
      },
      get: async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw new Error("no such tab");
        return t;
      },
      query: async (q: { active?: boolean; windowId?: number }) =>
        [...tabs.values()].filter(
          (t) => (q.active === undefined || t.active === q.active)
            && (q.windowId === undefined || t.windowId === q.windowId),
        ),
    },
    windows: {
      onFocusChanged: { addListener: (cb: (windowId: number) => void) => windowFocusListeners.push(cb) },
      WINDOW_ID_NONE: -1,
    },
    idle: {
      setDetectionInterval: () => {},
      onStateChanged: { addListener: (cb: (state: string) => void) => idleListeners.push(cb) },
    },
    alarms: {
      create: async () => {},
      onAlarm: { addListener: (cb: (alarm: { name: string }) => void) => alarmListeners.push(cb) },
    },
    action: { setBadgeText: async () => {} },
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: {
        addListener: (cb: (msg: unknown, sender: unknown, reply: (r: unknown) => void) => boolean) =>
          messageListeners.push(cb),
      },
      onMessageExternal: {
        addListener: (cb: (msg: unknown, sender: unknown, reply: (r: unknown) => void) => boolean) =>
          externalMessageListeners.push(cb),
      },
      getManifest: () => ({ version: "1.0.0" }),
    },
  };
}

/** Simulates chrome delivering an externally_connectable message and
 *  resolving with whatever the listener's `reply` callback was called with —
 *  Chrome's real contract when a listener returns `true` for an async reply. */
function sendExternal(msg: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    for (const cb of externalMessageListeners) {
      const handled = cb(msg, {}, resolve);
      if (handled) return;
    }
    resolve(undefined);
  });
}

/**
 * Test-only helpers standing in for what a real browser would do.
 *
 * Every listener call is AWAITED before the helper returns — unlike a real
 * browser, which dispatches events without waiting for an async listener to
 * finish, this in-memory harness runs everything on one synchronous JS
 * timeline. Not awaiting here would let two "concurrent" events race against
 * each other's `chrome.storage.session` reads/writes in an order a real
 * MV3 worker never actually produces (storage.session itself serialises
 * real access), so this harness makes each simulated browser event fully
 * settle — matching the read-after-write consistency the extension's code
 * already depends on — before the next one is fired.
 */
const harness = {
  async openTab(id: number, url: string, title: string, windowId = 1): Promise<void> {
    const existed = tabs.has(id);
    const tab: FakeTab = { id, url, title, active: true, windowId };
    for (const t of tabs.values()) if (t.windowId === windowId) t.active = false;
    tabs.set(id, tab);
    if (existed) {
      for (const cb of updatedListeners) await cb(id, { url }, tab);
    } else {
      for (const cb of activatedListeners) await cb({ tabId: id });
    }
  },
  async retitle(id: number, title: string): Promise<void> {
    const tab = tabs.get(id);
    if (!tab) throw new Error("no such tab");
    tab.title = title;
    for (const cb of updatedListeners) await cb(id, { title }, tab);
  },
  async fireAlarm(): Promise<void> {
    for (const cb of alarmListeners) await cb({ name: "blisswork-flush" });
  },
};

const BLISSWORK_URL = "https://app.blisswork.test/inbox";
const API_BASE = "https://app.blisswork.test";

describe("browser sensor (background.ts): BlissWork -> YouTube -> GitHub -> ChatGPT -> BlissWork", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-13T09:00:00.000Z"));
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    installFakeChrome();
    await localStorage.set({ token: "test-token", apiBase: API_BASE, captureAll: true, captureIncognito: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function postedEvents(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls.flatMap(([, init]) => {
      const body = JSON.parse(init.body as string) as { events: Array<Record<string, unknown>> };
      return body.events;
    });
  }

  it("records four correct site.visit spans with domain, url, title, timestamps and durations", async () => {
    await import("./background");

    // Start on BlissWork itself.
    await harness.openTab(1, BLISSWORK_URL, "Inbox - BlissWork");
    await vi.advanceTimersByTimeAsync(20_000);

    // Switch to YouTube — title arrives a little later, as a real page load would.
    await harness.openTab(1, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube");
    await harness.retitle(1, "Learn Go in 30 Minutes - YouTube");
    await vi.advanceTimersByTimeAsync(30_000);

    // Switch to GitHub.
    await harness.openTab(1, "https://github.com/anthropics/claude-code", "anthropics/claude-code: A CLI");
    await vi.advanceTimersByTimeAsync(25_000);

    // Switch to ChatGPT — a site with no registered enricher.
    await harness.openTab(1, "https://chatgpt.com/c/abc123", "ChatGPT");
    await vi.advanceTimersByTimeAsync(15_000);

    // Back to BlissWork.
    await harness.openTab(1, BLISSWORK_URL, "Inbox - BlissWork");
    await vi.advanceTimersByTimeAsync(1);

    // The browser loses focus entirely (switched to another application) —
    // this is what actually closes and flushes the final open span; nothing
    // else in this extension's design closes a span on a timer alone.
    for (const cb of windowFocusListeners) await cb(-1);
    await vi.advanceTimersByTimeAsync(1);

    const events = postedEvents().filter((e) => e.action === "site.visit");
    expect(events).toHaveLength(4);
    // Non-null: the length assertion above is what proves this, which TS's
    // control-flow analysis does not carry into a destructuring assignment.
    const [blissWork, youtube, github, chatgpt] = events as [
      Record<string, unknown>, Record<string, unknown>,
      Record<string, unknown>, Record<string, unknown>,
    ];

    // Domains. BlissWork's own registrable domain, per registrableDomain's
    // ordinary subdomain-stripping rule ("app." is a subdomain, same as
    // "www." — the registrable domain is the last two labels).
    expect(blissWork.targetId).toBe("blisswork.test");
    expect(youtube.targetId).toBe("youtube.com");
    expect(github.targetId).toBe("github.com");
    expect(chatgpt.targetId).toBe("chatgpt.com");

    // URLs (domain + path, per toAgentEvent's shape) and mirrored `domain`.
    const detailOf = (e: Record<string, unknown>) => e.detail as Record<string, string>;
    expect(detailOf(youtube).url).toBe("youtube.com/watch?v=dQw4w9WgXcQ");
    expect(detailOf(youtube).domain).toBe("youtube.com");
    expect(detailOf(github).url).toBe("github.com/anthropics/claude-code");
    expect(detailOf(chatgpt).url).toBe("chatgpt.com/c/abc123");

    // Page titles — YouTube's is the one picked up by the later retitle, not
    // the placeholder present at the moment the tab first opened.
    expect(detailOf(youtube).title).toBe("Learn Go in 30 Minutes - YouTube");
    expect(detailOf(github).title).toBe("anthropics/claude-code: A CLI");
    expect(detailOf(chatgpt).title).toBe("ChatGPT");

    // Site enrichment: YouTube and GitHub are recognised; ChatGPT correctly
    // carries none — enrichment is additive, not required for a visit to
    // record, which is the whole point of testing an unrecognised site here.
    expect(detailOf(youtube).siteKind).toBe("video");
    expect(detailOf(youtube).siteRef).toBe("dQw4w9WgXcQ");
    expect(detailOf(github).siteKind).toBe("repository");
    expect(detailOf(github).siteRef).toBe("anthropics/claude-code");
    expect(detailOf(chatgpt).siteKind).toBeUndefined();
    expect(detailOf(chatgpt).siteRef).toBeUndefined();

    // Browser is tagged on every row, uniformly — this build reports "chrome".
    expect(detailOf(blissWork).browser).toBe("chrome");
    expect(detailOf(youtube).browser).toBe("chrome");

    // "From" chain: each destination names where the person came from.
    expect(detailOf(youtube).from).toBe("BlissWork");
    expect(detailOf(github).from).toBe("youtube.com");
    expect(detailOf(chatgpt).from).toBe("github.com");

    // Correct durations.
    expect(blissWork.durationMs).toBe(20_000);
    expect(youtube.durationMs).toBe(30_000);
    expect(github.durationMs).toBe(25_000);
    expect(chatgpt.durationMs).toBe(15_000);

    // Timestamps: monotonically increasing, in transition order.
    const times = events.map((e) => Date.parse(e.occurredAt as string));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    // No duplicates: exactly one site.visit row per completed span (already
    // asserted by the length check above; re-stated here as the requirement
    // this test exists to prove).
    const urls = events.map((e) => detailOf(e).url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("does not fragment a single YouTube visit into multiple rows when only the title changes", async () => {
    await import("./background");
    await harness.openTab(1, "https://www.youtube.com/watch?v=xyz", "YouTube");
    await vi.advanceTimersByTimeAsync(5_000);
    await harness.retitle(1, "A Real Video Title - YouTube");
    await vi.advanceTimersByTimeAsync(5_000);
    await harness.retitle(1, "A Real Video Title - YouTube"); // no-op: unchanged title
    await vi.advanceTimersByTimeAsync(20_000);

    for (const cb of windowFocusListeners) await cb(-1);
    await vi.advanceTimersByTimeAsync(1);

    const events = postedEvents().filter((e) => e.action === "site.visit");
    expect(events).toHaveLength(1);
    const [only] = events as [Record<string, unknown>];
    expect((only.detail as Record<string, string>).title).toBe("A Real Video Title - YouTube");
    expect(only.durationMs).toBe(30_000);
  });

  it("increments a long-lived visit rather than losing it, on the periodic flush alarm", async () => {
    await import("./background");
    await harness.openTab(1, "https://github.com/a/b", "a/b");
    await vi.advanceTimersByTimeAsync(45_000);

    await harness.fireAlarm(); // closes and reopens the same span as an increment
    await vi.advanceTimersByTimeAsync(20_000);

    for (const cb of windowFocusListeners) await cb(-1);
    await vi.advanceTimersByTimeAsync(1);

    const events = postedEvents().filter((e) => e.action === "site.visit");
    // Two increments of the SAME visit, not a duplicate — the second has no
    // `from` (already reported on the first increment) despite being the same
    // github.com/a/b domain, which is what proves it's a continuation.
    expect(events).toHaveLength(2);
    const [first, second] = events as [Record<string, unknown>, Record<string, unknown>];
    expect(first.targetId).toBe("github.com");
    expect(second.targetId).toBe("github.com");
    expect((second.detail as Record<string, string>).from).toBeUndefined();
    expect(first.durationMs).toBe(45_000);
    expect(second.durationMs).toBe(20_000);
  });
});

describe("automatic provisioning (externally_connectable)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    installFakeChrome();
    // Unpaired by default here — each test sets up the state it needs,
    // unlike the site-tracking suite above which always starts paired.
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports not connected when no token is stored yet", async () => {
    await import("./background");
    const res = await sendExternal({ type: "blisswork:ping" });
    expect(res).toEqual({ connected: false, version: "1.0.0" });
  });

  it("reports already connected without touching storage", async () => {
    await localStorage.set({ token: "existing-token", apiBase: API_BASE, paused: false });
    await import("./background");
    const res = await sendExternal({ type: "blisswork:ping" });
    expect(res).toEqual({ connected: true, version: "1.0.0" });
    expect(localStorage._dump().token).toBe("existing-token");
  });

  it("provisions a fresh token: verifies it, stores it PAUSED, and pings status", async () => {
    await import("./background");
    const res = await sendExternal({
      type: "blisswork:provision", token: "new-token", apiBase: API_BASE,
    });
    expect(res).toEqual({ ok: true });
    expect(localStorage._dump()).toMatchObject({ token: "new-token", apiBase: API_BASE, paused: true });

    // Verify call (empty batch) and the status ping — never an activity write.
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain(`${API_BASE}/telemetry/ingest/agent`);
    expect(urls).toContain(`${API_BASE}/telemetry/tokens/status`);
  });

  it("rejects an invalid token and stores nothing", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await import("./background");
    const res = await sendExternal({
      type: "blisswork:provision", token: "bad-token", apiBase: API_BASE,
    });
    expect(res).toEqual({ ok: false, reason: "invalid-token" });
    expect(localStorage._dump().token).toBeUndefined();
  });

  it("does not record anything as a side effect of provisioning", async () => {
    // postedEvents() assumes every fetch body has an `events` array, which the
    // status-ping body does not — inspected directly here instead, over EVERY
    // call this action makes (verify + status ping), not just the ingest one.
    await import("./background");
    await sendExternal({ type: "blisswork:provision", token: "new-token", apiBase: API_BASE });
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse((init as RequestInit).body as string) as { events?: unknown[] };
      expect(body.events ?? []).toHaveLength(0);
    }
  });
});
