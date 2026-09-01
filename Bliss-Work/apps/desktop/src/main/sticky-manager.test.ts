import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StickyTaskDTO, AssigneeStatus } from "@taskboard/shared";
import { FakeWindow, fakeScreen } from "../test/fake-window";

/**
 * THE PIN-SURVIVAL REGRESSION TESTS.
 *
 * The promise: a task assigned to you sticks to your desktop, and stays there
 * until you Complete or Ignore it. Nothing else takes it away — not reading it,
 * not closing the app, not restarting the machine.
 *
 * It was broken by a persisted "dismissed" list. Opening a task in the inbox
 * added it, and the auto-pin skipped anything in it forever, so a single click
 * on an inbox row permanently retired that task's note with the task still
 * outstanding. These tests state the promise directly, so the next person who
 * reaches for a persisted suppression list has to delete a named claim first.
 */

let userDataDir: string;

vi.mock("electron", () => ({
  app: { getPath: (n: string) => (n === "userData" ? userDataDir : "/tmp") },
  screen: fakeScreen,
}));

// The real ./windows pulls in window hardening, which touches globalShortcut and
// powerMonitor. This suite is about the MANAGER's policy — which notes exist and
// when — so the window itself is a double. What createStickyWindow asks the OS
// for is covered by ./sticky-windows.test.ts.
vi.mock("./windows", () => ({
  createStickyWindow: (taskId: string) => new FakeWindow({ taskId }),
  setNoteOnTop: (w: { setAlwaysOnTop: (f: boolean) => void }, onTop: boolean) =>
    w.setAlwaysOnTop(onTop),
}));

const task = (taskId: string, myStatus: AssigneeStatus = "SENT"): StickyTaskDTO => ({
  taskId,
  orgId: "00000000-0000-4000-8000-000000000001",
  title: "Task " + taskId,
  description: "",
  senderId: "00000000-0000-4000-8000-000000000002",
  senderUsername: "sender",
  senderDisplayName: "Sender",
  myStatus,
  actions: myStatus === "SENT" ? ["ACKNOWLEDGE", "IGNORE"] : ["COMPLETE"],
  statusVersion: 0,
  assignedAt: new Date().toISOString(),
  acknowledgedAt: null,
  reviewRating: null,
});

/** Boot a manager the way index.ts does, on whatever is currently on disk. */
async function boot() {
  vi.resetModules();
  const state = await import("./sticky-state");
  state.initStickyState();
  const { StickyManager } = await import("./sticky-manager");
  return { mgr: new StickyManager(), state };
}

/** Notes actually on screen right now. */
const live = () => FakeWindow.all.filter((w) => !w.isDestroyed());

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), "sticky-mgr-"));
  FakeWindow.reset();
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("an assigned task sticks to the desktop on its own", () => {
  it("floats a freshly assigned SENT task with no manual pin", async () => {
    const { mgr } = await boot();
    mgr.setTasks([task("t1")], { live: true });
    expect(live()).toHaveLength(1);
  });

  it("keeps floating it once acknowledged", async () => {
    const { mgr } = await boot();
    mgr.setTasks([task("t1")], { live: true });
    mgr.setTasks([task("t1", "ACKNOWLEDGED")], { live: true });
    expect(live()).toHaveLength(1);
  });

  it("does NOT auto-pin off the bootstrap cache, which may be stale", async () => {
    const { mgr } = await boot();
    mgr.setTasks([task("t1")]); // no { live: true }
    expect(live()).toHaveLength(0);
  });
});

describe("hiding a note is a decision about the note, not the task", () => {
  it("takes it off screen for the rest of this run", async () => {
    const { mgr } = await boot();
    mgr.setTasks([task("t1")], { live: true });
    mgr.hideForSession("t1");
    expect(live()).toHaveLength(0);
  });

  it("does not come straight back on the next live push", async () => {
    // The task is still pinned on disk, so reconcile() would recreate the
    // window on the very next task.* event unless the session hide is honoured
    // there too — which is what makes the X feel like it did anything at all.
    const { mgr } = await boot();
    mgr.setTasks([task("t1")], { live: true });
    mgr.hideForSession("t1");
    mgr.setTasks([task("t1")], { live: true });
    expect(live()).toHaveLength(0);
  });

  it("COMES BACK after a restart, because the task is still outstanding", async () => {
    // This is the regression, stated positively. A hide is a this-run decision;
    // an unfinished commitment is not something the app gets to forget.
    const first = await boot();
    first.mgr.setTasks([task("t1")], { live: true });
    first.mgr.hideForSession("t1");
    first.state.flushSync();
    expect(live()).toHaveLength(0);

    FakeWindow.reset();
    const second = await boot();
    second.mgr.setTasks([task("t1")], { live: true });
    expect(live()).toHaveLength(1);
  });

  it("can be brought back in the same run by pinning it again", async () => {
    const { mgr } = await boot();
    mgr.setTasks([task("t1")], { live: true });
    mgr.hideForSession("t1");
    const result = mgr.pin("t1");
    expect(result.ok).toBe(true);
    expect(live()).toHaveLength(1);
  });

  it("leaves the pin on disk, so nothing is lost by hiding", async () => {
    const { mgr, state } = await boot();
    mgr.setTasks([task("t1")], { live: true });
    mgr.hideForSession("t1");
    expect(state.isPinned("t1")).toBe(true);
  });
});

describe("only a terminal status removes a note for good", () => {
  it("tears it down when the server drops the task from the actionable list", async () => {
    const { mgr, state } = await boot();
    mgr.setTasks([task("t1")], { live: true });
    // Completing / ignoring / leaving is what makes /tasks/sticky stop
    // returning it; prunePinned is how that reaches the desktop.
    mgr.setTasks([], { live: true });
    mgr.prunePinned([]);
    expect(live()).toHaveLength(0);
    expect(state.isPinned("t1")).toBe(false);
  });

  it("stays gone after a restart once completed", async () => {
    const first = await boot();
    first.mgr.setTasks([task("t1")], { live: true });
    first.mgr.setTasks([], { live: true });
    first.mgr.prunePinned([]);
    first.state.flushSync();

    FakeWindow.reset();
    const second = await boot();
    second.mgr.setTasks([], { live: true });
    expect(live()).toHaveLength(0);
  });

  it("frees a task to float again if it is reassigned later", async () => {
    const { mgr } = await boot();
    mgr.setTasks([task("t1")], { live: true });
    mgr.hideForSession("t1");
    // Task leaves the actionable set entirely…
    mgr.prunePinned([]);
    FakeWindow.reset();
    // …and comes back. The hide should not outlive the task it was about.
    mgr.setTasks([task("t1")], { live: true });
    expect(live()).toHaveLength(1);
  });
});

describe("visibility follows the desktop, not the app's focus", () => {
  it("hides every note and drops always-on-top when another app comes forward", async () => {
    const { mgr } = await boot();
    mgr.setTasks([task("t1")], { live: true });
    const win = live()[0]!;
    mgr.setSafeToFloat(true); // the desktop is showing, so the note is up
    mgr.setSafeToFloat(false);
    expect(win.called("hide")).toBe(true);
    // Hiding alone would leave a note that is off screen but still topmost, so
    // anything revealing it flashes it over someone else's work.
    expect(win.called("setAlwaysOnTop", false)).toBe(true);
  });

  it("brings the same window back — never a new one — so position and state survive", async () => {
    const { mgr } = await boot();
    mgr.setTasks([task("t1")], { live: true });
    const win = live()[0]!;
    mgr.setSafeToFloat(true);
    mgr.setSafeToFloat(false);
    mgr.setSafeToFloat(true);
    expect(live()).toHaveLength(1);
    expect(live()[0]).toBe(win);
    expect(win.called("setAlwaysOnTop", true)).toBe(true);
  });
});

describe("the on-screen cap", () => {
  it("floats at most five notes, and does not let a hidden one hold a slot", async () => {
    const { mgr } = await boot();
    const many = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => task(id));
    mgr.setTasks(many, { live: true });
    expect(live()).toHaveLength(5);

    mgr.hideForSession("t1");
    mgr.setTasks(many, { live: true });
    expect(live()).toHaveLength(5);
  });
});

describe("a note recorded as minimized is never re-minimized", () => {
  it("ignores the stored flag instead of hiding the note for good", async () => {
    // The window is built minimizable:false + skipTaskbar:true, so minimizing
    // it strands it with no way back, across every restart.
    const first = await boot();
    first.state.addPinned("t1");
    first.state.saveGeometry("t1", {
      x: 10,
      y: 10,
      width: 360,
      height: 200,
      minimized: true,
    });
    first.state.flushSync();

    FakeWindow.reset();
    const second = await boot();
    second.mgr.setTasks([task("t1")], { live: true });
    expect(live()).toHaveLength(1);
    expect(live()[0]!.called("minimize")).toBe(false);
  });
});
