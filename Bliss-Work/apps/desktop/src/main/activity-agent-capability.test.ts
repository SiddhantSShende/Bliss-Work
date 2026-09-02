import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `capability()`'s reporting of the 0.2.2/0.2.3 silent-stub failure mode.
 *
 * A separate file from activity-agent.test.ts on purpose: that file's
 * `vi.mock("./foreground", ...)` is fixed (`providerUnavailableReason: () =>
 * null`) and shared across a couple dozen tests exercising the sampler's own
 * narrative; this file needs a DIFFERENT, per-test answer from that same
 * function, which is simplest as its own isolated module registry rather than
 * retrofitting a mock two dozen other tests already depend on.
 *
 * The bug this guards: `capability()` used to compute `appTracking = !!win` —
 * whether the module IMPORTED, not whether it ANSWERS anything. A native
 * binding built for the wrong platform imports fine and then silently never
 * resolves a window (see foreground.ts's own stub-detection, added for the
 * same incident), so `providerUnavailableReason()` can be non-null even while
 * `win` is truthy. Before this fix, that combination reported
 * `appTracking: true, reason: null` — which suppresses the Settings warning
 * banner (`DeviceActivitySettings.tsx`, gated on `!appTracking`) for a
 * capability that provably does not work.
 */

let mockWin: { activeWindow: () => Promise<unknown> } | null = { activeWindow: async () => undefined };
let mockReason: string | null = null;

vi.mock("electron", () => ({ app: { getVersion: () => "0.1.0" } }));
vi.mock("./foreground", () => ({
  loadProvider: async () => mockWin,
  providerUnavailableReason: () => mockReason,
}));
vi.mock("./macos-permissions", () => ({
  screenRecordingStatus: async () => "granted",
  describeStatus: () => "unused in these tests",
}));

async function capabilityFor(platform: NodeJS.Platform) {
  vi.resetModules();
  vi.stubGlobal("process", { ...process, platform });
  const { capability } = await import("./activity-agent");
  return capability();
}

beforeEach(() => {
  mockWin = { activeWindow: async () => undefined };
  mockReason = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("capability() and the silent-stub failure mode", () => {
  it("reports tracking available when the module loaded and nothing has flagged it", async () => {
    const cap = await capabilityFor("win32");
    expect(cap.appTracking).toBe(true);
    expect(cap.reason).toBeNull();
  });

  it("reports unavailable when the module never loaded at all (the old, already-handled case)", async () => {
    mockWin = null;
    mockReason = "app tracking is unavailable in this build";
    const cap = await capabilityFor("win32");
    expect(cap.appTracking).toBe(false);
    expect(cap.reason).toBe(mockReason);
    expect(cap.titleTracking).toBe(false);
  });

  it("ALSO reports unavailable when the module loaded but foreground's stub-detector flagged it", async () => {
    // The regression this test exists for: `win` is truthy (mockWin is set),
    // but the consecutive-empty-read heuristic in foreground.ts has since
    // populated providerUnavailableReason(). appTracking must still end up
    // false, or DeviceActivitySettings.tsx's warning banner never renders.
    mockWin = { activeWindow: async () => undefined }; // loaded fine
    mockReason = "the native window-reading module loaded but never returns anything (likely built for the wrong platform)";
    const cap = await capabilityFor("win32");
    expect(cap.appTracking).toBe(false);
    expect(cap.reason).toBe(mockReason);
    expect(cap.titleTracking).toBe(false);
    expect(cap.titleTrackingReason).toBe(mockReason);
  });

  it("does the same on darwin, without going anywhere near Screen Recording status", async () => {
    mockWin = { activeWindow: async () => undefined };
    mockReason = "the native window-reading module loaded but never returns anything (likely built for the wrong platform)";
    const cap = await capabilityFor("darwin");
    expect(cap.appTracking).toBe(false);
    expect(cap.reason).toBe(mockReason);
  });
});
