import type { ClientFrame } from "@taskboard/shared";

export type CallMedia = "audio" | "video";

export interface CallSessionOpts {
  callId: string;
  peerId: string;
  media: CallMedia;
  iceConfig: RTCConfiguration;
  sendFrame: (f: ClientFrame) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onConnected: () => void;
  onClosed: (reason: string) => void;
}

/**
 * One 1:1 WebRTC media session. Roles are fixed per call (no glare): the CALLER
 * creates the offer once the callee has accepted; the CALLEE answers. SDP + ICE
 * ride the existing rtc.offer/answer/ice frames with offerId === callId.
 *
 * ICE candidates are JSON-encoded (candidate + sdpMid + sdpMLineIndex) into the
 * frame's `candidate` string — for audio+video there are multiple m-lines, so
 * the bare candidate string the file-transfer path uses isn't enough. Calls own
 * a distinct callId, so they never collide with file-transfer offers on the
 * shared rtc.* channel.
 *
 * The session owns getUserMedia + the RTCPeerConnection and stops every track on
 * close so the camera/mic light goes off.
 */
export class CallSession {
  private readonly pc: RTCPeerConnection;
  private local?: MediaStream;
  private readonly remote = new MediaStream();
  private readonly pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private closed = false;
  private answered = false;
  /**
   * Serializes the signaling steps.
   *
   * Every handler below is async and awaits getUserMedia (which can block for
   * seconds on the permission prompt) and the SDP calls. Without a queue, two
   * frames arriving during those awaits interleave: both apply a remote offer,
   * the first completes setLocalDescription and returns the connection to
   * `stable`, and the second then calls createAnswer from `stable` — which is
   * the InvalidStateError seen in production ("cannot create an answer in a
   * state other than have-remote-offer or have-local-pranswer").
   */
  private ops: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: CallSessionOpts) {
    this.pc = new RTCPeerConnection(o.iceConfig);

    this.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      o.sendFrame({
        type: "rtc.ice",
        toUserId: o.peerId,
        offerId: o.callId,
        candidate: JSON.stringify(e.candidate.toJSON()),
      });
    };
    this.pc.ontrack = (e) => {
      const tracks = e.streams[0]?.getTracks() ?? [e.track];
      for (const t of tracks) if (!this.remote.getTracks().includes(t)) this.remote.addTrack(t);
      o.onRemoteStream(this.remote);
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "connected") o.onConnected();
      else if (this.pc.connectionState === "failed") this.close("connection failed");
    };
  }

  private async acquire(): Promise<void> {
    if (this.local) return;
    this.local = await navigator.mediaDevices.getUserMedia({ audio: true, video: this.o.media === "video" });
    for (const track of this.local.getTracks()) this.pc.addTrack(track, this.local);
  }

  /** Caller: acquire media + send the offer (called after call.accept).
   *
   *  Queued like every other signaling step so the offer is fully applied before
   *  an answer can be. Otherwise an answer arriving while getUserMedia is still
   *  blocked on the permission prompt would find signalingState `stable` and be
   *  dropped, and the call would never connect. */
  startCaller(): Promise<void> {
    return this.enqueue(async () => {
      await this.acquire();
      if (this.closed) return;
      const offer = await this.pc.createOffer();
      if (this.closed) return;
      await this.pc.setLocalDescription(offer);
      this.o.sendFrame({ type: "rtc.offer", toUserId: this.o.peerId, offerId: this.o.callId, sdp: offer.sdp ?? "" });
    });
  }

  /** Callee: acquire media up-front (on accept) so it's ready when the offer lands. */
  async prepareCallee(): Promise<void> {
    await this.acquire();
  }

  /** Run a signaling step after all earlier ones finish, and never on a closed
   *  session. One step throwing must not wedge the queue for the rest. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.ops.then(() => (this.closed ? undefined : fn()));
    this.ops = next.catch(() => undefined);
    return next;
  }

  onOffer(sdp: string): Promise<void> {
    return this.enqueue(() => this.applyOffer(sdp));
  }

  private async applyOffer(sdp: string): Promise<void> {
    // Roles are fixed and this session never renegotiates, so a second offer is
    // a retransmit. Answering it again is exactly what threw before.
    if (this.answered) return;
    await this.acquire();
    if (this.closed) return;
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    if (this.closed) return;
    this.remoteSet = true;
    await this.flushIce();
    if (this.closed) return;
    // Re-check rather than assume: close() or a failed state transition during
    // the awaits above would make createAnswer throw.
    if (this.pc.signalingState !== "have-remote-offer") return;
    const answer = await this.pc.createAnswer();
    if (this.closed) return;
    await this.pc.setLocalDescription(answer);
    this.answered = true;
    this.o.sendFrame({ type: "rtc.answer", toUserId: this.o.peerId, offerId: this.o.callId, sdp: answer.sdp ?? "" });
  }

  onAnswer(sdp: string): Promise<void> {
    return this.enqueue(() => this.applyAnswer(sdp));
  }

  private async applyAnswer(sdp: string): Promise<void> {
    // Same shape of bug on the caller's side: setRemoteDescription({answer}) is
    // only legal from have-local-offer, so a duplicate answer frame threw too.
    if (this.pc.signalingState !== "have-local-offer") return;
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    if (this.closed) return;
    this.remoteSet = true;
    await this.flushIce();
  }

  async onIce(encoded: string): Promise<void> {
    let init: RTCIceCandidateInit;
    try {
      init = JSON.parse(encoded) as RTCIceCandidateInit;
    } catch {
      return;
    }
    if (!this.remoteSet) {
      this.pendingIce.push(init);
      return;
    }
    try {
      await this.pc.addIceCandidate(init);
    } catch {
      /* late / duplicate candidate — safe to ignore */
    }
  }

  private async flushIce(): Promise<void> {
    for (const c of this.pendingIce.splice(0)) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    }
  }

  get localStream(): MediaStream | undefined {
    return this.local;
  }
  get remoteStream(): MediaStream {
    return this.remote;
  }

  toggleMic(on?: boolean): boolean {
    const tracks = this.local?.getAudioTracks() ?? [];
    const enabled = on ?? !(tracks[0]?.enabled ?? false);
    for (const t of tracks) t.enabled = enabled;
    return enabled;
  }
  toggleCam(on?: boolean): boolean {
    const tracks = this.local?.getVideoTracks() ?? [];
    const enabled = on ?? !(tracks[0]?.enabled ?? false);
    for (const t of tracks) t.enabled = enabled;
    return enabled;
  }

  close(reason = "ended"): void {
    if (this.closed) return;
    this.closed = true;
    this.local?.getTracks().forEach((t) => t.stop());
    this.remote.getTracks().forEach((t) => t.stop());
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.o.onClosed(reason);
  }
}
