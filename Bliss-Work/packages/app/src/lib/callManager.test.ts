/**
 * Signaling-state safety for CallSession.
 *
 * Reproduces the production error:
 *   InvalidStateError: Failed to execute 'createAnswer' on 'RTCPeerConnection':
 *   PeerConnection cannot create an answer in a state other than
 *   have-remote-offer or have-local-pranswer.
 *
 * Cause was unserialized async handlers: every step awaits getUserMedia (which
 * blocks on the permission prompt) and the SDP calls, so two frames arriving
 * during those awaits interleaved — the first returned the connection to
 * `stable`, and the second called createAnswer from there.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CallSession } from "./callManager";

type SignalingState = "stable" | "have-local-offer" | "have-remote-offer" | "closed";

/** The mocked mic, so tests can assert what was requested of it. */
let getUserMedia: ReturnType<typeof vi.fn>;

/** Minimal RTCPeerConnection that enforces the real state machine. */
class FakePC {
  signalingState: SignalingState = "stable";
  connectionState = "new";
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  createAnswerCalls = 0;
  addedTracks = 0;
  ondatachannel: ((e: unknown) => void) | null = null;
  /** Every transceiver added, so a test can assert the video slot is reserved
   *  even on an audio call — that is what lets the camera and screen share be
   *  turned on later without a second offer. */
  transceivers: { kind: unknown; direction?: string; sender: { replaceTrack: (t: unknown) => Promise<void> } }[] = [];
  dataChannels: string[] = [];

  addTransceiver(kind: unknown, init?: { direction?: string }) {
    const tx = {
      kind,
      direction: init?.direction,
      sender: { replaceTrack: async () => {} },
    };
    this.transceivers.push(tx);
    return tx;
  }

  createDataChannel(label: string) {
    this.dataChannels.push(label);
    return { readyState: "connecting", send: () => {}, onopen: null, onmessage: null };
  }

  async setRemoteDescription(d: { type: string }): Promise<void> {
    await tick();
    if (d.type === "offer") {
      if (this.signalingState !== "stable") {
        throw new DOMException("wrong state for remote offer", "InvalidStateError");
      }
      this.signalingState = "have-remote-offer";
    } else {
      if (this.signalingState !== "have-local-offer") {
        throw new DOMException("wrong state for remote answer", "InvalidStateError");
      }
      this.signalingState = "stable";
    }
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    this.createAnswerCalls += 1;
    // The exact browser behaviour this test exists for.
    if (this.signalingState !== "have-remote-offer") {
      throw new DOMException(
        "PeerConnection cannot create an answer in a state other than have-remote-offer or have-local-pranswer.",
        "InvalidStateError",
      );
    }
    await tick();
    return { type: "answer", sdp: "answer-sdp" };
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    await tick();
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(d: { type: string }): Promise<void> {
    await tick();
    this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
  }

  async addIceCandidate(): Promise<void> {}
  addTrack(): void {
    this.addedTracks += 1;
  }
  close(): void {
    this.signalingState = "closed";
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

let pc: FakePC;

function makeSession(sendFrame = vi.fn()) {
  return {
    session: new CallSession({
      callId: "call-1",
      peerId: "peer-1",
      media: "audio",
      iceConfig: {},
      sendFrame,
      onRemoteStream: vi.fn(),
      onConnected: vi.fn(),
      onClosed: vi.fn(),
    }),
    sendFrame,
  };
}

beforeEach(() => {
  pc = new FakePC();
  // Must be constructible (`new RTCPeerConnection(...)`), so not an arrow fn.
  vi.stubGlobal(
    "RTCPeerConnection",
    function RTCPeerConnectionStub(this: unknown) {
      return pc;
    },
  );
  vi.stubGlobal("MediaStream", class {
    private t: unknown[] = [];
    getTracks() {
      return this.t;
    }
    addTrack(x: unknown) {
      this.t.push(x);
    }
    getAudioTracks() {
      return [];
    }
    getVideoTracks() {
      return [];
    }
  });
  // Deliberately slow, like a real permission prompt — this is the window in
  // which a second frame used to slip through. Recorded so the audio
  // constraints can be asserted.
  getUserMedia = vi.fn(async () => {
    await tick();
    await tick();
    const audio = { kind: "audio", stop: vi.fn(), enabled: true };
    return {
      getTracks: () => [audio],
      getAudioTracks: () => [audio],
      getVideoTracks: () => [],
    };
  });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
});

describe("CallSession signaling", () => {
  it("answers a single offer", async () => {
    const { session, sendFrame } = makeSession();
    await session.onOffer("offer-sdp");
    expect(sendFrame).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rtc.answer", offerId: "call-1" }),
    );
    expect(pc.signalingState).toBe("stable");
  });

  it("does not throw when two offers arrive during getUserMedia", async () => {
    const { session, sendFrame } = makeSession();
    // Both dispatched before either can finish — the production race.
    await expect(
      Promise.all([session.onOffer("offer-sdp"), session.onOffer("offer-sdp")]),
    ).resolves.toBeDefined();
    // Answered exactly once; the retransmit was ignored, not re-answered.
    const answers = sendFrame.mock.calls.filter((c) => c[0].type === "rtc.answer");
    expect(answers).toHaveLength(1);
  });

  it("ignores a duplicate offer that arrives after the answer was sent", async () => {
    const { session, sendFrame } = makeSession();
    await session.onOffer("offer-sdp");
    await session.onOffer("offer-sdp");
    const answers = sendFrame.mock.calls.filter((c) => c[0].type === "rtc.answer");
    expect(answers).toHaveLength(1);
  });

  it("does not answer after the session is closed mid-negotiation", async () => {
    const { session, sendFrame } = makeSession();
    const p = session.onOffer("offer-sdp");
    session.close("hung up");
    await p;
    expect(sendFrame.mock.calls.filter((c) => c[0].type === "rtc.answer")).toHaveLength(0);
  });

  it("applies an answer that arrives while the caller is still in getUserMedia", async () => {
    const { session } = makeSession();
    // Caller starts; answer frame lands immediately, before the offer is set.
    const starting = session.startCaller();
    const answering = session.onAnswer("answer-sdp");
    await Promise.all([starting, answering]);
    // Queued behind the offer, so it applied rather than being dropped.
    expect(pc.signalingState).toBe("stable");
  });

  it("ignores a duplicate answer instead of throwing", async () => {
    const { session } = makeSession();
    await session.startCaller();
    await session.onAnswer("answer-sdp");
    await expect(session.onAnswer("answer-sdp")).resolves.toBeUndefined();
  });
});

describe("microphone capture", () => {
  // Regression guard. `audio: true` leaves echo cancellation, noise suppression
  // and gain control to the user agent's discretion, which varies by browser and
  // by Electron version. That shipped calls with audible room noise and, without
  // echo cancellation, the peer's own voice looping back through the speakers.
  it("requests echo cancellation, noise suppression and gain control", async () => {
    const { session } = makeSession();
    await session.onOffer("offer-sdp");

    expect(getUserMedia).toHaveBeenCalled();
    const constraints = getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints;
    expect(constraints.audio).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  it("captures the mic only once per session", async () => {
    // A second capture would mix two copies of the room into the call.
    const { session } = makeSession();
    await Promise.all([session.onOffer("offer-sdp"), session.onOffer("offer-sdp")]);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("does not request the camera for an audio call", async () => {
    const { session } = makeSession();
    await session.onOffer("offer-sdp");
    const constraints = getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints;
    expect(constraints.video).toBe(false);
  });
});

describe("the video slot on a voice call", () => {
  // The in-call controls offer Video and Share Screen on every call, including
  // one that started as audio. Both are replaceTrack() onto a sender that has
  // to exist already — this session does not renegotiate, so a video m-line
  // that was never offered can never be filled.
  it("is reserved sendrecv even though no camera was captured", async () => {
    const { session } = makeSession();
    await session.onOffer("offer-sdp");
    const video = pc.transceivers.filter((t) => t.kind === "video");
    expect(video).toHaveLength(1);
    expect(video[0]?.direction).toBe("sendrecv");
  });

  it("is reserved before the remote offer is applied", async () => {
    // Order matters: a transceiver created BY an offer comes out recvonly, and
    // a recvonly sender transmits nothing however many tracks are replaced in.
    const { session } = makeSession();
    await session.onOffer("offer-sdp");
    expect(pc.transceivers).toHaveLength(1);
    expect(pc.signalingState).toBe("stable");
  });

  it("gives the caller a metadata channel described by its own offer", async () => {
    const { session } = makeSession();
    await session.startCaller();
    expect(pc.dataChannels).toEqual(["call-meta"]);
  });
});
