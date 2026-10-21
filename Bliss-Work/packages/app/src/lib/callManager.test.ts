/**
 * Regression test for the callee's video-transceiver reassociation.
 *
 * Reproduces, in a mock, a real Chromium behaviour verified against a live
 * two-browser call (Chromium 130): a video transceiver created via
 * `addTransceiver(track, {direction:"sendrecv"})` BEFORE the first
 * `setRemoteDescription(offer)` is NOT reliably matched to that same offer's
 * own video m= line — the browser leaves it associated with nothing (mid
 * stays null) and creates a SEPARATE, fresh, track-less transceiver for the
 * m= line instead, defaulting it to "recvonly". `createAnswer()` serializes
 * that empty one, so the answer tells the caller "receive only" and the
 * caller never gets a picture, no matter what the app does with the
 * original, camera-bearing transceiver afterwards.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CallSession } from "./callManager";
import { AUDIO_CAPTURE_DEFAULTS } from "./mediaConstraints";

type SignalingState = "stable" | "have-local-offer" | "have-remote-offer" | "closed";

class FakeTransceiver {
  mid: string | null = null;
  direction: string;
  currentDirection: string | null = null;
  sender: { track: unknown; replaceTrack: ReturnType<typeof vi.fn> };
  receiver: { track: unknown };
  constructor(direction: string, senderTrack: unknown, receiverTrack: unknown) {
    this.direction = direction;
    this.sender = {
      track: senderTrack,
      replaceTrack: vi.fn(async (t: unknown) => {
        this.sender.track = t;
      }),
    };
    this.receiver = { track: receiverTrack };
  }
}

/** Minimal RTCPeerConnection that reproduces the real transceiver-matching
 *  quirk this fix targets. Everything else is the same shape as the
 *  signaling-state mock this file replaces. */
class FakePC {
  signalingState: SignalingState = "stable";
  connectionState = "new";
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: unknown) => void) | null = null;
  transceivers: FakeTransceiver[] = [];
  createAnsweredFrom: FakeTransceiver[] | null = null;

  addTransceiver(kindOrTrack: unknown, init?: { direction?: string }) {
    const isTrack = typeof kindOrTrack !== "string";
    const tx = new FakeTransceiver(init?.direction ?? "sendrecv", isTrack ? kindOrTrack : null, null);
    this.transceivers.push(tx);
    return tx;
  }

  createDataChannel(label: string) {
    return { readyState: "connecting", send: () => {}, onopen: null, onmessage: null, label };
  }

  getTransceivers() {
    return this.transceivers;
  }

  async setRemoteDescription(d: { type: string }): Promise<void> {
    if (d.type === "offer") {
      if (this.signalingState !== "stable") {
        throw new DOMException("wrong state for remote offer", "InvalidStateError");
      }
      this.signalingState = "have-remote-offer";
      // The audio transceiver (created via addTrack in acquire()) matches
      // correctly — that part of Chromium's algorithm works fine.
      const audioTx = this.transceivers.find(
        (t) => t.mid === null && (t.sender.track as { kind?: string } | null)?.kind === "audio",
      );
      if (audioTx) audioTx.mid = "0";
      // The video transceiver stays orphaned (mid never gets set) — this is
      // the bug. A brand new, track-less, recvonly transceiver shows up in
      // its place, matched to the offer's video m= line instead.
      const associatedVideo = new FakeTransceiver("recvonly", null, { kind: "video", id: "remote-video-track" });
      associatedVideo.mid = "1";
      this.transceivers.push(associatedVideo);
    } else {
      if (this.signalingState !== "have-local-offer") {
        throw new DOMException("wrong state for remote answer", "InvalidStateError");
      }
      this.signalingState = "stable";
    }
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    if (this.signalingState !== "have-remote-offer") {
      throw new DOMException(
        "PeerConnection cannot create an answer in a state other than have-remote-offer or have-local-pranswer.",
        "InvalidStateError",
      );
    }
    // Snapshot exactly what a real createAnswer() would serialize: every
    // associated (mid !== null) transceiver, at the moment it's called.
    this.createAnsweredFrom = this.transceivers.filter((t) => t.mid !== null);
    return { type: "answer", sdp: "answer-sdp" };
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(d: { type: string }): Promise<void> {
    this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
  }

  async addIceCandidate(): Promise<void> {}
  addTrack(track: unknown): void {
    this.transceivers.push(new FakeTransceiver("sendrecv", track, null));
  }
  close(): void {
    this.signalingState = "closed";
  }
}

let pc: FakePC;
let getUserMedia: ReturnType<typeof vi.fn>;

function makeSession(media: "audio" | "video" = "video") {
  return new CallSession({
    callId: "call-1",
    peerId: "peer-1",
    media,
    iceConfig: {},
    sendFrame: vi.fn(),
    onRemoteStream: vi.fn(),
    onConnected: vi.fn(),
    onClosed: vi.fn(),
  });
}

beforeEach(() => {
  pc = new FakePC();
  vi.stubGlobal(
    "RTCPeerConnection",
    function RTCPeerConnectionStub(this: unknown) {
      return pc;
    },
  );
  vi.stubGlobal(
    "MediaStream",
    class {
      private t: unknown[] = [];
      getTracks() {
        return this.t;
      }
      addTrack(x: unknown) {
        this.t.push(x);
      }
      getAudioTracks() {
        return this.t.filter((t) => (t as { kind?: string }).kind === "audio");
      }
      getVideoTracks() {
        return this.t.filter((t) => (t as { kind?: string }).kind === "video");
      }
    },
  );
  getUserMedia = vi.fn(async (constraints: { video?: boolean }) => {
    const audio = { kind: "audio", stop: vi.fn(), enabled: true, id: "audio-track" };
    const tracks = [audio];
    if (constraints?.video) tracks.push({ kind: "video", stop: vi.fn(), enabled: true, id: "camera-track" } as never);
    return {
      getTracks: () => tracks,
      getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
      getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    };
  });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
});

describe("callee video transceiver reassociation (the recvonly bug)", () => {
  it("moves the camera track onto the transceiver the browser actually associated with the offer, before answering", async () => {
    const session = makeSession("video");
    await session.onOffer("offer-sdp");

    // The transceiver createAnswer() actually serialized for mid "1" (the
    // one the browser associated with the offer's video m= line, NOT the
    // pre-created one the app originally reserved) must carry the camera
    // track and be sendrecv — otherwise the answer says recvonly again and
    // the bug is back.
    const answeredVideo = pc.createAnsweredFrom?.find((t) => t.mid === "1");
    expect(answeredVideo).toBeDefined();
    expect(answeredVideo?.direction).toBe("sendrecv");
    expect(answeredVideo?.sender.replaceTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: "camera-track" }),
    );
    expect(answeredVideo?.sender.track).toEqual(expect.objectContaining({ id: "camera-track" }));
  });

  it("does not touch the orphaned pre-created transceiver's track", async () => {
    const session = makeSession("video");
    await session.onOffer("offer-sdp");

    const orphan = pc.transceivers.find((t) => t.mid === null);
    expect(orphan).toBeDefined();
    expect(orphan?.sender.replaceTrack).not.toHaveBeenCalled();
  });

  it("reserves the slot sendrecv without a track on a voice call (no camera to move)", async () => {
    const session = makeSession("audio");
    await session.onOffer("offer-sdp");

    const answeredVideo = pc.createAnsweredFrom?.find((t) => t.mid === "1");
    expect(answeredVideo?.direction).toBe("sendrecv");
    expect(answeredVideo?.sender.replaceTrack).toHaveBeenCalledWith(null);
  });

  it("still answers exactly once for a retransmitted offer", async () => {
    const session = makeSession("video");
    await session.onOffer("offer-sdp");
    const firstAnswerCall = pc.createAnsweredFrom;
    await session.onOffer("offer-sdp");
    // applyOffer's `this.answered` guard short-circuits before reaching
    // setRemoteDescription again — createAnsweredFrom is unchanged.
    expect(pc.createAnsweredFrom).toBe(firstAnswerCall);
  });
});

describe("caller sees its own preview before the callee answers", () => {
  it("prepareCaller() acquires the camera/mic immediately, before any offer is sent", async () => {
    const sendFrame = vi.fn();
    const session = new CallSession({
      callId: "call-1",
      peerId: "peer-1",
      media: "video",
      iceConfig: {},
      sendFrame,
      onRemoteStream: vi.fn(),
      onConnected: vi.fn(),
      onClosed: vi.fn(),
    });

    await session.prepareCaller();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(session.localStream?.getVideoTracks()).toHaveLength(1);
    // No signaling yet — invite() only rings; the offer goes out later, once
    // the callee actually accepts.
    expect(sendFrame).not.toHaveBeenCalled();
  });

  it("startCaller() reuses the stream prepareCaller() already acquired instead of re-prompting for the camera", async () => {
    const session = makeSession("video");
    await session.prepareCaller();
    const stream = session.localStream;

    await session.startCaller();

    expect(getUserMedia).toHaveBeenCalledTimes(1); // still just the one call
    expect(session.localStream).toBe(stream); // same stream, not a fresh capture
    expect(pc.signalingState).toBe("have-local-offer");
  });

  it("closing the session while prepareCaller()'s permission prompt is still pending stops the camera the moment it resolves", async () => {
    let resolveGum!: (v: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => (resolveGum = resolve)));
    const session = makeSession("video");
    const pending = session.prepareCaller();

    session.close(); // the caller cancels before the browser's prompt resolves

    const audio = { kind: "audio", stop: vi.fn(), enabled: true, id: "audio-track" };
    const video = { kind: "video", stop: vi.fn(), enabled: true, id: "camera-track" };
    resolveGum({ getTracks: () => [audio, video], getAudioTracks: () => [audio], getVideoTracks: () => [video] });
    await pending;

    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(video.stop).toHaveBeenCalledTimes(1);
    expect(session.localStream).toBeUndefined();
  });
});

describe("microphone capture", () => {
  it("asks for the shared audio-processing constraints, not a bare `audio: true`", async () => {
    await makeSession("audio").prepareCallee();

    // Bare `audio: true` would leave noise suppression to whatever the user agent
    // felt like — see AUDIO_CONSTRAINTS in callManager.ts.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0]?.[0]?.audio).toEqual(AUDIO_CAPTURE_DEFAULTS);
  });

  it("reports the effective settings of the track it actually acquired", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    getUserMedia.mockImplementationOnce(async () => {
      const audio = {
        kind: "audio",
        stop: vi.fn(),
        enabled: true,
        id: "audio-track",
        getSettings: () => ({ noiseSuppression: true, echoCancellation: true, autoGainControl: true }),
      };
      return { getTracks: () => [audio], getAudioTracks: () => [audio], getVideoTracks: () => [] };
    });

    await makeSession("audio").prepareCallee();

    expect(debug).toHaveBeenCalledWith(
      "[MIC] call:acquired",
      expect.objectContaining({ notApplied: [], unreported: [] }),
    );
    debug.mockRestore();
  });
});

describe("camera off releases the capture device", () => {
  /** A stream whose track list really changes, unlike the static one above. */
  function mutableStream(tracks: Array<{ kind: string; stop: ReturnType<typeof vi.fn>; enabled: boolean; id: string }>) {
    return {
      getTracks: () => tracks,
      getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
      getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
      addTrack: (t: (typeof tracks)[number]) => void tracks.push(t),
      removeTrack: (t: (typeof tracks)[number]) => void tracks.splice(tracks.indexOf(t), 1),
    };
  }
  const cam = (id: string) => ({ kind: "video", stop: vi.fn(), enabled: true, id });

  async function videoCall() {
    const initial = cam("cam-1");
    const audio = { kind: "audio", stop: vi.fn(), enabled: true, id: "audio-track" };
    const local = mutableStream([audio, initial]);
    getUserMedia.mockImplementationOnce(async () => local);
    const session = makeSession("video");
    await session.prepareCallee();
    const videoTx = pc.transceivers.find((t) => (t.sender.track as { kind?: string } | null)?.kind === "video")!;
    return { session, local, initial, videoTx };
  }

  it("stops the track, takes it out of the stream and unpublishes it", async () => {
    const { session, local, initial, videoTx } = await videoCall();

    expect(await session.setCam(false)).toBe(false);

    expect(initial.stop).toHaveBeenCalledTimes(1);
    expect(local.getVideoTracks()).toHaveLength(0);
    expect(videoTx.sender.replaceTrack).toHaveBeenLastCalledWith(null);
    // The mic is untouched.
    expect(local.getAudioTracks()).toHaveLength(1);
  });

  it("captures a fresh camera when it is turned back on", async () => {
    const { session, local, videoTx } = await videoCall();
    await session.setCam(false);
    const second = cam("cam-2");
    getUserMedia.mockImplementationOnce(async () => mutableStream([second]));

    expect(await session.setCam(true)).toBe(true);

    expect(getUserMedia).toHaveBeenLastCalledWith({ video: true });
    expect(local.getVideoTracks()).toEqual([second]);
    expect(videoTx.sender.replaceTrack).toHaveBeenLastCalledWith(second);
    expect(second.stop).not.toHaveBeenCalled();
  });

  it("keeps the screen share on the sender while the camera is switched off mid-share", async () => {
    const { session, initial, videoTx } = await videoCall();
    const screenTrack = { kind: "video", stop: vi.fn(), id: "screen", addEventListener: vi.fn(), getSettings: () => ({}) };
    const getDisplayMedia = vi.fn(async () => ({
      getTracks: () => [screenTrack],
      getVideoTracks: () => [screenTrack],
    }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, getDisplayMedia } });
    await session.startShare();
    videoTx.sender.replaceTrack.mockClear();

    await session.setCam(false);
    expect(initial.stop).toHaveBeenCalledTimes(1);
    expect(videoTx.sender.replaceTrack).not.toHaveBeenCalled(); // the share still owns the sender

    await session.stopShare();
    expect(videoTx.sender.replaceTrack).toHaveBeenLastCalledWith(null); // camera stays off afterwards
  });

  it("still stops everything when the call ends", async () => {
    const { session, initial } = await videoCall();
    session.close();
    expect(initial.stop).toHaveBeenCalled();
  });
});

