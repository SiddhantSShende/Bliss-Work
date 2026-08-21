/**
 * jsdom implements none of the Picture-in-Picture API, so every test here
 * stands in for the browser feature itself (document.pictureInPictureEnabled,
 * HTMLVideoElement.requestPictureInPicture, document.exitPictureInPicture) —
 * never for the meeting/LiveKit side, which is a real `Track`-shaped fake
 * exactly like CallTile's own tests use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Track } from "livekit-client";
import { useMeetingPiP } from "./useMeetingPiP";

function fakeTrack(): Track {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as Track;
}

/** Installs the PiP globals jsdom doesn't have. `enabled: false` simulates a
 *  browser with no Picture-in-Picture support at all (the property absent,
 *  as it is on a real unsupporting browser — not merely `false`). */
function installPiPGlobals({ enabled = true }: { enabled?: boolean } = {}) {
  const doc = document as unknown as {
    pictureInPictureEnabled?: boolean;
    pictureInPictureElement: Element | null;
    exitPictureInPicture?: () => Promise<void>;
  };
  if (enabled) doc.pictureInPictureEnabled = true;
  doc.pictureInPictureElement = null;

  HTMLVideoElement.prototype.play = vi.fn().mockResolvedValue(undefined);

  // Real browsers dispatch enter/leave events off the actual OS window
  // transition; the fake does it synchronously so the hook's own listeners
  // (which is what drives `active`) are exercised the same way.
  HTMLVideoElement.prototype.requestPictureInPicture = vi.fn(function (
    this: HTMLVideoElement,
  ) {
    doc.pictureInPictureElement = this;
    this.dispatchEvent(new Event("enterpictureinpicture"));
    return Promise.resolve({} as PictureInPictureWindow);
  });

  doc.exitPictureInPicture = vi.fn(() => {
    const el = doc.pictureInPictureElement;
    doc.pictureInPictureElement = null;
    if (el) el.dispatchEvent(new Event("leavepictureinpicture"));
    return Promise.resolve();
  });
}

function uninstallPiPGlobals() {
  const doc = document as unknown as { pictureInPictureEnabled?: boolean };
  delete doc.pictureInPictureEnabled;
}

beforeEach(() => {
  installPiPGlobals();
});

afterEach(() => {
  uninstallPiPGlobals();
  vi.restoreAllMocks();
});

describe("support detection", () => {
  it("reports supported when the browser exposes the API", () => {
    const { result } = renderHook(() => useMeetingPiP(fakeTrack(), true));
    expect(result.current.supported).toBe(true);
  });

  it("reports unsupported when the browser has no Picture-in-Picture at all", () => {
    uninstallPiPGlobals();
    const { result } = renderHook(() => useMeetingPiP(fakeTrack(), true));
    expect(result.current.supported).toBe(false);
  });

  it("never calls requestPictureInPicture when unsupported — a manual toggle stays a no-op", () => {
    uninstallPiPGlobals();
    const spy = vi.spyOn(HTMLVideoElement.prototype, "requestPictureInPicture");
    const { result } = renderHook(() => useMeetingPiP(fakeTrack(), true));
    act(() => result.current.toggle());
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.active).toBe(false);
  });
});

describe("manual trigger", () => {
  it("enters PiP on toggle and reports active", async () => {
    const { result } = renderHook(() => useMeetingPiP(fakeTrack(), true));
    await act(async () => {
      result.current.toggle();
    });
    expect(result.current.active).toBe(true);
    expect(HTMLVideoElement.prototype.requestPictureInPicture).toHaveBeenCalledTimes(1);
  });

  it("exits PiP on a second toggle", async () => {
    const { result } = renderHook(() => useMeetingPiP(fakeTrack(), true));
    await act(async () => {
      result.current.toggle();
    });
    expect(result.current.active).toBe(true);
    await act(async () => {
      result.current.toggle();
    });
    expect(result.current.active).toBe(false);
  });

  it("a rejected request is caught — no unhandled rejection, state stays inactive", async () => {
    HTMLVideoElement.prototype.requestPictureInPicture = vi
      .fn()
      .mockRejectedValue(new DOMException("Not allowed", "NotAllowedError"));
    const { result } = renderHook(() => useMeetingPiP(fakeTrack(), true));
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(result.current.active).toBe(false);
  });
});

describe("visibility-driven behaviour", () => {
  function hide() {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }
  function show() {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }
  afterEach(() => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("attempts PiP when the document is hidden", async () => {
    renderHook(() => useMeetingPiP(fakeTrack(), true));
    await act(async () => {
      hide();
      await Promise.resolve();
    });
    expect(HTMLVideoElement.prototype.requestPictureInPicture).toHaveBeenCalledTimes(1);
  });

  it("a blocked auto-attempt (no user gesture) is swallowed, not thrown", async () => {
    HTMLVideoElement.prototype.requestPictureInPicture = vi
      .fn()
      .mockRejectedValue(new DOMException("requires a user gesture", "NotAllowedError"));
    renderHook(() => useMeetingPiP(fakeTrack(), true));
    expect(() => hide()).not.toThrow();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("returning to the meeting exits an active PiP session", async () => {
    const { result } = renderHook(() => useMeetingPiP(fakeTrack(), true));
    await act(async () => {
      result.current.toggle();
    });
    expect(result.current.active).toBe(true);

    await act(async () => {
      show();
      await Promise.resolve();
    });
    expect(result.current.active).toBe(false);
  });
});

describe("leaving or ending the call", () => {
  it("exits an active PiP session as soon as `enabled` goes false, without waiting for unmount", async () => {
    const track = fakeTrack();
    const { result, rerender } = renderHook(({ enabled }) => useMeetingPiP(track, enabled), {
      initialProps: { enabled: true },
    });
    await act(async () => {
      result.current.toggle();
    });
    expect(result.current.active).toBe(true);

    await act(async () => {
      rerender({ enabled: false });
    });
    expect(document.exitPictureInPicture).toHaveBeenCalled();
  });

  it("detaches the track on unmount, cleaning up its listeners", () => {
    const track = fakeTrack();
    const { unmount } = renderHook(() => useMeetingPiP(track, true));
    unmount();
    expect(track.detach).toHaveBeenCalledTimes(1);
  });
});

describe("no second connection", () => {
  it("attaches the SAME track exactly once regardless of how many times PiP toggles", async () => {
    const track = fakeTrack();
    const { result } = renderHook(() => useMeetingPiP(track, true));
    await act(async () => {
      result.current.toggle();
    });
    await act(async () => {
      result.current.toggle();
    });
    await act(async () => {
      result.current.toggle();
    });
    // Entering/exiting PiP never re-attaches — it is the same element and the
    // same track connection throughout, which is the whole guarantee.
    expect(track.attach).toHaveBeenCalledTimes(1);
  });

  it("re-attaches only when the track itself changes (stage handed to someone else)", () => {
    const trackA = fakeTrack();
    const trackB = fakeTrack();
    const { rerender } = renderHook(({ track }) => useMeetingPiP(track, true), {
      initialProps: { track: trackA },
    });
    expect(trackA.attach).toHaveBeenCalledTimes(1);

    rerender({ track: trackB });
    expect(trackA.detach).toHaveBeenCalledTimes(1);
    expect(trackB.attach).toHaveBeenCalledTimes(1);
  });
});
