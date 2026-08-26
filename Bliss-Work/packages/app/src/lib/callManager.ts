import type { ClientFrame } from "@taskboard/shared";

export type CallMedia = "audio" | "video";

/**
 * Microphone capture constraints.
 *
 * `audio: true` alone leaves all three of these to the user agent's discretion,
 * and "whatever the UA felt like" is not a spec guarantee — it varies by
 * browser, by Electron version, and by whether the OS driver is already doing
 * some of it. That produced calls with audible background noise: room tone and
 * keyboard clatter carried through untouched, and worse, the peer's voice
 * leaving the speakers and re-entering the mic to be sent back as echo.
 *
 *   echoCancellation — the big one for anyone not on headphones. Without it,
 *     speaker output loops back through the mic; mild cases sound like a noisy
 *     background, bad ones howl.
 *   noiseSuppression — removes steady-state room noise (fans, traffic, hiss).
 *   autoGainControl  — levels a quiet or over-hot mic instead of letting it
 *     hiss at high gain or clip.
 *
 * Requested as plain booleans rather than `{ ideal: true }` so a device that
 * genuinely cannot do them still yields a track instead of failing the call —
 * these are optional by nature, and a call with noise beats no call.
 */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * Anything the two ends of a call say to each other that is not media.
 *
 * Rides an SCTP data channel on the SAME peer connection as the audio and
 * video, rather than the signaling socket. Three reasons, in order of weight:
 * it is scoped to this call by construction (no callId to check, no frame that
 * can arrive for a call that ended); it needs no new frame type on the gateway,
 * which keeps a purely client-side feature purely client-side; and it arrives
 * at the speed of the media path, where the server-side call events go through
 * the outbox and land a beat later.
 *
 *   state   what the peer's own controls are doing, so "camera off" shows an
 *           avatar instead of a frozen frame and "sharing" can be labelled as a
 *           screen rather than a camera.
 *   record  the id of the persistent call row backing this ring. Minted by the
 *           caller after the invite goes out (see useCall) and told to the
 *           callee here, because both ends need it to call /share and
 *           /participants.
 *   room    "I have added someone; the two of us are moving to the SFU." Three
 *           people cannot share one peer connection.
 */
export type CallPeerMessage =
  | { t: "state"; mic: boolean; cam: boolean; sharing: boolean }
  | { t: "record"; callId: string }
  | { t: "room"; callId: string };

export interface CallSessionOpts {
  callId: string;
  peerId: string;
  media: CallMedia;
  iceConfig: RTCConfiguration;
  sendFrame: (f: ClientFrame) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onConnected: () => void;
  onClosed: (reason: string) => void;
  /** Whether the peer's video track is actually carrying pictures right now —
   *  their camera or their screen. Drives "show the video element" vs "show the
   *  avatar", which cannot be inferred from the track's existence: the video
   *  slot is negotiated up front and stays there, empty, all through a voice
   *  call. */
  onRemoteVideo?: (live: boolean) => void;
  /** A CallPeerMessage from the other end. */
  onPeerMessage?: (msg: CallPeerMessage) => void;
  /** The user stopped the share from the browser's own "Stop sharing" bar
   *  rather than from ours. */
  onShareEnded?: () => void;
  /** The metadata channel is open. Anything that has to reach the peer exactly
   *  once — the id of the call row backing this ring — is sent from here,
   *  because a send before this point is silently dropped. */
  onMetaOpen?: () => void;
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
 *
 * ── Why the video slot exists even on a voice call ───────────────────────────
 * acquire() always adds a sendrecv VIDEO transceiver, whether or not there is a
 * camera track to put in it. That one line is what lets the in-call controls
 * turn the camera on, or start a screen share, in the middle of a call that
 * started as audio: the m-line is already negotiated, so switching what is sent
 * is a replaceTrack() on the existing sender and needs no second offer. Without
 * it those controls would require renegotiation, and this session deliberately
 * does not renegotiate — the fixed-roles design that keeps it free of glare is
 * the same design that makes a mid-call offer unsafe.
 *
 * It must be added BEFORE the remote offer is applied, which is why it lives in
 * acquire() rather than anywhere later: a transceiver created by applying an
 * offer comes out `recvonly`, and a recvonly sender never transmits however
 * many tracks you replace into it.
 */
export class CallSession {
  private readonly pc: RTCPeerConnection;
  private local?: MediaStream;
  /** The screen capture, while one is running. Separate from `local` so that
   *  stopping the share puts the camera back exactly as the user left it. */
  private screen?: MediaStream;
  /** The pre-negotiated video slot — see the class note. */
  private videoTx?: RTCRtpTransceiver;
  /** What the user has asked the camera to do, which is not the same as what is
   *  on the wire: while a screen is being shared the camera is off the sender
   *  and this is what it goes back to. */
  private camWanted: boolean;
  private meta?: RTCDataChannel;
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
    this.camWanted = o.media === "video";

    // The caller opens the metadata channel (only the offerer may, without a
    // renegotiation); the callee is handed it here.
    this.pc.ondatachannel = (e) => this.bindMeta(e.channel);

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
      if (e.track.kind === "video") this.watchRemoteVideo(e.track);
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "connected") o.onConnected();
      else if (this.pc.connectionState === "failed") this.close("connection failed");
    };
  }

  private async acquire(): Promise<void> {
    if (this.local) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: this.o.media === "video",
    });
    // close() can run while getUserMedia is still awaiting the permission
    // prompt (e.g. the user cancels, or the peer connection fails, before the
    // browser resolves it). close() only stops tracks it already knows about,
    // so a stream that lands after that point would otherwise sit on the
    // session forever with the camera/mic light still on and nothing left to
    // stop it — the session is already closed and will never call stop() again.
    if (this.closed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.local = stream;
    for (const track of this.local.getAudioTracks()) this.pc.addTrack(track, this.local);
    // One video slot, always — with the camera in it on a video call, and empty
    // on a voice call so the Video and Share Screen controls have somewhere to
    // put a track later. See the class note.
    const cam = this.local.getVideoTracks()[0] ?? null;
    this.videoTx = this.pc.addTransceiver(cam ?? "video", {
      direction: "sendrecv",
      streams: [this.local],
    });
  }

  /** Attach the metadata channel and start reporting our own state on it. */
  private bindMeta(ch: RTCDataChannel): void {
    this.meta = ch;
    const opened = () => {
      this.announce();
      this.o.onMetaOpen?.();
    };
    ch.onopen = opened;
    // The callee is handed a channel that some browsers have already opened, in
    // which case `open` has been and gone and the handler above never fires.
    if (ch.readyState === "open") opened();
    ch.onmessage = (e) => {
      try {
        this.o.onPeerMessage?.(JSON.parse(String(e.data)) as CallPeerMessage);
      } catch {
        /* not ours, or malformed — a call is not worth dropping over it */
      }
    };
  }

  /** Send the peer a non-media message. Best-effort by design: the channel is
   *  open for the life of a connected call, and anything sent before it opens
   *  or after it closes is state the other end re-learns from the next
   *  announce() or from the server. */
  send(msg: CallPeerMessage): void {
    if (this.meta?.readyState !== "open") return;
    try {
      this.meta.send(JSON.stringify(msg));
    } catch {
      /* channel closed under us */
    }
  }

  /** Tell the peer what our controls are doing. */
  private announce(): void {
    this.send({
      t: "state",
      mic: this.local?.getAudioTracks()[0]?.enabled ?? false,
      cam: this.camWanted,
      sharing: !!this.screen,
    });
  }

  /** Report whether the peer's video slot is actually carrying pictures. The
   *  track exists from the moment the call connects; `muted` is what says
   *  whether anything is coming down it. */
  private watchRemoteVideo(track: MediaStreamTrack): void {
    const report = () => this.o.onRemoteVideo?.(!track.muted && track.readyState === "live");
    track.addEventListener("mute", report);
    track.addEventListener("unmute", report);
    track.addEventListener("ended", report);
    report();
  }

  /** Caller: acquire media + send the offer (called after call.accept).
   *
   *  Queued like every other signaling step so the offer is fully applied before
   *  an answer can be. Otherwise an answer arriving while getUserMedia is still
   *  blocked on the permission prompt would find signalingState `stable` and be
   *  dropped, and the call would never connect. */
  startCaller(): Promise<void> {
    return this.enqueue(async () => {
      // Before the offer, so the channel is described by it: only the offerer
      // may open one, and this session does not renegotiate.
      this.bindMeta(this.pc.createDataChannel("call-meta"));
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
  /** The screen capture, for the sharer's own preview. */
  get screenStream(): MediaStream | undefined {
    return this.screen;
  }
  get sharing(): boolean {
    return !!this.screen;
  }

  toggleMic(on?: boolean): boolean {
    const tracks = this.local?.getAudioTracks() ?? [];
    const enabled = on ?? !(tracks[0]?.enabled ?? false);
    for (const t of tracks) t.enabled = enabled;
    this.announce();
    return enabled;
  }

  /**
   * Turn the camera on or off, including on a call that started as voice-only.
   *
   * The first "on" for a voice call is the one that does real work: there is no
   * camera track yet, so it asks for one — a permission prompt the user has not
   * seen at this point in the call — and drops it into the video slot reserved
   * at acquire() time. Off is replaceTrack(null) rather than `enabled = false`
   * so the peer's track goes properly muted and their UI shows an avatar,
   * instead of a still frame of whatever the camera saw last.
   */
  async setCam(on?: boolean): Promise<boolean> {
    if (!this.local) return false;
    const want = on ?? !this.camWanted;
    let track = this.local.getVideoTracks()[0];
    if (want && !track) {
      const extra = await navigator.mediaDevices.getUserMedia({ video: true });
      // Same race as acquire(): the call can end while this permission prompt
      // is still open. A track landing after close() has nothing left to stop
      // it, so it must be stopped here instead of added to the (torn-down) call.
      if (this.closed) {
        extra.getTracks().forEach((t) => t.stop());
        return false;
      }
      track = extra.getVideoTracks()[0];
      if (!track) return false;
      this.local.addTrack(track);
    }
    if (track) track.enabled = want;
    this.camWanted = want;
    // A live share owns the sender; the camera takes its place again when the
    // share stops (see stopShare).
    if (!this.screen) await this.videoTx?.sender.replaceTrack(want ? (track ?? null) : null);
    this.announce();
    return want;
  }

  /**
   * Start sharing a screen, window or tab.
   *
   * Returns what the user actually picked, as the browser reports it
   * (`displaySurface`): "monitor" | "window" | "browser". The API accepts those
   * spellings directly, so the caller can hand the value straight to
   * POST /calls/{id}/share without translating it.
   */
  async startShare(): Promise<string> {
    if (!this.videoTx) throw new Error("call has no video slot");
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    // Same race as acquire(): the call (or the share) can end while the
    // picker is still open. A stream landing after close() has nothing left
    // to stop it, so it must be stopped here rather than wired into the
    // (torn-down) call.
    if (this.closed) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("call ended");
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("no screen track");
    }
    this.screen?.getTracks().forEach((t) => t.stop());
    this.screen = stream;
    await this.videoTx.sender.replaceTrack(track);
    // Chrome's own "Stop sharing" bar is not our button, but it ends the share
    // all the same. Without this the app would keep claiming to share a screen
    // that stopped, and would never put the camera back.
    track.addEventListener("ended", () => {
      void this.stopShare().then(() => this.o.onShareEnded?.());
    });
    this.announce();
    const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
    return settings.displaySurface ?? "monitor";
  }

  /** Stop sharing and give the video slot back to the camera, if the user had
   *  it on. Safe to call when nothing is being shared. */
  async stopShare(): Promise<void> {
    if (!this.screen) return;
    this.screen.getTracks().forEach((t) => t.stop());
    this.screen = undefined;
    const cam = this.local?.getVideoTracks()[0] ?? null;
    await this.videoTx?.sender.replaceTrack(this.camWanted ? cam : null);
    this.announce();
  }

  close(reason = "ended"): void {
    if (this.closed) return;
    this.closed = true;
    this.local?.getTracks().forEach((t) => t.stop());
    this.screen?.getTracks().forEach((t) => t.stop());
    this.remote.getTracks().forEach((t) => t.stop());
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.o.onClosed(reason);
  }
}
