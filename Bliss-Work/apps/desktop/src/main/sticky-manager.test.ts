import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionsFor, type AssigneeStatus, type StickyTaskDTO } from "@taskboard/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auto-pin / Unpin behaviour of the desktop task popup.
 *
 * Only the Electron boundary is faked (the `electron` module and the window
 * factory) — StickyManager and sticky-state are the real ones, and state is
 * written to a real temp directory. "Restart" re-imports both modules and
 * re-reads that directory, which is what makes the persistence assertions mean
 * something.
 */

interface FakeWindow {
  closed: boolean;
  /** Every carousel payload main pushed, oldest first. */
  pushed: { tasks: StickyTaskDTO[]; index: number }[];
}

const h = vi.hoisted(() => ({ userData: "", windows: [] as unknown[] }));

vi.mock("electron", () => ({
  app: { getPath: () => h.userData },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}));

vi.mock("./windows", () => ({
  createStickyWindow: () => {
    const fake: FakeWindow = { closed: false, pushed: [] };
    h.windows.push(fake);
    return {
      isDestroyed: () => fake.closed,
      close: () => void (fake.closed = true),
      destroy: () => void (fake.closed = true),
      setBounds: () => {},
      setPosition: () => {},
      getBounds: () => ({ x: 0, y: 0, width: 380, height: 200 }),
      isMinimized: () => false,
      setMinimumSize: () => {},
      setResizable: () => {},
      on: () => {},
      webContents: {
        // The page "finishes loading" at once, which is when StickyManager pushes
        // the carousel — without it the fake window would never receive a payload.
        once: (_event: string, cb: () => void) => cb(),
        send: (_channel: string, payload: FakeWindow["pushed"][number]) => fake.pushed.push(payload),
      },
    };
  },
}));

const windows = () => h.windows as FakeWindow[];

function task(id: string, status: AssigneeStatus = "SENT"): StickyTaskDTO {
  return {
    taskId: id,
    orgId: "00000000-0000-4000-8000-000000000002",
    title: `Task ${id}`,
    description: "",
    senderId: "00000000-0000-4000-8000-000000000001",
    senderUsername: "sender",
    myStatus: status,
    actions: actionsFor(status),
    statusVersion: 1,
    participants: [],
    assignedAt: "2026-09-19T00:00:00.000Z",
    acknowledgedAt: null,
  };
}

/** Boot the app's sticky layer from whatever is on disk — a fresh launch. */
async function launch() {
  vi.resetModules();
  h.windows.length = 0;
  const state = await import("./sticky-state");
  state.initStickyState();
  const { StickyManager } = await import("./sticky-manager");
  return { manager: new StickyManager(), state };
}

/** The task ids the popup is currently showing, in carousel order. */
function shown(): string[] {
  const live = windows().filter((w) => !w.closed);
  const last = live.at(-1)?.pushed.at(-1);
  return last ? last.tasks.map((t) => t.taskId) : [];
}

beforeEach(() => {
  h.userData = mkdtempSync(join(tmpdir(), "sticky-test-"));
});

afterEach(() => {
  rmSync(h.userData, { recursive: true, force: true });
});

describe("auto-pin", () => {
  it("pins a newly received task and shows it in the popup with no manual step", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a")], { live: true });

    expect(state.getPinned()).toEqual(["a"]);
    expect(shown()).toEqual(["a"]);
    expect(windows().filter((w) => !w.closed)).toHaveLength(1);
  });

  it("pins every task in a burst into the SAME popup", async () => {
    const { manager, state } = await launch();
    manager.setTasks(["a", "b", "c", "d", "e", "f"].map((id) => task(id)), { live: true });

    expect(shown()).toEqual(["a", "b", "c", "d", "e"]);
    expect(state.getPinned()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(windows()).toHaveLength(1);
  });

  it("slides the five-task render window across the complete pinned set", async () => {
    const { manager } = await launch();
    manager.setTasks(["a", "b", "c", "d", "e", "f"].map((id) => task(id)), { live: true });

    manager.next();
    expect(shown()).toEqual(["a", "b", "c", "d", "e"]);
    manager.next();
    expect(shown()).toEqual(["a", "b", "c", "d", "e"]);
    manager.next();
    expect(shown()).toEqual(["b", "c", "d", "e", "f"]);
  });

  it("does not pin off the bootstrap cache (a stale snapshot)", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a")]);

    expect(state.getPinned()).toEqual([]);
    expect(shown()).toEqual([]);
  });

  it("brings pinned tasks back after a restart, from the cache alone", async () => {
    const first = await launch();
    first.manager.setTasks([task("a"), task("b")], { live: true });
    first.state.flushSync();

    const second = await launch();
    second.manager.setTasks([task("a"), task("b")]); // bootstrap: getTasks() from cache

    expect(shown()).toEqual(["a", "b"]);
  });
});

describe("Unpin", () => {
  it("removes the task from the popup immediately and from the persisted pinned set", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a"), task("b")], { live: true });

    manager.unpin("a");

    expect(shown()).toEqual(["b"]);
    expect(state.getPinned()).toEqual(["b"]);
    expect(state.isUnpinned("a")).toBe(true);
  });

  it("closes the popup when the last pinned task is unpinned", async () => {
    const { manager } = await launch();
    manager.setTasks([task("a")], { live: true });

    manager.unpin("a");

    expect(windows().every((w) => w.closed)).toBe(true);
  });

  it("is NOT undone by the next live server push", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a"), task("b")], { live: true });
    manager.unpin("a");

    manager.setTasks([task("a"), task("b"), task("c")], { live: true });

    expect(shown()).toEqual(["b", "c"]);
    expect(state.getPinned()).not.toContain("a");
  });

  it("is NOT undone by a server read that also says UNPINNED", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a")], { live: true });
    manager.unpin("a");

    manager.applyServerPinState({ pinned: [], unpinned: ["a"] });
    manager.setTasks([task("a")], { live: true });

    expect(state.getPinned()).toEqual([]);
    expect(shown()).toEqual([]);
  });

  it("is NOT undone by an acknowledge-driven pin request", async () => {
    const { manager } = await launch();
    manager.setTasks([task("a")], { live: true });
    manager.unpin("a");

    const res = manager.pin("a");

    expect(res).toMatchObject({ ok: false, reason: "unpinned", pinned: [] });
    expect(shown()).toEqual([]);
  });

  it("survives a restart, while other pinned tasks still come back", async () => {
    const first = await launch();
    first.manager.setTasks([task("a"), task("b")], { live: true });
    first.manager.unpin("a");
    first.state.flushSync();

    const second = await launch();
    second.manager.setTasks([task("a"), task("b")]); // bootstrap
    expect(shown()).toEqual(["b"]);

    second.manager.setTasks([task("a"), task("b")], { live: true }); // first live push
    expect(shown()).toEqual(["b"]);
  });

  it("leaves the task itself alone — it is still counted as an active task", async () => {
    const { manager } = await launch();
    manager.setTasks([task("a")], { live: true });

    manager.unpin("a");

    expect(manager.taskCount()).toBe(1);
    expect(manager.taskFor("a")?.myStatus).toBe("SENT");
  });

  it("ignores a malformed id", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a")], { live: true });

    manager.unpin("");
    manager.unpin(undefined as unknown as string);

    expect(state.getPinned()).toEqual(["a"]);
    expect(state.getUnpinned()).toEqual([]);
  });

  it("is forgotten once the task leaves the actionable set, so a returning task pins again", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a")], { live: true });
    manager.unpin("a");

    manager.prunePinned([]); // completed / ignored elsewhere: absent from the live list
    expect(state.getUnpinned()).toEqual([]);

    manager.setTasks([task("a")], { live: true }); // reassigned
    expect(shown()).toEqual(["a"]);
  });

  it("does not consume a cap slot, so the next waiting task takes its place", async () => {
    const { manager } = await launch();
    const six = ["a", "b", "c", "d", "e", "f"].map((id) => task(id));
    manager.setTasks(six, { live: true });
    expect(shown()).toEqual(["a", "b", "c", "d", "e"]);

    manager.unpin("a");
    manager.setTasks(six, { live: true });

    expect(shown()).toEqual(["b", "c", "d", "e", "f"]);
  });
});

describe("shared pin state (sticky-svc is the authority)", () => {
  it("an Unpin made on ANOTHER device takes the note off this one", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a"), task("b")], { live: true });
    expect(shown()).toEqual(["a", "b"]);

    manager.applyServerPinState({ pinned: ["b"], unpinned: ["a"] });

    expect(shown()).toEqual(["b"]);
    expect(state.getPinned()).toEqual(["b"]);
    expect(state.isUnpinned("a")).toBe(true);
  });

  it("an Unpin from another device is not undone by this one's auto-pin on the next push", async () => {
    const { manager } = await launch();
    manager.setTasks([task("a")], { live: true });
    manager.applyServerPinState({ pinned: [], unpinned: ["a"] });

    manager.setTasks([task("a")], { live: true });

    expect(shown()).toEqual([]);
  });

  it("an explicit RE-pin (server PINNED after UNPINNED) clears the unpin and floats the note again", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a"), task("b")], { live: true });
    manager.unpin("a");
    expect(shown()).toEqual(["b"]);

    manager.applyServerPinState({ pinned: ["a", "b"], unpinned: [] });

    expect(state.isUnpinned("a")).toBe(false);
    expect(shown()).toEqual(["b", "a"].sort());
    expect(state.getPinned()).toContain("a");
  });

  it("an acknowledge-driven pin request works again after an explicit re-pin", async () => {
    const { manager } = await launch();
    manager.setTasks([task("a")], { live: true });
    manager.unpin("a");
    expect(manager.pin("a")).toMatchObject({ ok: false, reason: "unpinned" });

    manager.applyServerPinState({ pinned: ["a"], unpinned: [] });

    expect(manager.pin("a")).toMatchObject({ ok: true });
    expect(shown()).toEqual(["a"]);
  });

  it("restores a pin this machine has never seen (second device / reinstall)", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a")]); // bootstrap, nothing pinned yet

    manager.applyServerPinState({ pinned: ["a"], unpinned: [] });

    expect(state.getPinned()).toEqual(["a"]);
    expect(shown()).toEqual(["a"]);
  });

  it("says nothing about a task -> leaves it exactly as the local mirror has it", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a"), task("b")], { live: true });
    manager.unpin("b");

    manager.applyServerPinState({ pinned: [], unpinned: [] });

    expect(state.getPinned()).toEqual(["a"]);
    expect(state.isUnpinned("b")).toBe(true);
  });

  it("a re-pin arriving BEFORE its task list pages the carousel to it once the list lands", async () => {
    const { manager } = await launch();
    manager.setTasks([task("a"), task("b")], { live: true });
    manager.unpin("a");

    manager.applyServerPinState({ pinned: ["a", "b"], unpinned: [] });
    manager.setTasks([task("a"), task("b")], { live: true });

    expect(shown()).toContain("a");
  });

  it("never removes a note because a task finished -> only prunePinned does", async () => {
    const { manager, state } = await launch();
    manager.setTasks([task("a")], { live: true });

    manager.applyServerPinState({ pinned: [], unpinned: [] });
    expect(state.getPinned()).toEqual(["a"]);

    manager.prunePinned([]);
    expect(state.getPinned()).toEqual([]);
  });
});
