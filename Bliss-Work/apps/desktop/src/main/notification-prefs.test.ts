import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The main-process mirror of the renderer's "Desktop notifications" toggle
 * (packages/app/src/lib/notificationPrefs.ts). Exercises the real module
 * against a real temp file, matching activity-state.test.ts's own reasoning:
 * the atomic temp-then-rename write is part of what is being trusted here.
 */

let userDataDir: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : "/tmp"),
  },
}));

async function freshModule() {
  vi.resetModules();
  return import("./notification-prefs");
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), "notification-prefs-test-"));
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("notification-prefs", () => {
  it("defaults to enabled on a fresh install, matching the renderer's own default", async () => {
    const prefs = await freshModule();
    expect(prefs.getDesktopEnabled()).toBe(true);
  });

  it("persists a toggle across reloads of the same file", async () => {
    const first = await freshModule();
    first.setDesktopEnabled(false);

    const second = await freshModule();
    expect(second.getDesktopEnabled()).toBe(false);
  });

  it("writes the preference to disk under the documented shape", async () => {
    const prefs = await freshModule();
    prefs.setDesktopEnabled(false);

    const raw = JSON.parse(readFileSync(join(userDataDir, "notification-prefs.json"), "utf8"));
    expect(raw).toEqual({ desktopEnabled: false });
  });

  it("a corrupt file falls back to enabled rather than bricking startup", async () => {
    const first = await freshModule();
    first.setDesktopEnabled(false);
    const file = join(userDataDir, "notification-prefs.json");
    rmSync(file);
    writeFileSync(file, "{not json", "utf8");

    const second = await freshModule();
    expect(second.getDesktopEnabled()).toBe(true);
  });
});
