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

  /** Caller: acquire media + send the offer (called after call.accept). */
  async startCaller(): Promise<void> {
    await this.acquire();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.o.sendFrame({ type: "rtc.offer", toUserId: this.o.peerId, offerId: this.o.callId, sdp: offer.sdp ?? "" });
  }

  /** Callee: acquire media up-front (on accept) so it's ready when the offer lands. */
  async prepareCallee(): Promise<void> {
    await this.acquire();
  }

  async onOffer(sdp: string): Promise<void> {
    await this.acquire();
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    this.remoteSet = true;
    await this.flushIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.o.sendFrame({ type: "rtc.answer", toUserId: this.o.peerId, offerId: this.o.callId, sdp: answer.sdp ?? "" });
  }

  async onAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
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
