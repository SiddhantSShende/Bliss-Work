import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The guard-and-reload core, exercised directly — installChunkReloadRecovery
 * itself is just this wired to `vite:preloadError`, covered by the
 * "suppresses the event only when it actually reloads" case below.
 */
describe("reloadForStaleChunk", () => {
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
    reloadSpy = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload: reloadSpy });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reloads once and returns true", async () => {
    const { reloadForStaleChunk } = await import("./chunkReloadRecovery");
    expect(reloadForStaleChunk()).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("does not reload again within the loop-guard window, and returns false", async () => {
    const { reloadForStaleChunk } = await import("./chunkReloadRecovery");
    reloadForStaleChunk();
    reloadSpy.mockClear();

    expect(reloadForStaleChunk()).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("still recovers when sessionStorage is unavailable — just without the loop guard", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { reloadForStaleChunk } = await import("./chunkReloadRecovery");

    expect(reloadForStaleChunk()).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe("installChunkReloadRecovery", () => {
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
    reloadSpy = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload: reloadSpy });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reloads and suppresses the event on a genuine vite:preloadError", async () => {
    const { installChunkReloadRecovery } = await import("./chunkReloadRecovery");
    installChunkReloadRecovery();

    const event = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event);

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves the SECOND preloadError within the loop window unhandled, on purpose", async () => {
    // A genuinely-unreachable chunk (offline) must still surface as a
    // visible error rather than being silently swallowed forever.
    const { installChunkReloadRecovery } = await import("./chunkReloadRecovery");
    installChunkReloadRecovery();

    window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    reloadSpy.mockClear();
    const second = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(second);

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(second.defaultPrevented).toBe(false);
  });
});
