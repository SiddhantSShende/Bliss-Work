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

/** Minimal RTCPeerConnection that enforces the real state machine. */
class FakePC {
  signalingState: SignalingState = "stable";
  connectionState = "new";
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  createAnswerCalls = 0;
  addedTracks = 0;

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
  vi.stubGlobal("navigator", {
    mediaDevices: {
      // Deliberately slow, like a real permission prompt — this is the window
      // in which a second frame used to slip through.
      getUserMedia: async () => {
        await tick();
        await tick();
        return { getTracks: () => [{ kind: "audio", stop: vi.fn(), enabled: true }] };
      },
    },
  });
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
