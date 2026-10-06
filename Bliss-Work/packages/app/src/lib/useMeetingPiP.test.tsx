/**
 * Regression coverage for Picture-in-Picture mechanics.
 *
 * The bug these pin: the PiP button "did nothing". Chromium's
 * `requestPictureInPicture()` rejects with InvalidStateError until the element
 * has loaded metadata (verified against real Chromium), the hook issued the
 * request immediately and swallowed the rejection, and the button stayed lit
 * even when there was no video anywhere to float.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "livekit-client";
import type { RoomParticipant } from "./useCallRoom";
import { pickPipTrack, useMeetingPiP } from "./useMeetingPiP";

function fakeTrack(id: string) {
  return { attach: vi.fn(), detach: vi.fn(), mediaStreamTrack: { id } } as unknown as Track & {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  };
}

function person(identity: string, over: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    identity, name: identity, isLocal: false, speaking: false, micOn: true, camOn: false,
    sharing: false, videoTrack: null, screenTrack: null, audioTrack: null, ...over,
  };
}

// jsdom implements none of the Picture-in-Picture API, so each test installs
// the slice the hook touches and chooses what the element's readyState says.
let readyState = 4;
let requestPiP: ReturnType<typeof vi.fn>;
let exitPiP: ReturnType<typeof vi.fn>;
let pipElement: Element | null;

beforeEach(() => {
  readyState = 4;
  pipElement = null;
  requestPiP = vi.fn(async function (this: HTMLVideoElement) {
    pipElement = this;
    this.dispatchEvent(new Event("enterpictureinpicture"));
  });
  exitPiP = vi.fn(async () => {
    const el = pipElement;
    pipElement = null;
    el?.dispatchEvent(new Event("leavepictureinpicture"));
  });
  HTMLVideoElement.prototype.requestPictureInPicture = requestPiP as never;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => readyState });
  Object.defineProperty(document, "pictureInPictureEnabled", { configurable: true, value: true });
  Object.defineProperty(document, "pictureInPictureElement", { configurable: true, get: () => pipElement });
  Object.defineProperty(document, "exitPictureInPicture", { configurable: true, value: exitPiP });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLMediaElement.prototype, "readyState");
  Reflect.deleteProperty(document, "pictureInPictureEnabled");
  Reflect.deleteProperty(document, "pictureInPictureElement");
  Reflect.deleteProperty(document, "exitPictureInPicture");
});

const hiddenVideo = () => document.querySelector("video") as HTMLVideoElement;

describe("useMeetingPiP — availability", () => {
  it("is unavailable with no video to float, and available once there is one", () => {
    const { result, rerender } = renderHook(({ t }) => useMeetingPiP(t, true), {
      initialProps: { t: null as Track | null },
    });
    expect(result.current.supported).toBe(true);
    expect(result.current.available).toBe(false);
    rerender({ t: fakeTrack("v1") });
    expect(result.current.available).toBe(true);
  });

  it("is never available where the browser has no Picture-in-Picture", () => {
    Object.defineProperty(document, "pictureInPictureEnabled", { configurable: true, value: false });
    const { result } = renderHook(() => useMeetingPiP(fakeTrack("v1"), true));
    expect(result.current.supported).toBe(false);
    expect(result.current.available).toBe(false);
  });

  it("stays available while in PiP even if the video went away, so the click can leave it", async () => {
    const track = fakeTrack("v1");
    const { result, rerender } = renderHook(({ t }) => useMeetingPiP(t, true), {
      initialProps: { t: track as Track | null },
    });
    await act(async () => { await result.current.enter(); });
    expect(result.current.active).toBe(true);
    rerender({ t: null });
    expect(result.current.available).toBe(true);
  });
});

describe("useMeetingPiP — entering", () => {
  it("requests PiP on the element the track is attached to", async () => {
    const track = fakeTrack("v1");
    const { result } = renderHook(() => useMeetingPiP(track, true));
    expect(track.attach).toHaveBeenCalledWith(hiddenVideo());

    let ok = false;
    await act(async () => { ok = await result.current.enter(); });
    expect(ok).toBe(true);
    expect(requestPiP.mock.contexts[0]).toBe(hiddenVideo());
    expect(result.current.active).toBe(true);
  });

  it("issues the request inside the click when the picture is already loaded", () => {
    const { result } = renderHook(() => useMeetingPiP(fakeTrack("v1"), true));
    act(() => { void result.current.enter(); });
    expect(requestPiP).toHaveBeenCalledTimes(1);
  });

  it("waits for the first frame instead of being refused for missing metadata", async () => {
    readyState = 0;
    const { result } = renderHook(() => useMeetingPiP(fakeTrack("v1"), true));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.enter(); });
    expect(requestPiP).not.toHaveBeenCalled();

    await act(async () => {
      readyState = 1;
      hiddenVideo().dispatchEvent(new Event("loadedmetadata"));
      expect(await pending).toBe(true);
    });
    expect(requestPiP).toHaveBeenCalledTimes(1);
  });

  it("gives up cleanly, without requesting, when no frame ever arrives", async () => {
    vi.useFakeTimers();
    readyState = 0;
    const { result } = renderHook(() => useMeetingPiP(fakeTrack("v1"), true));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.enter(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(await pending).toBe(false);
    expect(requestPiP).not.toHaveBeenCalled();
    // And it is not wedged: a later click can try again.
    readyState = 4;
    await act(async () => { expect(await result.current.enter()).toBe(true); });
  });

  it("does not request anything without a track or without browser support", async () => {
    const none = renderHook(() => useMeetingPiP(null, true));
    await act(async () => { expect(await none.result.current.enter()).toBe(false); });

    Object.defineProperty(document, "pictureInPictureEnabled", { configurable: true, value: false });
    const unsupported = renderHook(() => useMeetingPiP(fakeTrack("v1"), true));
    await act(async () => { expect(await unsupported.result.current.enter()).toBe(false); });
    expect(requestPiP).not.toHaveBeenCalled();
  });

  it("reports a browser refusal as false rather than throwing", async () => {
    requestPiP.mockRejectedValueOnce(new DOMException("no gesture", "NotAllowedError"));
    const { result } = renderHook(() => useMeetingPiP(fakeTrack("v1"), true));
    await act(async () => { expect(await result.current.enter()).toBe(false); });
    expect(result.current.active).toBe(false);
  });

  it("makes one request for two concurrent calls", async () => {
    readyState = 0;
    const { result } = renderHook(() => useMeetingPiP(fakeTrack("v1"), true));
    let a!: Promise<boolean>;
    let b!: Promise<boolean>;
    act(() => { a = result.current.enter(); b = result.current.enter(); });
    await act(async () => {
      readyState = 1;
      hiddenVideo().dispatchEvent(new Event("loadedmetadata"));
      await Promise.all([a, b]);
    });
    expect(requestPiP).toHaveBeenCalledTimes(1);
    expect(await b).toBe(false);
  });
});

describe("useMeetingPiP — leaving", () => {
  it("toggle enters, then exits", async () => {
    const { result } = renderHook(() => useMeetingPiP(fakeTrack("v1"), true));
    await act(async () => { result.current.toggle(); });
    expect(result.current.active).toBe(true);

    await act(async () => { result.current.toggle(); });
    expect(exitPiP).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(false);
  });

  it("exits when the call stops being enabled", async () => {
    const { result, rerender } = renderHook(({ on }) => useMeetingPiP(fakeTrack("v1"), on), {
      initialProps: { on: true },
    });
    await act(async () => { await result.current.enter(); });
    await act(async () => { rerender({ on: false }); });
    expect(exitPiP).toHaveBeenCalled();
    expect(result.current.active).toBe(false);
  });
});

describe("useMeetingPiP — follows the live picture", () => {
  it("re-attaches when LiveKit swaps the MediaStreamTrack under the same wrapper", () => {
    const track = fakeTrack("old");
    const { rerender } = renderHook(({ t }) => useMeetingPiP(t, true), { initialProps: { t: track as Track } });
    expect(track.attach).toHaveBeenCalledTimes(1);
    (track.mediaStreamTrack as { id: string }).id = "new";
    rerender({ t: track });
    expect(track.detach).toHaveBeenCalledTimes(1);
    expect(track.attach).toHaveBeenCalledTimes(2);
  });

  it("moves to the new track when the stage changes, detaching the old one", () => {
    const a = fakeTrack("a");
    const b = fakeTrack("b");
    const { rerender } = renderHook(({ t }) => useMeetingPiP(t, true), { initialProps: { t: a as Track } });
    rerender({ t: b });
    expect(a.detach).toHaveBeenCalledWith(hiddenVideo());
    expect(b.attach).toHaveBeenCalledWith(hiddenVideo());
  });
});

describe("pickPipTrack", () => {
  const cam = (id: string, over: Partial<RoomParticipant> = {}) =>
    person(id, { camOn: true, videoTrack: fakeTrack(`cam-${id}`), ...over });

  it("prefers the stage participant's own picture", () => {
    const a = cam("a");
    const b = cam("b");
    expect(pickPipTrack(a, [a, b])).toBe(a.videoTrack);
  });

  it("prefers a stage screen share over that participant's camera", () => {
    const a = cam("a", { sharing: true, screenTrack: fakeTrack("screen-a") });
    expect(pickPipTrack(a, [a])).toBe(a.screenTrack);
  });

  it("falls back to someone with video when the stage is an avatar", () => {
    const quiet = person("quiet");
    const b = cam("b");
    expect(pickPipTrack(quiet, [quiet, b])).toBe(b.videoTrack);
  });

  it("falls back when there is no stage at all", () => {
    const b = cam("b");
    expect(pickPipTrack(undefined, [person("a"), b])).toBe(b.videoTrack);
  });

  it("prefers a remote screen share, then remote cameras, then the local camera", () => {
    const me = cam("me", { isLocal: true });
    const remoteCam = cam("r");
    const sharer = cam("s", { sharing: true, screenTrack: fakeTrack("screen-s") });
    expect(pickPipTrack(undefined, [me, remoteCam, sharer])).toBe(sharer.screenTrack);
    expect(pickPipTrack(undefined, [me, remoteCam])).toBe(remoteCam.videoTrack);
    expect(pickPipTrack(undefined, [me])).toBe(me.videoTrack);
  });

  it("never picks the local sharer's own screen", () => {
    const me = cam("me", { isLocal: true, sharing: true, screenTrack: fakeTrack("screen-me") });
    expect(pickPipTrack(me, [me])).toBeNull();
  });

  it("is null when nobody has a camera or screen on", () => {
    const a = person("a");
    expect(pickPipTrack(a, [a, person("b")])).toBeNull();
  });

  it("ignores a camera that is muted even though its track object still exists", () => {
    const off = person("off", { camOn: false, videoTrack: fakeTrack("stale") });
    expect(pickPipTrack(off, [off])).toBeNull();
  });
});
