import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * On-disk sticky state — and, above all, what is NOT on disk.
 *
 * The desktop notes regressed because a `dismissed` list lived in this file.
 * Anything in it was skipped by the auto-pin forever, and opening a task in the
 * inbox wrote to it, so merely READING an allocation retired its note for good
 * while the task was still outstanding. These tests pin down that the field is
 * gone, that an installation which already has one recovers on next launch, and
 * that `pinned` — the thing that genuinely must survive a restart — still does.
 */

let userDataDir: string;

vi.mock("electron", () => ({
  app: { getPath: (name: string) => (name === "userData" ? userDataDir : "/tmp") },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    on: () => {},
  },
}));

const stateFile = () => join(userDataDir, "sticky-state.json");

async function freshModule() {
  vi.resetModules();
  return import("./sticky-state");
}

/** Write a state file as an OLDER build would have left it, then boot on it. */
async function bootWith(contents: unknown) {
  writeFileSync(stateFile(), JSON.stringify(contents), "utf8");
  const mod = await freshModule();
  mod.initStickyState();
  return mod;
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), "sticky-state-"));
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("the dismissed list is gone", () => {
  it("exposes no way to record that a note was dismissed", async () => {
    const mod = await freshModule();
    // Named explicitly rather than checked by shape: these four are the API
    // that made a hide permanent, and re-adding any of them re-opens the bug.
    for (const gone of ["isDismissed", "getDismissed", "addDismissed", "removeDismissed"]) {
      expect(mod).not.toHaveProperty(gone);
    }
  });

  it("loads an OLD state file that still carries one, and ignores it", async () => {
    const mod = await bootWith({
      version: 1,
      geometry: {},
      pinned: ["task-a"],
      dismissed: ["task-a", "task-b"],
    });
    // The poisoned list evaporates; the pin it was suppressing survives, so the
    // note comes back on this very launch.
    expect(mod.getPinned()).toEqual(["task-a"]);
    expect(mod.isPinned("task-a")).toBe(true);
  });

  it("drops the field from disk on the next write", async () => {
    const mod = await bootWith({ version: 1, geometry: {}, pinned: [], dismissed: ["task-a"] });
    mod.addPinned("task-b");
    mod.flushSync();
    const onDisk = JSON.parse(readFileSync(stateFile(), "utf8"));
    expect(onDisk).not.toHaveProperty("dismissed");
    expect(onDisk.pinned).toEqual(["task-b"]);
  });
});

describe("a stale minimized flag is healed", () => {
  it("clears minimized on load, so a note cannot be invisible for good", async () => {
    // These windows are built minimizable:false + skipTaskbar:true, so a note
    // recorded as minimized has no taskbar button and no show path — it is
    // gone across every restart with the task still open.
    const mod = await bootWith({
      version: 1,
      pinned: ["task-a"],
      geometry: {
        "task-a": { x: 10, y: 10, width: 360, height: 200, minimized: true, lastSeenAt: Date.now() },
      },
    });
    expect(mod.getGeometry("task-a")?.minimized).toBe(false);
  });
});

describe("pinned survives, because an unfinished commitment must come back", () => {
  it("round-trips through a write and a fresh boot", async () => {
    const first = await freshModule();
    first.initStickyState();
    first.addPinned("task-a");
    first.addPinned("task-b");
    first.flushSync();

    const second = await freshModule();
    second.initStickyState();
    expect(second.getPinned()).toEqual(["task-a", "task-b"]);
  });

  it("is idempotent, so a re-pin cannot duplicate an id", async () => {
    const mod = await freshModule();
    mod.initStickyState();
    mod.addPinned("task-a");
    mod.addPinned("task-a");
    expect(mod.getPinned()).toEqual(["task-a"]);
  });

  it("survives a corrupted file rather than crashing the app", async () => {
    writeFileSync(stateFile(), "{ not json at all", "utf8");
    const mod = await freshModule();
    expect(() => mod.initStickyState()).not.toThrow();
    expect(mod.getPinned()).toEqual([]);
  });

  it("starts clean when there is no file yet", async () => {
    expect(existsSync(stateFile())).toBe(false);
    const mod = await freshModule();
    mod.initStickyState();
    expect(mod.getPinned()).toEqual([]);
  });
});
