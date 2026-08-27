import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives the Windows/foreground half of the desktop activity agent through a
 * full BlissWork → Chrome → VS Code → Slack → BlissWork sequence.
 *
 * `activity-agent.ts` talks to three things this test replaces:
 *   - electron's `powerMonitor` (idle time, lock/unlock/suspend events)
 *   - `./activity-state` (consent — always "on" here)
 *   - `./foreground` (the native window provider) — the module under test
 *     never touches `get-windows` directly, only through this file's
 *     `loadProvider`, so a fake provider is what stands in for Windows here.
 *
 * The agent posts batches to `${telemetryBase}/telemetry/ingest/agent`
 * (agent.py's ingest route) via `fetch`, which is mocked to capture what
 * would have been sent rather than perform a network call.
 */

let currentWindow: { title?: string; owner?: { name?: string; path?: string } } | undefined;
const fetchMock = vi.fn(
  async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify({ accepted: 1 }), { status: 202 }),
);

vi.mock("electron", () => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    app: { getVersion: () => "0.1.0" },
    powerMonitor: {
      getSystemIdleTime: () => 0,
      on: (event: string, cb: () => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
      },
      removeListener: (event: string, cb: () => void) => {
        listeners.get(event)?.delete(cb);
      },
      // Test-only escape hatch — not part of Electron's real API — so a test
      // can fire "the screen locked" without reaching into module internals.
      __emit: (event: string) => {
        for (const cb of listeners.get(event) ?? []) cb();
      },
    },
  };
});

vi.mock("./activity-state", () => ({
  isActive: () => true,
  getState: () => ({ version: 1, enabled: true, token: "test-token", consentedVersion: "0.1.0" }),
}));

vi.mock("./foreground", () => ({
  loadProvider: async () => ({
    activeWindow: async () => currentWindow,
  }),
  providerUnavailableReason: () => null,
}));

const SAMPLE_MS = 15_000;

describe("activity-agent: Windows foreground sensor", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    currentWindow = { title: "Program Manager", owner: { name: "BlissWork", path: "C:\\Program Files\\BlissWork\\BlissWork.exe" } };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Every posted batch, flattened, in the order fetch was called. */
  function postedEvents(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls.flatMap(([, init]) => {
      const body = JSON.parse(init.body as string) as { events: Array<Record<string, unknown>> };
      return body.events;
    });
  }

  it("records BlissWork -> Chrome -> VS Code -> Slack -> BlissWork as four correct transitions", async () => {
    const agent = await import("./activity-agent");
    agent.start("https://telemetry.test");

    // Every dwell below is an exact multiple of SAMPLE_MS: `current.since` is
    // always stamped at a sample-tick boundary (the tick that first observes
    // the new foreground window), so a dwell that is not tick-aligned would
    // make the recorded duration depend on exactly where in the polling cycle
    // the switch happened — true of the real sensor too, and irrelevant to
    // what this test is verifying, so the test sidesteps it by only ever
    // switching windows exactly on a tick boundary.

    // BlissWork is already frontmost (set in beforeEach). Hold 2 ticks (30s).
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS);

    currentWindow = {
      title: "Learn Go in 30 Minutes - YouTube - Google Chrome",
      owner: { name: "Google Chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
    };
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS); // land on Chrome + hold 1 more tick

    currentWindow = {
      title: "activity.go - BlissWork - Visual Studio Code",
      owner: { name: "Visual Studio Code", path: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" },
    };
    await vi.advanceTimersByTimeAsync(3 * SAMPLE_MS); // land on VS Code + hold 2 more ticks

    currentWindow = {
      title: "general (BlissWork) - Slack",
      owner: { name: "Slack", path: "C:\\Users\\me\\AppData\\Local\\slack\\slack.exe" },
    };
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS); // land on Slack + hold 1 more tick

    currentWindow = { title: "Program Manager", owner: { name: "BlissWork", path: "C:\\Program Files\\BlissWork\\BlissWork.exe" } };
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS); // land back on BlissWork + hold 1 more tick
    // This final BlissWork span is still open when the app quits — flushOnQuit's
    // own closeCurrent is what closes and posts it, exercising that path
    // distinctly from the four spans above that closed via an app switch.

    await agent.flushOnQuit();
    agent.stop();

    const appFocusEvents = postedEvents().filter((e) => e.action === "app.focus");

    // Five completed spans: the initial BlissWork span, Chrome, VS Code, Slack,
    // and the final BlissWork span — closed by flushOnQuit rather than by a
    // further switch, exercising the "app still open at shutdown" path.
    const targets = appFocusEvents.map((e) => e.targetId);
    expect(targets).toEqual([
      "BlissWork", "Google Chrome", "Visual Studio Code", "Slack", "BlissWork",
    ]);

    // Correct "from" chain: each span names where the person came from.
    expect(appFocusEvents.map((e) => (e.detail as Record<string, string> | undefined)?.from)).toEqual([
      undefined, // first span ever recorded — no prior app to name
      "BlissWork",
      "Google Chrome",
      "Visual Studio Code",
      "Slack",
    ]);

    // Correct window titles, captured once per span.
    expect(appFocusEvents.map((e) => (e.detail as Record<string, string>).title)).toEqual([
      "Program Manager",
      "Learn Go in 30 Minutes - YouTube - Google Chrome",
      "activity.go - BlissWork - Visual Studio Code",
      "general (BlissWork) - Slack",
      "Program Manager",
    ]);

    expect(appFocusEvents).toHaveLength(5);
    // Non-null: the length assertion above is what proves this, which TS's
    // control-flow analysis does not carry into a destructuring assignment.
    const [blissWork1, chrome, vscode, slack, blissWork2] = appFocusEvents as [
      Record<string, unknown>, Record<string, unknown>, Record<string, unknown>,
      Record<string, unknown>, Record<string, unknown>,
    ];
    const detailOf = (e: Record<string, unknown>) => (e.detail ?? {}) as Record<string, string>;

    // Process is reported only when it adds something beyond the app name
    // already in targetId — Chrome's process ("chrome") and app name ("Google
    // Chrome") differ, so it's carried; Slack's process ("slack") and app name
    // ("Slack") are the same fact twice, so `detail.process` is omitted.
    expect(detailOf(chrome).process).toBe("chrome");
    expect(detailOf(vscode).process).toBe("Code");
    expect(detailOf(slack).process).toBeUndefined();

    // Chrome is tagged as a browser without the sensor special-casing it by name.
    expect(detailOf(chrome).browser).toBe("chrome");
    expect(detailOf(vscode).browser).toBeUndefined();

    // Correct durations: 2 ticks BlissWork, 2 ticks Chrome, 3 ticks VS Code,
    // 2 ticks Slack, and the final (still-open-at-quit) BlissWork span.
    expect(blissWork1.durationMs).toBe(2 * SAMPLE_MS);
    expect(chrome.durationMs).toBe(2 * SAMPLE_MS);
    expect(vscode.durationMs).toBe(3 * SAMPLE_MS);
    expect(slack.durationMs).toBe(2 * SAMPLE_MS);
    expect(blissWork2.durationMs as number).toBeGreaterThanOrEqual(SAMPLE_MS);

    // Timestamps are monotonically increasing and match the transition order.
    const times = appFocusEvents.map((e) => Date.parse(e.occurredAt as string));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("debounces a sub-sample-interval switch instead of recording it", async () => {
    const agent = await import("./activity-agent");
    agent.start("https://telemetry.test");
    await vi.advanceTimersByTimeAsync(SAMPLE_MS + 1000);

    // Flicker to Chrome for less than one sample interval, then back.
    currentWindow = { title: "x", owner: { name: "Google Chrome", path: "C:\\chrome.exe" } };
    await vi.advanceTimersByTimeAsync(5_000);
    currentWindow = { title: "Program Manager", owner: { name: "BlissWork", path: "C:\\BlissWork.exe" } };
    await vi.advanceTimersByTimeAsync(SAMPLE_MS + 1000);

    await agent.flushOnQuit();
    agent.stop();

    const targets = postedEvents().filter((e) => e.action === "app.focus").map((e) => e.targetId);
    // Chrome never reached the debounce threshold, so it never appears — the
    // BlissWork span simply continues (this agent does not stitch the two
    // BlissWork segments back into one row; only the first is asserted here).
    expect(targets).not.toContain("Google Chrome");
  });

  it("reports no window title when the platform gives none, without failing the sample", async () => {
    currentWindow = { owner: { name: "SomeElevatedApp.exe", path: undefined } };
    const agent = await import("./activity-agent");
    agent.start("https://telemetry.test");
    await vi.advanceTimersByTimeAsync(20_000);

    currentWindow = { title: "Program Manager", owner: { name: "BlissWork", path: "C:\\BlissWork.exe" } };
    await vi.advanceTimersByTimeAsync(SAMPLE_MS + 20_000);
    await agent.flushOnQuit();
    agent.stop();

    const events = postedEvents().filter((e) => e.action === "app.focus");
    const unknownAppSpan = events.find((e) => e.targetId === "SomeElevatedApp.exe");
    expect(unknownAppSpan).toBeDefined();
    expect((unknownAppSpan!.detail as Record<string, string> | undefined)?.title).toBeUndefined();
  });

  it("recovers when the foreground read throws, and keeps sampling afterward", async () => {
    let throwOnce = true;
    const agent = await import("./activity-agent");
    vi.doMock("./foreground", () => ({
      loadProvider: async () => ({
        activeWindow: async () => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error("transient read failure");
          }
          return currentWindow;
        },
      }),
      providerUnavailableReason: () => null,
    }));
    const freshAgent = await import("./activity-agent");
    freshAgent.start("https://telemetry.test");

    await vi.advanceTimersByTimeAsync(SAMPLE_MS); // the throwing sample
    await vi.advanceTimersByTimeAsync(20_000); // recovers, samples BlissWork
    await freshAgent.flushOnQuit();
    freshAgent.stop();

    expect(postedEvents().some((e) => e.action === "app.focus")).toBe(true);
    void agent; // imported once above only to keep module resolution warm
  });

  it("persists a 401's token revocation, not just the in-memory stop, so it isn't rediscovered on the next launch", async () => {
    // Regression test for the audit finding: flush()'s 401 branch called
    // stop() but never activity-state's setToken(null), so the revoked token
    // survived on disk — Settings kept reporting "paired", and every launch
    // re-triggered the same dead-token round-trip. This test overrides the
    // module-level ./activity-state mock with a spy so setToken's call can be
    // observed directly.
    const setTokenMock = vi.fn();
    vi.doMock("./activity-state", () => ({
      isActive: () => true,
      getState: () => ({ version: 1, enabled: true, token: "test-token", consentedVersion: "0.1.0" }),
      setToken: setTokenMock,
    }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    const agent = await import("./activity-agent");
    agent.start("https://telemetry.test");
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS);

    // Switch apps to close the open span into the queue, then force a flush
    // via flushOnQuit — the same path a real 401 arrives through.
    currentWindow = { title: "x", owner: { name: "Google Chrome", path: "C:\\chrome.exe" } };
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS);
    await agent.flushOnQuit();

    expect(fetchMock).toHaveBeenCalled();
    expect(setTokenMock).toHaveBeenCalledWith(null);
  });

  it("withholds the title from a password manager, but still records the app switch", async () => {
    const agent = await import("./activity-agent");
    agent.start("https://telemetry.test");
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS);

    currentWindow = {
      title: "chase.com — Login",
      owner: { name: "1Password", path: "C:\\Program Files\\1Password\\1Password.exe" },
    };
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS);

    currentWindow = { title: "Program Manager", owner: { name: "BlissWork", path: "C:\\BlissWork.exe" } };
    await vi.advanceTimersByTimeAsync(SAMPLE_MS + 1000);
    await agent.flushOnQuit();
    agent.stop();

    const events = postedEvents().filter((e) => e.action === "app.focus");
    const onePassword = events.find((e) => e.targetId === "1Password");
    // The switch itself is still a real, useful fact ("switched to 1Password
    // for 30s") — only the title, which would have named the site/account, is
    // withheld.
    expect(onePassword).toBeDefined();
    expect((onePassword!.detail as Record<string, string> | undefined)?.title).toBeUndefined();
  });

  it("withholds a revealing title from an ordinary application", async () => {
    const agent = await import("./activity-agent");
    agent.start("https://telemetry.test");
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS);

    currentWindow = {
      title: "Your one-time code is 481223 - Google Chrome",
      owner: { name: "Google Chrome", path: "C:\\chrome.exe" },
    };
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_MS);

    currentWindow = { title: "Program Manager", owner: { name: "BlissWork", path: "C:\\BlissWork.exe" } };
    await vi.advanceTimersByTimeAsync(SAMPLE_MS + 1000);
    await agent.flushOnQuit();
    agent.stop();

    const events = postedEvents().filter((e) => e.action === "app.focus");
    const chrome = events.find((e) => e.targetId === "Google Chrome");
    expect(chrome).toBeDefined();
    expect((chrome!.detail as Record<string, string> | undefined)?.title).toBeUndefined();
  });

  // These two run last on purpose: their vi.doMock("./activity-state", ...)
  // overrides are not undone by vi.resetModules() in beforeEach (doMock
  // persists across the module registry reset within a test file), so a
  // test placed after them would inherit isActive() === false instead of the
  // file's default true — exactly the pollution that broke this file the
  // first time these tests were added mid-file.
  it("pings status independent of consent — proves the credential works before anyone has said yes", async () => {
    vi.doMock("./activity-state", () => ({
      isActive: () => false,
      getState: () => ({ version: 2, enabled: false, token: null, consentedVersion: null }),
    }));
    const agent = await import("./activity-agent");
    await agent.pingStatus("https://telemetry.test", "a-pairing-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://telemetry.test/telemetry/tokens/status",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Ingest-Token": "a-pairing-token" }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ version: "0.1.0", platform: expect.any(String) });
  });

  it("does not throw when the status ping fails — pairing already succeeded server-side", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const agent = await import("./activity-agent");
    await expect(agent.pingStatus("https://telemetry.test", "token")).resolves.toBeUndefined();
  });
});
