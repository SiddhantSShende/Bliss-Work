import { describe, expect, it } from "vitest";
import { FakeWindow } from "../test/fake-window";
import { forwardDeepLinkWhenReady } from "./deep-link-forwarder";

/**
 * THE COLD-START DROP REGRESSION.
 *
 * open-url (macOS) and second-instance (Windows/Linux) both call focusMain()
 * — which only constructs/shows the main window and returns synchronously —
 * then used to forward the deep link immediately. A link arriving before the
 * renderer's bundle has run far enough to register its deeplink:meeting
 * listener was sent to nobody and silently dropped for good.
 */

describe("forwardDeepLinkWhenReady", () => {
  it("sends immediately once the window has already finished loading", () => {
    const win = new FakeWindow();
    win.finishLoading(); // a window that has been sitting in the tray for a while
    const sent: Array<string | undefined> = [];
    forwardDeepLinkWhenReady(win as never, "taskboard://join?t=abc", (u) => sent.push(u));
    expect(sent).toEqual(["taskboard://join?t=abc"]);
  });

  it("defers a link that arrives before the renderer's listener is registered, and delivers it once ready", () => {
    // A freshly created window: createMainWindow's loadURL/loadFile already
    // kicked off synchronously, so it starts out loading (see FakeWindow).
    const win = new FakeWindow();
    const sent: Array<string | undefined> = [];
    forwardDeepLinkWhenReady(win as never, "taskboard://join?t=abc", (u) => sent.push(u));
    // Not sent yet — sending now would reach a renderer that has not run
    // main.tsx's module-level bridge.onMeetingDeepLink(...) yet.
    expect(sent).toEqual([]);

    win.finishLoading();
    expect(sent).toEqual(["taskboard://join?t=abc"]);
  });

  it("never delivers a deferred link twice", () => {
    const win = new FakeWindow();
    const sent: Array<string | undefined> = [];
    forwardDeepLinkWhenReady(win as never, "taskboard://invite?token=abc", (u) => sent.push(u));
    win.finishLoading();
    win.finishLoading(); // e.g. an HMR reload — must not replay the same link
    expect(sent).toEqual(["taskboard://invite?token=abc"]);
  });

  it("does nothing for a URL that is not one of our deep links", () => {
    const win = new FakeWindow();
    const sent: Array<string | undefined> = [];
    forwardDeepLinkWhenReady(win as never, undefined, (u) => sent.push(u));
    forwardDeepLinkWhenReady(win as never, "https://example.com", (u) => sent.push(u));
    win.finishLoading();
    // Nothing was ever queued, so finishing the load doesn't call send either
    // — a plain relaunch (second-instance with no link in argv) never wires
    // a needless listener.
    expect(sent).toEqual([]);
  });
});
