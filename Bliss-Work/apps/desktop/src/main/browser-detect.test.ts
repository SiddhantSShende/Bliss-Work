import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

/**
 * browser-detect.ts, per OS branch. `process.platform` is forced per test
 * the same way macos-permissions.test.ts does — fresh module import after
 * each switch, since the module reads it live rather than caching it.
 */

let existsSyncImpl: (path: string) => boolean;
vi.mock("node:fs", () => ({
  existsSync: (p: string) => existsSyncImpl(p),
}));

let execFileImpl: (
  file: string,
  args: string[],
  cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
) => void;
vi.mock("node:child_process", () => ({
  execFile: (file: string, args: string[], cb: (...a: unknown[]) => void) => execFileImpl(file, args, cb as never),
}));

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("detectBrowsers", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    existsSyncImpl = () => false;
    execFileImpl = (_file, _args, cb) => cb(new Error("not found"));
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("reports Chrome installed on macOS when its bundle path exists, and never touches the filesystem otherwise", async () => {
    setPlatform("darwin");
    existsSyncImpl = (p) => p === "/Applications/Google Chrome.app";
    const { detectBrowsers } = await import("./browser-detect");

    const result = await detectBrowsers();
    const chrome = result.find((b) => b.family === "chrome");
    const edge = result.find((b) => b.family === "edge");

    expect(chrome).toEqual({
      family: "chrome",
      label: "Google Chrome",
      path: "/Applications/Google Chrome.app",
      installed: true,
    });
    expect(edge?.installed).toBe(false);
    expect(edge?.path).toBeNull();
  });

  it("always reports Safari as installed on macOS — every install has it", async () => {
    setPlatform("darwin");
    existsSyncImpl = (p) => p === "/Applications/Safari.app";
    const { detectBrowsers } = await import("./browser-detect");

    const result = await detectBrowsers();
    expect(result.find((b) => b.family === "safari")?.installed).toBe(true);
  });

  it("omits Safari entirely on Linux rather than reporting it as not-installed", async () => {
    setPlatform("linux");
    const { detectBrowsers } = await import("./browser-detect");

    const result = await detectBrowsers();
    expect(result.some((b) => b.family === "safari")).toBe(false);
  });

  it("detects a Linux browser via `which` on PATH", async () => {
    setPlatform("linux");
    execFileImpl = (file, args, cb) => {
      if (file === "which" && args[0] === "firefox") return cb(null, { stdout: "/usr/bin/firefox\n", stderr: "" });
      cb(new Error("not found"));
    };
    const { detectBrowsers } = await import("./browser-detect");

    const result = await detectBrowsers();
    expect(result.find((b) => b.family === "firefox")).toEqual({
      family: "firefox",
      label: "Firefox",
      path: "/usr/bin/firefox",
      installed: true,
    });
  });

  it("checks Windows install paths under Program Files without shelling out", async () => {
    setPlatform("win32");
    // node:path.join uses the REAL OS's separator regardless of the faked
    // process.platform (it isn't what join() consults) — building the
    // expected path the same way production code does, rather than
    // hardcoding a literal Windows string, keeps this test OS-independent.
    const expected = join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
    existsSyncImpl = (p) => p === expected;
    const { detectBrowsers } = await import("./browser-detect");

    const result = await detectBrowsers();
    expect(result.find((b) => b.family === "chrome")).toEqual({
      family: "chrome",
      label: "Google Chrome",
      path: expected,
      installed: true,
    });
  });

  it("returns an empty list on an unsupported platform rather than guessing", async () => {
    setPlatform("freebsd" as NodeJS.Platform);
    const { detectBrowsers } = await import("./browser-detect");

    expect(await detectBrowsers()).toEqual([]);
  });
});

describe("launchBrowser", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("passes the URL as a literal argv entry, never through a shell", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    execFileImpl = (file, args, cb) => {
      calls.push({ file, args });
      cb(null, { stdout: "", stderr: "" });
    };
    const { launchBrowser } = await import("./browser-detect");

    await launchBrowser("/Applications/Google Chrome.app", "https://communication.rnrtechs.com/login");

    expect(calls).toEqual([
      { file: "/Applications/Google Chrome.app", args: ["https://communication.rnrtechs.com/login"] },
    ]);
  });
});
