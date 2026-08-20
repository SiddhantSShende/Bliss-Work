/**
 * The meeting tab's identity and its exit.
 *
 * The bug these pin: `openCallTab` severs `window.opener` on the way out, and
 * the meeting tab used that same property to decide whether it was allowed to
 * close itself. It never was — so ending a meeting navigated the meeting tab to
 * /app instead of closing it, and every finished meeting left a second copy of
 * BlissWork open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENED_BY_APP_PARAM,
  callPath,
  closeMeetingTab,
  forgetMeetingTab,
  isMeetingTab,
  openCallTab,
  rememberMeetingTab,
} from "./callWindow";

const WEB = { kind: "web", router: "browser" } as const;

beforeEach(() => {
  window.sessionStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("openCallTab", () => {
  it("marks the URL so the opened tab can recognise itself", () => {
    const opened = { opener: {} as unknown, focus: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);

    expect(openCallTab("call-1", WEB)).toBe(true);

    const [url, name] = open.mock.calls[0]!;
    expect(String(url)).toContain(`${OPENED_BY_APP_PARAM}=1`);
    expect(String(url)).toContain(callPath("call-1"));
    // Named after the call so joining twice focuses the tab already in it.
    expect(name).toBe("bliss-call-call-1");
  });

  it("still severs the opener — which is why the URL flag has to exist", () => {
    const opened = { opener: {} as unknown, focus: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);

    openCallTab("call-1", WEB);

    expect(opened.opener).toBeNull();
  });

  it("reports a blocked pop-up rather than pretending it opened", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    expect(openCallTab("call-1", WEB)).toBe(false);
  });

  it("opens nothing on the desktop app, where a browser tab is not a thing", () => {
    const open = vi.spyOn(window, "open");
    expect(openCallTab("call-1", { kind: "electron", router: "hash" })).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the meeting-tab mark", () => {
  it("is absent until the tab is told what it is for", () => {
    expect(isMeetingTab()).toBe(false);
    rememberMeetingTab("call-1");
    expect(isMeetingTab()).toBe(true);
    forgetMeetingTab();
    expect(isMeetingTab()).toBe(false);
  });

  it("survives leaving the meeting route, so the tab can browse the app", () => {
    rememberMeetingTab("call-1");
    // Whatever the URL becomes, the tab still exists to hold the meeting.
    expect(isMeetingTab()).toBe(true);
  });
});

describe("closeMeetingTab", () => {
  it("closes a tab BlissWork opened, and does not navigate", () => {
    rememberMeetingTab("call-1");
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    const fallback = vi.fn();

    closeMeetingTab(fallback);

    expect(close).toHaveBeenCalled();
    // This is the regression: the old code navigated here, cloning the app.
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back for a bookmarked tab, which the browser will not let us close", () => {
    // No mark: this tab was reloaded or opened from a bookmark.
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    const fallback = vi.fn();

    closeMeetingTab(fallback);

    expect(close).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("falls back when the browser refuses the close, rather than leaving a dead page", () => {
    rememberMeetingTab("call-1");
    // close() is a request; a refusal is silent and leaves us running. jsdom
    // never really closes anything, so `closed` staying false IS the refusal.
    vi.spyOn(window, "close").mockImplementation(() => {});
    Object.defineProperty(window, "closed", { value: false, configurable: true });
    const fallback = vi.fn();

    closeMeetingTab(fallback);
    expect(fallback).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("clears the mark so a second exit cannot re-close an already-closed tab", () => {
    rememberMeetingTab("call-1");
    vi.spyOn(window, "close").mockImplementation(() => {});

    closeMeetingTab(vi.fn());

    expect(isMeetingTab()).toBe(false);
  });
});
