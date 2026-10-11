import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * MeetingInviteManager's `adhoc` plumbing: the one new field in the invite
 * popup's lifecycle, on top of decideInviteAction's existing open/update/
 * ignore behaviour (which this does not re-test).
 *
 * Only the Electron boundary is faked (the `electron` module itself, plus
 * ./harden and ./assets, both of which are pure Electron side effects
 * irrelevant to what is under test here) — same approach as
 * sticky-manager.test.ts's own header.
 */

interface FakeWindow {
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
  isDestroyed: () => boolean;
  destroyed: boolean;
}

const h = vi.hoisted(() => ({ windows: [] as FakeWindow[] }));

vi.mock("electron", () => ({
  BrowserWindow: class {
    loadFile = vi.fn();
    loadURL = vi.fn();
    webContents = { send: vi.fn() };
    destroyed = false;
    isDestroyed = () => this.destroyed;
    close = () => void (this.destroyed = true);
    destroy = () => void (this.destroyed = true);
    setAlwaysOnTop = () => {};
    setPosition = () => {};
    on = () => {};
    constructor() {
      h.windows.push(this as unknown as FakeWindow);
    }
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}));
vi.mock("./harden", () => ({ hardenWindow: vi.fn() }));
vi.mock("./assets", () => ({ appIcon: () => undefined }));

import { MeetingInviteManager } from "./meeting-invite-manager";

const invite = (over: Partial<{ callId: string; title: string; organizer: string; adhoc: boolean }> = {}) => ({
  callId: "call-1",
  title: "Standup",
  organizer: "Ada",
  ...over,
});

beforeEach(() => {
  h.windows.length = 0;
});

describe("MeetingInviteManager — adhoc", () => {
  it("carries adhoc=1 in the loaded page's query string for an ad-hoc call", () => {
    const m = new MeetingInviteManager();
    m.show(invite({ adhoc: true }));

    expect(h.windows).toHaveLength(1);
    const [, opts] = h.windows[0]!.loadFile.mock.calls[0]!;
    expect((opts as { search: string }).search).toContain("adhoc=1");
  });

  it("carries adhoc=0 for a Meeting, and when adhoc is simply omitted", () => {
    const m = new MeetingInviteManager();
    m.show(invite());

    const [, opts] = h.windows[0]!.loadFile.mock.calls[0]!;
    expect((opts as { search: string }).search).toContain("adhoc=0");
  });

  it("forwards adhoc on an update to the SAME callId, over IPC rather than a reload", () => {
    const m = new MeetingInviteManager();
    m.show(invite({ adhoc: false }));
    m.show(invite({ adhoc: true, organizer: "Grace" })); // same callId: an update, not a new window

    expect(h.windows).toHaveLength(1); // no second window opened
    const sends = h.windows[0]!.webContents.send.mock.calls;
    const update = sends.find((c) => c[0] === "meeting-invite:update");
    expect(update?.[1]).toMatchObject({ adhoc: true, organizer: "Grace" });
  });
});
