/**
 * Regression coverage for the LiveKit event wiring behind issue 1 (a screen
 * share that ends leaves the room stuck showing it), and for the ~12-minute
 * scheduled token-refresh reconnect (scheduleRefresh) — see useCallRoom.ts's
 * own module doc for why that refresh exists, why no in-place token-update
 * API exists to avoid it, and why it now holds and republishes the local
 * tracks across the gap instead of stopping and re-acquiring them.
 *
 * livekit-client unpublishes a remote track in two steps (see
 * RemoteTrackPublication.setTrack and RemoteParticipant.unpublishTrack in
 * node_modules/livekit-client/src): `track.stop()` runs FIRST — which sets
 * the underlying MediaStreamTrack's readyState to "ended" synchronously —
 * and only then does the publication clear its own `.track` and emit
 * TrackUnsubscribed, a tick before the publication is removed from the
 * participant altogether and TrackUnpublished fires. A resync that runs
 * during that in-between window sees a publication that still exists, still
 * reports `isMuted: false`, and still points at this same, already-stopped
 * track — indistinguishable from a genuinely live share unless something
 * checks the track itself rather than the SDK's bookkeeping.
 *
 * The fake Room below reproduces that exact two-step shape (a publication
 * that outlives its own track by one event) rather than a simplified
 * "sharing: true/false" toggle, so these tests exercise the real ordering
 * bug, not a paraphrase of it. It also reproduces enough of LOCAL publish/
 * unpublish/disconnect(stopTracks) semantics — verified directly against
 * node_modules/livekit-client before writing this (Room.d.ts:
 * `disconnect: (stopTracks?: boolean) => Promise<void>`; handleDisconnect's
 * shouldStopTracks branch calls `track.stopMonitor()` instead of
 * `detach()`+`stop()` when false) — to exercise scheduleRefresh's real
 * reconnect path, not a stand-in for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { DisconnectReason, Room, RoomEvent, Track } from "livekit-client";
import { ApiError } from "@taskboard/shared";
import { useCallRoom } from "./useCallRoom";

const h = vi.hoisted(() => ({
  api: {
    callToken: vi.fn(),
    leaveCall: vi.fn(async () => {}),
    stopScreenShare: vi.fn(async () => {}),
    startScreenShare: vi.fn(async () => {}),
    callTelemetrySetupComplete: vi.fn(async () => {}),
    callTelemetryReconnected: vi.fn(async () => {}),
    startCall: vi.fn(async () => {}),
    addCallParticipant: vi.fn(async () => {}),
  },
}));
vi.mock("./runtime", () => ({
  useRuntime: () => ({ api: h.api, ws: { on: vi.fn(() => () => {}) }, config: {} }),
}));

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();

  /** A local track fake, real enough for isLive() (mediaStreamTrack.readyState)
   *  and for toggleShare's own `pub.track.mediaStreamTrack.getSettings()`. */
  function fakeLocalTrack(source: string) {
    return {
      source,
      stop: vi.fn(),
      mediaStreamTrack: {
        readyState: "live",
        getSettings: () => ({ displaySurface: "monitor" }),
      },
    };
  }

  /**
   * Just enough of LiveKit's Room to drive useCallRoom's join()/sync()/
   * scheduleRefresh(): a localParticipant and a remoteParticipants map, both
   * duck-typed rather than built from the real SDK classes, plus a hand-rolled
   * emitter so tests can `fire()` the exact event a real Room would — see the
   * module doc above for why the SEQUENCE these fire in is what's under test.
   */
  class FakeRoom {
    static instances: FakeRoom[] = [];
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    /** Set by a test right before advancing past scheduleRefresh's delay, to
     *  make the next connect() call reject — the "failed refresh" scenario. */
    nextConnectError: Error | null = null;
    connectCalls: { url?: string; token?: string }[] = [];
    disconnectCalls: { stopTracks?: boolean }[] = [];
    localParticipant = {
      identity: "local-user",
      name: "Local",
      isSpeaking: false,
      pubs: new Map<string, { track: ReturnType<typeof fakeLocalTrack>; isMuted: boolean }>(),
      getTrackPublication(source: string) {
        return this.pubs.get(source);
      },
      get isMicrophoneEnabled() {
        const p = this.pubs.get(actual.Track.Source.Microphone);
        return !!p && !p.isMuted;
      },
      get isCameraEnabled() {
        const p = this.pubs.get(actual.Track.Source.Camera);
        return !!p && !p.isMuted;
      },
      get isScreenShareEnabled() {
        return this.pubs.has(actual.Track.Source.ScreenShare);
      },
      async setMicrophoneEnabled(enabled: boolean) {
        if (enabled) this.pubs.set(actual.Track.Source.Microphone, { track: fakeLocalTrack(actual.Track.Source.Microphone), isMuted: false });
        else this.pubs.delete(actual.Track.Source.Microphone);
      },
      async setCameraEnabled(enabled: boolean) {
        if (enabled) this.pubs.set(actual.Track.Source.Camera, { track: fakeLocalTrack(actual.Track.Source.Camera), isMuted: false });
        else this.pubs.delete(actual.Track.Source.Camera);
      },
      async setScreenShareEnabled(enabled: boolean) {
        if (enabled) {
          const track = fakeLocalTrack(actual.Track.Source.ScreenShare);
          this.pubs.set(actual.Track.Source.ScreenShare, { track, isMuted: false });
          return { track };
        }
        this.pubs.delete(actual.Track.Source.ScreenShare);
        return undefined;
      },
      publishTrack: vi.fn(async function (this: FakeRoom["localParticipant"], track: ReturnType<typeof fakeLocalTrack>) {
        this.pubs.set(track.source, { track, isMuted: false });
        return { track };
      }),
      async publishData() {},
    };
    remoteParticipants = new Map<
      string,
      {
        identity: string;
        name: string;
        isSpeaking: boolean;
        pubs: Map<string, { track: unknown; isMuted: boolean }>;
        getTrackPublication(source: string): { track: unknown; isMuted: boolean } | undefined;
      }
    >();
    constructor(_opts?: unknown) {
      FakeRoom.instances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(cb);
      return this;
    }
    /** Not a real livekit-client method — the test's own hand crank. */
    fire(event: string, ...args: unknown[]) {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
    }
    async connect(url?: string, token?: string) {
      this.connectCalls.push({ url, token });
      if (this.nextConnectError) {
        const e = this.nextConnectError;
        this.nextConnectError = null;
        throw e;
      }
    }
    /** Mirrors Room.disconnect(stopTracks?: boolean) exactly (default true):
     *  only stops the local tracks — and clears the publications either way —
     *  when NOT explicitly told to preserve them. */
    async disconnect(stopTracks?: boolean) {
      this.disconnectCalls.push({ stopTracks });
      const shouldStop = stopTracks !== false;
      if (shouldStop) {
        for (const [, pub] of this.localParticipant.pubs) pub.track.stop();
      }
      this.localParticipant.pubs.clear();
    }
  }

  return { ...actual, Room: FakeRoom };
});

type FakeRemote = {
  identity: string;
  name: string;
  isSpeaking: boolean;
  pubs: Map<string, { track: unknown; isMuted: boolean }>;
  getTrackPublication(source: string): { track: unknown; isMuted: boolean } | undefined;
};
type FakeLocalTrack = { source: string; stop: ReturnType<typeof vi.fn>; mediaStreamTrack: { readyState: string; getSettings: () => unknown } };
type FakeRoomInstance = {
  fire(event: string, ...args: unknown[]): void;
  remoteParticipants: Map<string, FakeRemote>;
  connectCalls: { url?: string; token?: string }[];
  disconnectCalls: { stopTracks?: boolean }[];
  nextConnectError: Error | null;
  localParticipant: {
    pubs: Map<string, { track: FakeLocalTrack; isMuted: boolean }>;
    publishTrack: ReturnType<typeof vi.fn>;
    isMicrophoneEnabled: boolean;
    isCameraEnabled: boolean;
    isScreenShareEnabled: boolean;
  };
};
const FakeRoomClass = Room as unknown as { instances: FakeRoomInstance[] };

function addRemote(room: FakeRoomInstance, identity: string): FakeRemote {
  const p: FakeRemote = {
    identity,
    name: identity.toUpperCase(),
    isSpeaking: false,
    pubs: new Map(),
    getTrackPublication(source: string) {
      return this.pubs.get(source);
    },
  };
  room.remoteParticipants.set(identity, p);
  return p;
}

/** A live remote publication: exactly what `screen.getTrackPublication`
 *  returns for an ordinary, still-sharing screen. */
function livePublication() {
  return { track: { mediaStreamTrack: { readyState: "live" } }, isMuted: false };
}

/** The publication mid-unpublish: still there, not (yet) marked muted, but
 *  its track has already had `.stop()` called on it — see the module doc. */
function stoppedButStillPublished() {
  return { track: { mediaStreamTrack: { readyState: "ended" } }, isMuted: false };
}

function futureExpiry(minutes = 15) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

beforeEach(() => {
  h.api.callToken.mockReset().mockImplementation(async () => ({
    state: "JOINED" as const,
    url: "wss://call.test",
    token: "token",
    room: "room-1",
    identity: "local-user",
    expiresAt: futureExpiry(),
    role: "PARTICIPANT" as const,
  }));
  h.api.callTelemetryReconnected.mockReset().mockImplementation(async () => {});
  h.api.stopScreenShare.mockReset().mockImplementation(async () => {});
});

async function joinedRoom() {
  const view = renderHook(() => useCallRoom("call-1"));
  await act(async () => {
    await view.result.current.join();
  });
  const fakeRoom = FakeRoomClass.instances.at(-1)!;
  return { ...view, fakeRoom };
}

describe("useCallRoom — session handoff", () => {
  it("turns an active-session conflict into a switch prompt without opening a room", async () => {
    const roomCount = FakeRoomClass.instances.length;
    h.api.callToken.mockRejectedValueOnce(
      new ApiError(409, "active elsewhere", { code: "call_session_active" }),
    );
    const view = renderHook(() => useCallRoom("call-1"));

    await act(async () => view.result.current.join());

    expect(view.result.current.status).toBe("switch_required");
    expect(FakeRoomClass.instances).toHaveLength(roomCount);
    expect(h.api.leaveCall).not.toHaveBeenCalled();
  });

  it("switches after confirmation and only then connects the new room", async () => {
    h.api.callToken.mockRejectedValueOnce(
      new ApiError(409, "active elsewhere", { code: "call_session_active" }),
    );
    const view = renderHook(() => useCallRoom("call-1"));
    await act(async () => view.result.current.join());

    await act(async () => view.result.current.join({ switchHere: true }));

    expect(h.api.callToken).toHaveBeenLastCalledWith("call-1", "SWITCH");
    expect(view.result.current.status).toBe("connected");
  });

  it("cancels a second-device join without leaving the active participant row", async () => {
    h.api.leaveCall.mockClear();
    h.api.callToken.mockRejectedValueOnce(
      new ApiError(409, "active elsewhere", { code: "call_session_active" }),
    );
    const view = renderHook(() => useCallRoom("call-1"));
    await act(async () => view.result.current.join());

    await act(async () => view.result.current.leave());

    expect(view.result.current.status).toBe("idle");
    expect(h.api.leaveCall).not.toHaveBeenCalled();
  });

  it("marks duplicate-identity disconnects as displacement without leaving the new session", async () => {
    h.api.leaveCall.mockClear();
    const { result, fakeRoom } = await joinedRoom();

    act(() => fakeRoom.fire(RoomEvent.Disconnected, DisconnectReason.DUPLICATE_IDENTITY));

    expect(result.current.status).toBe("failed");
    expect(result.current.failStage).toBe("displaced");
    expect(h.api.leaveCall).not.toHaveBeenCalled();
  });

  it("keeps genuine disconnects on the retryable failure path", async () => {
    h.api.leaveCall.mockClear();
    const { result, fakeRoom } = await joinedRoom();

    act(() => fakeRoom.fire(RoomEvent.Disconnected, DisconnectReason.SERVER_SHUTDOWN));

    expect(result.current.status).toBe("failed");
    expect(result.current.failStage).toBe("disconnected");
    expect(h.api.leaveCall).toHaveBeenCalledWith("call-1");
  });

  it("ignores repeated switch clicks while a token request is in flight", async () => {
    let finishToken!: (grant: Awaited<ReturnType<typeof h.api.callToken>>) => void;
    h.api.callToken.mockImplementationOnce(
      () => new Promise((resolve) => { finishToken = resolve; }),
    );
    const view = renderHook(() => useCallRoom("call-1"));

    let first!: Promise<void>;
    act(() => { first = view.result.current.join({ switchHere: true }); });
    await act(async () => view.result.current.join({ switchHere: true }));
    finishToken({
      state: "JOINED",
      url: "wss://call.test",
      token: "token",
      room: "room-1",
      identity: "local-user",
      expiresAt: futureExpiry(),
      role: "PARTICIPANT",
    });
    await act(async () => first);

    expect(h.api.callToken).toHaveBeenCalledTimes(1);
    expect(view.result.current.status).toBe("connected");
  });
});

describe("useCallRoom — join lifecycle edges", () => {
  const grant = () => ({
    state: "JOINED" as const,
    url: "wss://call.test",
    token: "token",
    room: "room-1",
    identity: "local-user",
    expiresAt: futureExpiry(),
    role: "PARTICIPANT" as const,
  });

  it("does not build an orphan Room when the component unmounts while the token is in flight", async () => {
    h.api.leaveCall.mockClear();
    let finishToken!: (g: ReturnType<typeof grant>) => void;
    h.api.callToken.mockImplementationOnce(() => new Promise((resolve) => { finishToken = resolve; }));
    const rooms = FakeRoomClass.instances.length;
    const view = renderHook(() => useCallRoom("call-1"));

    let joined!: Promise<void>;
    act(() => { joined = view.result.current.join(); });
    view.unmount();
    await act(async () => {
      finishToken(grant());
      await joined;
    });

    expect(FakeRoomClass.instances).toHaveLength(rooms); // nothing was constructed or connected
    expect(h.api.leaveCall).toHaveBeenCalledWith("call-1"); // and the roster entry the token minted is released
  });

  it("can still join after the previous call's room failed to disconnect", async () => {
    const view = renderHook(({ id }) => useCallRoom(id), { initialProps: { id: "call-1" } });
    await act(async () => { await view.result.current.join(); });
    const first = FakeRoomClass.instances.at(-1)!;
    (first as unknown as { disconnect: () => Promise<void> }).disconnect = async () => {
      throw new Error("socket already gone");
    };

    view.rerender({ id: "call-2" });
    await act(async () => { await view.result.current.join(); });

    expect(h.api.callToken).toHaveBeenLastCalledWith("call-2", "JOIN");
    expect(view.result.current.status).toBe("connected");
    // `joining` was released, so a further join is not silently swallowed.
    view.rerender({ id: "call-3" });
    await act(async () => { await view.result.current.join(); });
    expect(h.api.callToken).toHaveBeenLastCalledWith("call-3", "JOIN");
  });
});

describe("useCallRoom — screen-share liveness", () => {
  it("reports an ordinary live share as sharing, with its track", async () => {
    const { result, fakeRoom } = await joinedRoom();
    const peer = addRemote(fakeRoom, "peer");
    peer.pubs.set(Track.Source.ScreenShare, livePublication());

    act(() => fakeRoom.fire(RoomEvent.ParticipantConnected));

    const p = result.current.participants.find((x) => x.identity === "peer");
    expect(p?.sharing).toBe(true);
    expect(p?.screenTrack).not.toBeNull();
  });

  it("stops reporting a share the instant TrackUnsubscribed fires, even though the publication still exists and isn't muted", async () => {
    const { result, fakeRoom } = await joinedRoom();
    const peer = addRemote(fakeRoom, "peer");
    peer.pubs.set(Track.Source.ScreenShare, livePublication());
    act(() => fakeRoom.fire(RoomEvent.ParticipantConnected));
    expect(result.current.participants.find((x) => x.identity === "peer")?.sharing).toBe(true);

    // The exact mid-unpublish shape: livekit-client has already stopped the
    // track and is about to clear the publication and emit TrackUnsubscribed
    // — but has NOT yet removed the publication or touched `isMuted`.
    peer.pubs.set(Track.Source.ScreenShare, stoppedButStillPublished());
    act(() => fakeRoom.fire(RoomEvent.TrackUnsubscribed));

    const p = result.current.participants.find((x) => x.identity === "peer");
    expect(p?.sharing).toBe(false);
    expect(p?.screenTrack).toBeNull();
  });

  it("also clears once TrackUnpublished fires, after the publication is gone entirely", async () => {
    const { result, fakeRoom } = await joinedRoom();
    const peer = addRemote(fakeRoom, "peer");
    peer.pubs.set(Track.Source.ScreenShare, livePublication());
    act(() => fakeRoom.fire(RoomEvent.ParticipantConnected));
    expect(result.current.participants.find((x) => x.identity === "peer")?.sharing).toBe(true);

    // The publication is removed outright — livekit-client's own next step —
    // and only TrackUnpublished announces it.
    peer.pubs.delete(Track.Source.ScreenShare);
    act(() => fakeRoom.fire(RoomEvent.TrackUnpublished));

    const p = result.current.participants.find((x) => x.identity === "peer");
    expect(p?.sharing).toBe(false);
    expect(p?.screenTrack).toBeNull();
  });

  it("drops a sharing participant entirely when they leave, not just their share", async () => {
    const { result, fakeRoom } = await joinedRoom();
    const peer = addRemote(fakeRoom, "peer");
    peer.pubs.set(Track.Source.ScreenShare, livePublication());
    act(() => fakeRoom.fire(RoomEvent.ParticipantConnected));
    expect(result.current.participants.some((x) => x.identity === "peer")).toBe(true);

    fakeRoom.remoteParticipants.delete("peer");
    act(() => fakeRoom.fire(RoomEvent.ParticipantDisconnected));

    expect(result.current.participants.some((x) => x.identity === "peer")).toBe(false);
  });
});

describe("useCallRoom — join reaches a connected room", () => {
  it("populates the local participant once connected", async () => {
    const { result } = await joinedRoom();
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.participants.some((p) => p.isLocal)).toBe(true);
  });
});

describe("useCallRoom — scheduled token refresh (scheduleRefresh)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advances past scheduleRefresh's own floor (30s) and, for the default
   *  15-minute token, its 80%-of-remaining-life mark (~12 minutes) — both are
   *  computed from `Date.now()` at join time, so a fixed large jump clears
   *  either. Flushes microtasks between ticks (advanceTimersByTimeAsync) so
   *  scheduleRefresh's own async IIFE — callToken(), disconnect(), connect(),
   *  publishTrack() — actually runs to completion, not just gets scheduled. */
  async function advancePastRefresh() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
    });
  }

  it("re-mints the token and reconnects the SAME Room — no duplicate connection", async () => {
    const { fakeRoom } = await joinedRoom();
    const roomCountBefore = FakeRoomClass.instances.length;
    h.api.callToken.mockClear();
    // join() itself already made one connect() call; only the refresh's OWN
    // connect/disconnect calls are what this test is about.
    fakeRoom.connectCalls.length = 0;

    await advancePastRefresh();

    expect(h.api.callToken).toHaveBeenCalledWith("call-1", "REFRESH");
    expect(fakeRoom.connectCalls.length).toBe(1);
    expect(fakeRoom.disconnectCalls.length).toBe(1);
    // The refresh disconnects and reconnects the SAME instance — no second
    // Room was ever constructed for this hook.
    expect(FakeRoomClass.instances.length).toBe(roomCountBefore);
  });

  it("preserves camera and microphone across the refresh instead of re-acquiring them", async () => {
    const { result, fakeRoom } = await joinedRoom();
    await act(async () => {
      await result.current.toggleMic();
      await result.current.toggleCam();
    });
    const heldMic = fakeRoom.localParticipant.pubs.get(Track.Source.Microphone)!.track;
    const heldCam = fakeRoom.localParticipant.pubs.get(Track.Source.Camera)!.track;
    fakeRoom.localParticipant.publishTrack.mockClear();

    await advancePastRefresh();

    // disconnect(false): the ORIGINAL track objects were never stopped...
    expect(heldMic.stop).not.toHaveBeenCalled();
    expect(heldCam.stop).not.toHaveBeenCalled();
    // ...and are the exact objects handed back to publishTrack — not a fresh
    // getUserMedia-acquired replacement.
    expect(fakeRoom.localParticipant.publishTrack).toHaveBeenCalledWith(heldMic);
    expect(fakeRoom.localParticipant.publishTrack).toHaveBeenCalledWith(heldCam);
    expect(result.current.micOn).toBe(true);
    expect(result.current.camOn).toBe(true);
  });

  it("preserves an active screen share across the refresh, with no lost-share toast", async () => {
    const { result, fakeRoom } = await joinedRoom();
    await act(async () => {
      await result.current.toggleShare();
    });
    expect(result.current.sharing).toBe(true);
    const heldScreen = fakeRoom.localParticipant.pubs.get(Track.Source.ScreenShare)!.track;

    await advancePastRefresh();

    expect(heldScreen.stop).not.toHaveBeenCalled();
    expect(fakeRoom.localParticipant.publishTrack).toHaveBeenCalledWith(heldScreen);
    expect(result.current.sharing).toBe(true);
    // The old behavior's signature: reporting the share as lost. Must not
    // fire when the share genuinely survived the refresh.
    expect(h.api.stopScreenShare).not.toHaveBeenCalled();
  });

  it("reports the refresh on the reconnect telemetry, with reason token_refresh — not relying on RoomEvent.Reconnected", async () => {
    await joinedRoom();
    h.api.callTelemetryReconnected.mockClear();

    await advancePastRefresh();

    expect(h.api.callTelemetryReconnected).toHaveBeenCalledWith("call-1", "token_refresh");
  });

  it("stops the held tracks and does not leave the room silently reconnecting when the reconnect itself fails", async () => {
    const { result, fakeRoom } = await joinedRoom();
    await act(async () => {
      await result.current.toggleMic();
      await result.current.toggleShare();
    });
    const heldMic = fakeRoom.localParticipant.pubs.get(Track.Source.Microphone)!.track;
    const heldScreen = fakeRoom.localParticipant.pubs.get(Track.Source.ScreenShare)!.track;
    fakeRoom.nextConnectError = new Error("simulated SFU connect failure");

    await advancePastRefresh();

    // disconnect(false) deliberately left these live; giving up on the
    // reconnect must release them itself, or the mic/screen stay silently
    // captured with nothing publishing them.
    expect(heldMic.stop).toHaveBeenCalled();
    expect(heldScreen.stop).toHaveBeenCalled();
    expect(h.api.callTelemetryReconnected).not.toHaveBeenCalledWith("call-1", "token_refresh");
  });

  it("does not attempt to reconnect at all when the re-minted token has been revoked — preserves the existing security behavior", async () => {
    const { fakeRoom } = await joinedRoom();
    fakeRoom.connectCalls.length = 0; // join()'s own connect() isn't part of this
    h.api.callToken.mockReset().mockImplementation(async () => ({
      state: "WAITING" as const,
      canStart: false,
    }));

    await advancePastRefresh();

    // The refusal path disconnects for real (default stopTracks=true) and
    // never calls connect() again — no reconnect loop, no lingering room.
    expect(fakeRoom.connectCalls.length).toBe(0);
    expect(fakeRoom.disconnectCalls).toEqual([{ stopTracks: undefined }]);
  });

  it("disconnects for real, without attempting a reconnect, when re-minting the token throws (call ended / access withdrawn)", async () => {
    const { fakeRoom } = await joinedRoom();
    fakeRoom.connectCalls.length = 0; // join()'s own connect() isn't part of this
    h.api.callToken.mockReset().mockRejectedValue(new Error("410 gone"));

    await advancePastRefresh();

    expect(fakeRoom.connectCalls.length).toBe(0);
    expect(fakeRoom.disconnectCalls).toEqual([{ stopTracks: undefined }]);
  });
});
