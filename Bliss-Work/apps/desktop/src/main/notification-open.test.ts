/**
 * What clicking an OS notification does.
 *
 * Electron itself is not available here, so the window and the renderer's
 * location are small fakes — but the code between them is the real thing:
 * main's `notificationPathFor` + `openNotificationTarget`, the IPC hand-off, and
 * the renderer's `hashForRoute`. A scenario is "the app is in state X showing
 * page P, the user clicks a popup" and the assertion is which page it ends on.
 */
import { describe, expect, it, vi } from "vitest";
import { hashForRoute } from "../shared/open-route";
import { notificationPathFor, popupFor } from "./notifier";
import { OPEN_ROUTE_CHANNEL, openNotificationTarget, type RouteWindow } from "./notification-open";

const ME = "me";
const CHANNEL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHANNEL_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const channelAdded = (notificationId: string, channelId: string | null, over: Record<string, unknown> = {}) => ({
  type: "notification.created",
  recipientId: ME,
  notificationId,
  kind: "CHANNEL_ADDED",
  text: "Jordan Doe added you to the channel alpha",
  ...(channelId ? { channelId } : {}),
  ...over,
});

describe("notificationPathFor", () => {
  it("is the added channel, from the record's channelId", () => {
    expect(notificationPathFor(channelAdded("n1", CHANNEL_A), ME)).toBe(`/app/channels/${CHANNEL_A}`);
  });

  it("is each notification's own target — nothing carries over between calls", () => {
    expect(notificationPathFor(channelAdded("n1", CHANNEL_A), ME)).toBe(`/app/channels/${CHANNEL_A}`);
    expect(notificationPathFor(channelAdded("n2", CHANNEL_C), ME)).toBe(`/app/channels/${CHANNEL_C}`);
    expect(notificationPathFor(channelAdded("n1", CHANNEL_A), ME)).toBe(`/app/channels/${CHANNEL_A}`);
  });

  it("never reads the destination from the text", () => {
    const sneaky = channelAdded("n1", CHANNEL_A, { text: `x added you to /app/channels/${CHANNEL_B}` });
    expect(notificationPathFor(sneaky, ME)).toBe(`/app/channels/${CHANNEL_A}`);
  });

  it("falls back to the channels list without a usable id, and refuses a forged one", () => {
    expect(notificationPathFor(channelAdded("n1", null), ME)).toBe("/app/channels");
    expect(notificationPathFor(channelAdded("n1", "../../login"), ME)).toBe("/app/channels");
  });

  it("covers the other kinds the popup already shows", () => {
    const dm = { type: "notification.created", recipientId: ME, notificationId: "n", kind: "DM_MESSAGE", text: "P: hi", conversationId: CHANNEL_A };
    const task = { type: "notification.created", recipientId: ME, notificationId: "n", kind: "TASK_ASSIGNED", text: "t", taskId: CHANNEL_A };
    expect(notificationPathFor(dm, ME)).toBe(`/app/chats/${CHANNEL_A}`);
    expect(notificationPathFor(task, ME)).toBe(`/app/mail/task/${CHANNEL_A}`);
  });

  it("has no target for someone else's record, a signed-out app, other events, or an unknown kind", () => {
    expect(notificationPathFor(channelAdded("n1", CHANNEL_A, { recipientId: "other" }), ME)).toBeNull();
    expect(notificationPathFor(channelAdded("n1", CHANNEL_A), null)).toBeNull();
    expect(notificationPathFor({ type: "channel.member.joined", userId: ME, channelId: CHANNEL_A }, ME)).toBeNull();
    expect(notificationPathFor(channelAdded("n1", CHANNEL_A, { kind: "SOMETHING_NEW" }), ME)).toBeNull();
    expect(notificationPathFor(null, ME)).toBeNull();
  });

  it("leaves the popup's own content exactly as it was", () => {
    expect(popupFor(channelAdded("n1", CHANNEL_A), ME)).toEqual({
      notificationId: "n1",
      title: "Channel update",
      body: "Jordan Doe added you to the channel alpha",
    });
  });
});

describe("hashForRoute — the renderer's side of the hand-off", () => {
  it("moves a window showing another channel to the target channel", () => {
    expect(hashForRoute(`/app/channels/${CHANNEL_A}`, `#/app/channels/${CHANNEL_B}`)).toBe(`#/app/channels/${CHANNEL_A}`);
  });

  it("moves a window that is not showing a channel at all", () => {
    expect(hashForRoute(`/app/channels/${CHANNEL_A}`, "#/app/mail")).toBe(`#/app/channels/${CHANNEL_A}`);
    expect(hashForRoute(`/app/channels/${CHANNEL_A}`, "")).toBe(`#/app/channels/${CHANNEL_A}`);
  });

  it("does nothing when the target is already open, so no history entry is added", () => {
    expect(hashForRoute(`/app/channels/${CHANNEL_A}`, `#/app/channels/${CHANNEL_A}`)).toBeNull();
  });

  it("refuses a route the app would not have produced", () => {
    for (const bad of ["/login", "//evil.example", "https://evil.example", "/app/settings", "/app/channels/x", "", null, 7]) {
      expect(hashForRoute(bad, "#/app/mail")).toBeNull();
    }
  });
});

// ── The whole click, with fakes for the window and the renderer ───────────

type Visibility = "focused-on-page" | "background" | "minimized" | "hidden-to-tray" | "closed";

function scenario(visibility: Visibility, page: string) {
  const renderer = { hash: page, history: [] as string[] };
  const listen = (channel: string, path: unknown) => {
    if (channel !== OPEN_ROUTE_CHANNEL) return;
    const next = hashForRoute(path, renderer.hash);
    if (next) {
      renderer.hash = next;
      renderer.history.push(next);
    }
  };
  const shown = { focused: visibility === "focused-on-page", visible: visibility !== "hidden-to-tray" && visibility !== "closed", minimized: visibility === "minimized" };
  const log: string[] = [];
  let loading = false;
  let onLoaded: (() => void) | null = null;
  let win: (RouteWindow & { destroyed: boolean }) | null = null;

  const makeWindow = (): RouteWindow & { destroyed: boolean } => ({
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: {
      isLoading: () => loading,
      once: (_event, cb) => { onLoaded = cb; },
      send: (channel, ...args) => { log.push(`send:${String(args[0])}`); listen(channel, args[0]); },
    },
  });

  if (visibility !== "closed") win = makeWindow();

  // Mirrors main/index.ts's focusMain(): create if gone, otherwise show,
  // restore and focus.
  const focus = vi.fn(() => {
    log.push("focus");
    if (!win || win.isDestroyed()) {
      win = makeWindow();
      loading = true; // a new window starts at the default route, still loading
      renderer.hash = "";
      return;
    }
    shown.visible = true;
    shown.minimized = false;
    shown.focused = true;
  });

  return {
    renderer, shown, log, focus,
    click: (path: string | null) => openNotificationTarget(path, focus, () => win),
    finishLoad: () => { loading = false; onLoaded?.(); },
    destroy: () => { if (win) win.destroyed = true; },
  };
}

describe("clicking an OS notification", () => {
  const target = `/app/channels/${CHANNEL_A}`;

  it("switches a focused app on another channel to the target channel", () => {
    const app = scenario("focused-on-page", `#/app/channels/${CHANNEL_B}`);
    app.click(notificationPathFor(channelAdded("n1", CHANNEL_A), ME));
    expect(app.renderer.hash).toBe(`#${target}`);
  });

  it.each(["background", "minimized", "hidden-to-tray"] as const)(
    "brings a %s app forward and opens the target channel",
    (visibility) => {
      const app = scenario(visibility, `#/app/channels/${CHANNEL_B}`);
      app.click(target);
      expect(app.log).toEqual(["focus", `send:${target}`]); // forward first, then route
      expect(app.shown).toEqual({ focused: true, visible: true, minimized: false });
      expect(app.renderer.hash).toBe(`#${target}`);
    },
  );

  it("opens the target from an app that is not showing a channel", () => {
    const app = scenario("background", "#/app/tasks/allocated");
    app.click(target);
    expect(app.renderer.hash).toBe(`#${target}`);
  });

  it("recreates a closed window and routes it once the page has loaded, not before", () => {
    const app = scenario("closed", "");
    app.click(target);
    expect(app.log).toEqual(["focus"]); // loading: nothing can hear the message yet
    expect(app.renderer.hash).toBe("");

    app.finishLoad();
    expect(app.log).toEqual(["focus", `send:${target}`]);
    expect(app.renderer.hash).toBe(`#${target}`);
  });

  it("adds no history entry when the target is already open", () => {
    const app = scenario("focused-on-page", `#${target}`);
    app.click(target);
    expect(app.renderer.history).toEqual([]);
    expect(app.renderer.hash).toBe(`#${target}`);
  });

  it("uses each popup's own target, however many came before it", () => {
    const app = scenario("background", `#/app/channels/${CHANNEL_B}`);
    app.click(notificationPathFor(channelAdded("n1", CHANNEL_A), ME));
    app.click(notificationPathFor(channelAdded("n2", CHANNEL_C), ME));
    expect(app.renderer.hash).toBe(`#/app/channels/${CHANNEL_C}`);
    app.click(notificationPathFor(channelAdded("n1", CHANNEL_A), ME));
    expect(app.renderer.hash).toBe(`#/app/channels/${CHANNEL_A}`);
  });

  it("only brings the app forward when the notification has no target", () => {
    const app = scenario("minimized", "#/app/channels/" + CHANNEL_B);
    app.click(null);
    expect(app.log).toEqual(["focus"]);
    expect(app.renderer.hash).toBe(`#/app/channels/${CHANNEL_B}`);
  });

  it("never sends a route the app would not have produced", () => {
    const app = scenario("background", "#/app/mail");
    app.click("https://evil.example");
    app.click("/login");
    expect(app.log).toEqual(["focus", "focus"]);
    expect(app.renderer.hash).toBe("#/app/mail");
  });

  it("does not send to a window that was destroyed while loading", () => {
    const app = scenario("closed", "");
    app.click(target);
    app.destroy();
    app.finishLoad();
    expect(app.log).toEqual(["focus"]);
    expect(app.renderer.hash).toBe("");
  });
});
