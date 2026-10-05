import { AppState } from 'react-native';
import {
  MediaStream,
  RTCPeerConnection,
  mediaDevices,
  type MediaStreamTrack,
  type RTCRtpTransceiver,
} from '@livekit/react-native-webrtc';
import type { PeerMessage, SessionLike, SessionOpts, StreamHandle } from './callController';

/**
 * One 1:1 WebRTC media session on the native WebRTC stack.
 *
 * Wire-compatible with the web/desktop `CallSession` (packages/app
 * callManager.ts) so a mobile user and a browser/desktop user can call each
 * other: the CALLER creates the offer after the callee accepts, the CALLEE
 * answers, SDP/ICE ride the existing rtc.offer/answer/ice frames with
 * offerId === callId, and non-media messages (peer camera state, the call-row
 * id, "moved to the room") ride the "call-meta" data channel the caller opens.
 *
 * The one deliberate structural match with web: a single sendrecv VIDEO
 * transceiver is added up front even on a voice call. That is what lets the
 * camera be switched on mid-call with replaceTrack() and no renegotiation.
 *
 * Mobile has no screen sharing, so that half of the web session is omitted.
 */
type RTCDataChannel = ReturnType<RTCPeerConnection['createDataChannel']>;

export class MobileCallSession implements SessionLike {
  private readonly pc: RTCPeerConnection;
  private local?: MediaStream;
  private videoTx?: RTCRtpTransceiver;
  private camWanted: boolean;
  private facing: 'user' | 'environment' = 'user';
  private appSub?: { remove(): void };
  private meta?: RTCDataChannel;
  private readonly remote = new MediaStream();
  private readonly pendingIce: unknown[] = [];
  private remoteSet = false;
  private closed = false;
  private answered = false;
  /** Serialises signalling steps — see the web session for the InvalidState
   *  race this prevents. */
  private ops: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: SessionOpts) {
    this.pc = new RTCPeerConnection(o.iceConfig as never);
    this.camWanted = o.media === 'video';
    // Android takes the camera away while the screen is locked / the app is
    // stopped; the track then reads 'ended' and the preview would freeze.
    this.appSub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void this.recoverCamera();
    });

    this.pc.addEventListener('datachannel', (e: { channel: RTCDataChannel }) => this.bindMeta(e.channel));
    this.pc.addEventListener('icecandidate', (e: { candidate: { toJSON(): unknown } | null }) => {
      if (!e.candidate) return;
      o.sendFrame({
        type: 'rtc.ice',
        toUserId: o.peerId,
        offerId: o.callId,
        candidate: JSON.stringify(e.candidate.toJSON()),
      });
    });
    this.pc.addEventListener('track', (e) => {
      const tracks = e.streams[0]?.getTracks() ?? (e.track ? [e.track] : []);
      for (const t of tracks) if (!this.remote.getTracks().includes(t)) this.remote.addTrack(t);
      o.onRemoteStream(this.remote as unknown as StreamHandle);
    });
    this.pc.addEventListener('connectionstatechange', () => {
      const state = this.pc.connectionState;
      o.onConnectionState(state);
      if (state === 'connected') o.onConnected();
      else if (state === 'failed') this.close('connection failed');
    });
  }

  get localStream(): StreamHandle | undefined {
    return this.local as unknown as StreamHandle | undefined;
  }
  get remoteStream(): StreamHandle {
    return this.remote as unknown as StreamHandle;
  }

  private async acquire(): Promise<void> {
    if (this.local) return;
    const stream = await mediaDevices.getUserMedia({
      // Echo cancellation, noise suppression and AGC are on by default in the
      // native WebRTC audio module (this stack's constraint type has no keys
      // for them), which is the same trio web requests explicitly.
      audio: true,
      video: this.o.media === 'video' ? { facingMode: this.facing } : false,
    });
    // close() can run while the permission prompt is open; a stream that lands
    // afterwards would otherwise keep the mic/camera on with nothing to stop it.
    if (this.closed) {
      stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      return;
    }
    this.local = stream;
    for (const track of stream.getAudioTracks()) this.pc.addTrack(track, stream);
    const cam = stream.getVideoTracks()[0] ?? null;
    this.videoTx = this.pc.addTransceiver(cam ?? 'video', { direction: 'sendrecv', streams: [stream] });
  }

  private bindMeta(ch: RTCDataChannel): void {
    this.meta = ch;
    const opened = () => {
      this.announce();
      this.o.onMetaOpen();
    };
    ch.addEventListener('open', opened);
    if (ch.readyState === 'open') opened();
    ch.addEventListener('message', (e: { data: unknown }) => {
      try {
        this.o.onPeerMessage(JSON.parse(String(e.data)) as PeerMessage);
      } catch {
        /* not ours, or malformed — a call is not worth dropping over it */
      }
    });
  }

  send(msg: PeerMessage): void {
    if (this.meta?.readyState !== 'open') return;
    try {
      this.meta.send(JSON.stringify(msg));
    } catch {
      /* channel closed under us */
    }
  }

  private announce(): void {
    this.send({
      t: 'state',
      mic: this.local?.getAudioTracks()[0]?.enabled ?? false,
      cam: this.camWanted,
      sharing: false,
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const next = this.ops.then(() => (this.closed ? undefined : fn()));
    this.ops = next.catch(() => undefined);
    return next;
  }

  startCaller(): Promise<void> {
    return this.enqueue(async () => {
      this.bindMeta(this.pc.createDataChannel('call-meta'));
      await this.acquire();
      if (this.closed) return;
      const offer = await this.pc.createOffer({});
      if (this.closed) return;
      await this.pc.setLocalDescription(offer);
      this.o.sendFrame({ type: 'rtc.offer', toUserId: this.o.peerId, offerId: this.o.callId, sdp: offer.sdp ?? '' });
    }) as Promise<void>;
  }

  async prepareCallee(): Promise<void> {
    await this.acquire();
  }

  onOffer(sdp: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.answered) return; // a retransmit
      await this.acquire();
      if (this.closed) return;
      await this.pc.setRemoteDescription({ type: 'offer', sdp } as never);
      if (this.closed) return;
      this.remoteSet = true;
      await this.flushIce();
      if (this.closed || this.pc.signalingState !== 'have-remote-offer') return;
      const answer = await this.pc.createAnswer();
      if (this.closed) return;
      await this.pc.setLocalDescription(answer);
      this.answered = true;
      this.o.sendFrame({ type: 'rtc.answer', toUserId: this.o.peerId, offerId: this.o.callId, sdp: answer.sdp ?? '' });
    }) as Promise<void>;
  }

  onAnswer(sdp: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.pc.signalingState !== 'have-local-offer') return;
      await this.pc.setRemoteDescription({ type: 'answer', sdp } as never);
      if (this.closed) return;
      this.remoteSet = true;
      await this.flushIce();
    }) as Promise<void>;
  }

  async onIce(encoded: string): Promise<void> {
    let init: unknown;
    try {
      init = JSON.parse(encoded);
    } catch {
      return;
    }
    if (!this.remoteSet) {
      this.pendingIce.push(init);
      return;
    }
    try {
      await this.pc.addIceCandidate(init as never);
    } catch {
      /* late / duplicate candidate */
    }
  }

  private async flushIce(): Promise<void> {
    for (const c of this.pendingIce.splice(0)) {
      try {
        await this.pc.addIceCandidate(c as never);
      } catch {
        /* ignore */
      }
    }
  }

  toggleMic(on?: boolean): boolean {
    const tracks = this.local?.getAudioTracks() ?? [];
    const enabled = on ?? !(tracks[0]?.enabled ?? false);
    for (const t of tracks) t.enabled = enabled;
    this.announce();
    return enabled;
  }

  /** Camera on/off, including the first "on" of a voice call, which acquires a
   *  track and drops it into the video slot reserved by acquire(). Off is
   *  replaceTrack(null) so the peer's UI shows an avatar, not a frozen frame. */
  async setCam(on?: boolean): Promise<boolean> {
    const result = await this.enqueue(async () => {
      if (!this.local) return false;
      const want = on ?? !this.camWanted;
      let track = this.local.getVideoTracks()[0];
      if (want && (!track || track.readyState === 'ended')) {
        if (track) this.local.removeTrack(track);
        const extra = await mediaDevices.getUserMedia({ video: { facingMode: this.facing } });
        if (this.closed) {
          extra.getTracks().forEach((t: MediaStreamTrack) => t.stop());
          return false;
        }
        track = extra.getVideoTracks()[0];
        if (!track) return false;
        this.local.addTrack(track);
      }
      if (track) track.enabled = want;
      this.camWanted = want;
      await this.videoTx?.sender.replaceTrack(want ? (track ?? null) : null);
      this.announce();
      return want;
    });
    return result ?? false;
  }

  /** Front <-> back camera. The call stays connected: a capturer on the other
   *  facingMode is swapped onto the SAME sender (replaceTrack — no
   *  renegotiation, the peer's video simply continues from the other camera).
   *
   *  NOT `track._switchCamera()`: in @livekit/react-native-webrtc 144 that is
   *  applyConstraints({facingMode}), which the native side refuses to honour
   *  (facing can't change through applyConstraints), so it silently did nothing. */
  async switchCamera(): Promise<void> {
    await this.enqueue(async () => {
      const old = this.local?.getVideoTracks()[0];
      if (this.closed || !this.local || !this.camWanted || !old) return;
      const next: 'user' | 'environment' = this.facing === 'user' ? 'environment' : 'user';
      // One camera at a time: free the current capturer before opening the other.
      this.local.removeTrack(old);
      old.stop();
      (old as MediaStreamTrack & { release?: () => void }).release?.();
      let fresh: MediaStreamTrack | undefined;
      let facing: 'user' | 'environment' = next;
      try {
        fresh = (await mediaDevices.getUserMedia({ video: { facingMode: next } })).getVideoTracks()[0];
      } catch {
        // No such camera: go back to the one we had.
        facing = this.facing;
        fresh = (await mediaDevices.getUserMedia({ video: { facingMode: facing } })).getVideoTracks()[0];
      }
      if (!fresh) return;
      if (this.closed) {
        fresh.stop();
        return;
      }
      this.local.addTrack(fresh);
      this.facing = facing;
      this._camEpoch++;
      await this.videoTx?.sender.replaceTrack(fresh);
    });
  }

  /** Bumped each time a new camera track is swapped into the (unchanged) local
   *  stream. The stream's URL stays the same, so a native RTCView would keep
   *  rendering the stopped track; the UI keys the preview on this to rebind it. */
  get camEpoch(): number {
    return this._camEpoch;
  }
  private _camEpoch = 0;

  get frontFacing(): boolean {
    return this.facing === 'user';
  }

  /** The OS ended our camera while we were away: get a fresh one into the same slot. */
  private async recoverCamera(): Promise<void> {
    await this.enqueue(async () => {
      const old = this.local?.getVideoTracks()[0];
      if (this.closed || !this.local || !this.camWanted || !old || old.readyState !== 'ended') return;
      const fresh = (await mediaDevices.getUserMedia({ video: { facingMode: this.facing } })).getVideoTracks()[0];
      if (!fresh) return;
      if (this.closed) {
        fresh.stop();
        return;
      }
      this.local.removeTrack(old);
      this.local.addTrack(fresh);
      await this.videoTx?.sender.replaceTrack(fresh);
    }).catch(() => {});
  }

  close(reason = 'ended'): void {
    if (this.closed) return;
    this.closed = true;
    this.appSub?.remove();
    this.appSub = undefined;
    this.local?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    this.remote.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.o.onClosed(reason);
  }
}
