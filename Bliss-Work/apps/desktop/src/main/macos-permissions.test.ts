import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * macos-permissions.ts, exercised on every branch: darwin/non-darwin,
 * every ScreenRecordingStatus value, and the observation-vs-cache
 * disagreement `titleReadWorking` is specifically built to resolve.
 *
 * `process.platform` is forced per test via `Object.defineProperty` — the
 * module reads it live on every call rather than caching it at import time,
 * so this is safe without a module reset between platform switches.
 */

let mediaAccessStatus: "not-determined" | "granted" | "denied" | "restricted" | "unknown" | "bogus";
const getMediaAccessStatus = vi.fn((_mediaType: string) => mediaAccessStatus);

vi.mock("electron", () => ({
  systemPreferences: { getMediaAccessStatus: (t: string) => getMediaAccessStatus(t) },
}));

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("macos-permissions", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    mediaAccessStatus = "granted";
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe("screenRecordingStatus", () => {
    it("is 'not-applicable' on win32 without ever calling the macOS API", async () => {
      setPlatform("win32");
      const mod = await import("./macos-permissions");
      expect(await mod.screenRecordingStatus()).toBe("not-applicable");
      expect(getMediaAccessStatus).not.toHaveBeenCalled();
    });

    it("is 'not-applicable' on linux", async () => {
      setPlatform("linux");
      const mod = await import("./macos-permissions");
      expect(await mod.screenRecordingStatus()).toBe("not-applicable");
    });

    it.each(["not-determined", "granted", "denied", "restricted"] as const)(
      "passes through a recognised darwin status: %s",
      async (status) => {
        setPlatform("darwin");
        mediaAccessStatus = status;
        const mod = await import("./macos-permissions");
        expect(await mod.screenRecordingStatus()).toBe(status);
        expect(getMediaAccessStatus).toHaveBeenCalledWith("screen");
      },
    );

    it("maps an unrecognised value to 'unknown' rather than passing it through raw", async () => {
      setPlatform("darwin");
      mediaAccessStatus = "bogus";
      const mod = await import("./macos-permissions");
      expect(await mod.screenRecordingStatus()).toBe("unknown");
    });

    it("degrades to 'unknown' if the platform API itself throws", async () => {
      setPlatform("darwin");
      getMediaAccessStatus.mockImplementationOnce(() => {
        throw new Error("boom");
      });
      const mod = await import("./macos-permissions");
      expect(await mod.screenRecordingStatus()).toBe("unknown");
    });
  });

  describe("describeStatus", () => {
    it("gives a distinct, honest string for every status", async () => {
      const mod = await import("./macos-permissions");
      const statuses: Array<Parameters<typeof mod.describeStatus>[0]> = [
        "granted", "not-determined", "denied", "restricted", "not-applicable", "unknown",
      ];
      const described = statuses.map((s) => mod.describeStatus(s));
      expect(new Set(described).size).toBe(statuses.length); // no two share a message
      for (const text of described) expect(text.length).toBeGreaterThan(0);
    });
  });

  describe("screenRecordingSettingsUrl", () => {
    it("returns the stable x-apple.systempreferences deep link on darwin", async () => {
      const mod = await import("./macos-permissions");
      expect(mod.screenRecordingSettingsUrl("darwin")).toBe(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
    });

    it("returns null on win32/linux — no page to open, not an error", async () => {
      const mod = await import("./macos-permissions");
      expect(mod.screenRecordingSettingsUrl("win32")).toBeNull();
      expect(mod.screenRecordingSettingsUrl("linux")).toBeNull();
    });
  });

  describe("titleReadWorking", () => {
    it("is always true on non-darwin, regardless of anything else", async () => {
      setPlatform("win32");
      const mod = await import("./macos-permissions");
      expect(await mod.titleReadWorking()).toBe(true);
    });

    it("is false when the OS reports denied", async () => {
      setPlatform("darwin");
      mediaAccessStatus = "denied";
      const mod = await import("./macos-permissions");
      expect(await mod.titleReadWorking()).toBe(false);
    });

    it("is false when the OS reports restricted", async () => {
      setPlatform("darwin");
      mediaAccessStatus = "restricted";
      const mod = await import("./macos-permissions");
      expect(await mod.titleReadWorking()).toBe(false);
    });

    it("is false when never determined — no confirmed grant yet", async () => {
      setPlatform("darwin");
      mediaAccessStatus = "not-determined";
      const mod = await import("./macos-permissions");
      expect(await mod.titleReadWorking()).toBe(false);
    });

    it("is true when granted and no recent observation disagrees", async () => {
      setPlatform("darwin");
      mediaAccessStatus = "granted";
      const mod = await import("./macos-permissions");
      expect(await mod.titleReadWorking()).toBe(true);
    });

    it("trusts a recent OBSERVATION of a missing title over a stale 'granted' status", async () => {
      // This is the electron#36722 case: getMediaAccessStatus can go stale
      // after a revocation. The agent's own recent read is the tiebreaker.
      setPlatform("darwin");
      mediaAccessStatus = "granted";
      const mod = await import("./macos-permissions");
      mod.recordTitleObservation(false); // the last real read came back with NO title
      expect(await mod.titleReadWorking()).toBe(false);
    });

    it("trusts a recent observation that a title WAS present, confirming the grant", async () => {
      setPlatform("darwin");
      mediaAccessStatus = "granted";
      const mod = await import("./macos-permissions");
      mod.recordTitleObservation(true);
      expect(await mod.titleReadWorking()).toBe(true);
    });

    it("ignores a stale observation older than 5 minutes", async () => {
      setPlatform("darwin");
      mediaAccessStatus = "granted";
      vi.useFakeTimers();
      try {
        const mod = await import("./macos-permissions");
        mod.recordTitleObservation(false);
        vi.advanceTimersByTime(6 * 60_000);
        expect(await mod.titleReadWorking()).toBe(true); // falls back to the OS status alone
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("recordTitleObservation", () => {
    it("is a no-op off darwin — never throws, never affects anything", async () => {
      setPlatform("win32");
      const mod = await import("./macos-permissions");
      expect(() => mod.recordTitleObservation(false)).not.toThrow();
      expect(await mod.titleReadWorking()).toBe(true);
    });
  });
});
