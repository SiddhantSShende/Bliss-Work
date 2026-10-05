import type { ClientFrame, ControlFrame } from '@taskboard/shared';
import { addPeopleSequentially, type AddPeopleOutcome, type AddProgress, type Invitee } from './addPeople';

/**
 * Mobile's 1:1 call state machine.
 *
 * Speaks the SAME wire protocol web/desktop already use (packages/app
 * useCall.tsx, which cannot be imported here: it is DOM/`sonner`/Notification
 * based) so a mobile user and a web/desktop user can call each other:
 *
 *   caller  -> call.invite            (WS control frame, ephemeral)
 *   callee  -> call.accept | call.decline
 *   caller  -> rtc.offer  ... callee -> rtc.answer, both -> rtc.ice
 *   either  -> call.cancel (while ringing) | call.end (once answered)
 *
 * This file has no React and no native imports on purpose: the transport, API,
 * session factory and side effects (notifications, permissions) are injected,
 * so every flow below is unit-testable without a device.
 */

export type CallMedia = 'audio' | 'video';

export type CallPhase =
  | 'idle'
  | 'outgoing' // we are ringing them
  | 'incoming' // they are ringing us
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended'
  | 'rejected' // the callee declined
  | 'failed';

/** Anything with the two members the UI needs from an RN-webrtc MediaStream. */
export interface StreamHandle {
  toURL(): string;
  getVideoTracks(): unknown[];
}

export interface CallSnapshot {
  phase: CallPhase;
  callId?: string;
  peerId?: string;
  peerName?: string;
  media?: CallMedia;
  micOn: boolean;
  camOn: boolean;
  /** The preview is mirrored (front camera). False while the back camera is live. */
  camMirror: boolean;
  /** Bumped on every camera flip so the preview view rebinds to the new track. */
  camEpoch: number;
  speakerOn: boolean;
  /** What the peer's own controls say (from the call's data channel). */
  peerCamOn: boolean;
  /** The peer is sharing their screen (web/desktop can; mobile only views it). */
  peerSharing: boolean;
  connectedAt?: number;
  /** The persistent call row behind this 1:1 ring. Add member needs it (the
   *  ring's own id is known only to the two ends); the caller mints it a moment
   *  after ringing, the callee learns it over the call's data channel. */
  recordId?: string;
  /** Why the call ended/failed, for the UI. */
  reason?: string;
  localStream?: StreamHandle;
  remoteStream?: StreamHandle;
}

/** Non-media messages the two ends exchange over the call's data channel. */
export type PeerMessage =
  | { t: 'state'; mic: boolean; cam: boolean; sharing: boolean }
  | { t: 'record'; callId: string }
  | { t: 'room'; callId: string };

export interface SessionOpts {
  callId: string;
  peerId: string;
  media: CallMedia;
  iceConfig: { iceServers?: unknown[]; bundlePolicy?: string };
  sendFrame: (f: ClientFrame) => void;
  onRemoteStream: (s: StreamHandle) => void;
  onConnected: () => void;
  onConnectionState: (state: string) => void;
  onPeerMessage: (m: PeerMessage) => void;
  onMetaOpen: () => void;
  onClosed: (reason: string) => void;
}

export interface SessionLike {
  readonly localStream?: StreamHandle;
  readonly remoteStream?: StreamHandle;
  prepareCallee(): Promise<void>;
  startCaller(): Promise<void>;
  onOffer(sdp: string): Promise<void>;
  onAnswer(sdp: string): Promise<void>;
  onIce(candidate: string): Promise<void>;
  toggleMic(on?: boolean): boolean;
  setCam(on?: boolean): Promise<boolean>;
  switchCamera(): Promise<void> | void;
  /** True while the front camera is live (drives the preview's mirroring). */
  readonly frontFacing?: boolean;
  readonly camEpoch?: number;
  send(m: PeerMessage): void;
  close(reason?: string): void;
}

export interface CallApiLike {
  turnCredentials(): Promise<{ iceServers?: unknown[] }>;
  startDirectCall(peerId: string, media: CallMedia): Promise<{ id: string }>;
  endCall(callId: string): Promise<unknown>;
  leaveCall(callId: string): Promise<unknown>;
  sendMessage(recipientId: string, body: string, clientMsgId?: string, kind?: 'call_missed'): Promise<unknown>;
  /** Prove the SFU room is reachable before anybody is added (web does the same). */
  callToken(callId: string): Promise<unknown>;
  /** POST /calls/:id/participants — the server rings the newcomer. */
  addCallParticipant(callId: string, userId: string): Promise<unknown>;
}

export interface CallDeps {
  rtc: {
    sendFrame: (f: ClientFrame) => void;
    onControl: (cb: (f: ControlFrame) => void) => () => void;
  };
  api: CallApiLike;
  selfId: () => string | undefined;
  createSession: (o: SessionOpts) => SessionLike;
  newId: () => string;
  /** Mic (+ camera for video) permission. Resolve false when refused. */
  ensurePermissions: (media: CallMedia) => Promise<boolean>;
  /** Camera permission when turning the camera on mid-call. Resolve false when refused. */
  ensureCamera?: () => Promise<boolean>;
  /** The camera was permitted but would not start. */
  cameraFailed?: () => void;
  cachedName?: (userId: string) => string | undefined;
  resolveName?: (userId: string) => Promise<string | undefined>;
  /** Route audio to the loudspeaker or the earpiece. */
  applySpeaker?: (on: boolean) => void;
  /** Another call (a room/meeting) already holds the mic: refuse new rings. */
  isBusy?: () => boolean;
  /** Called on every incoming ring so the shell can post a notification. */
  onIncoming?: (c: { callId: string; name: string; media: CallMedia }) => void;
  /** The ring stopped mattering (answered, declined, cancelled, timed out). */
  onIncomingDone?: (callId: string, why: 'answered' | 'declined' | 'cancelled' | 'timeout') => void;
  /** A ring nobody picked up, from the callee's side. */
  onMissed?: (name: string, media: CallMedia) => void;
  /** Media moved to the SFU (someone was added): join this room instead. */
  onEnterRoom?: (callId: string, media: CallMedia) => void;
  /** A call row was created/closed — refresh Meetings lists. */
  onRecordChanged?: () => void;
  log?: (event: string, data?: Record<string, string | number | boolean | undefined>) => void;
  /** How long to let the `room` hand-over message flush before closing the
   *  peer connection that carries it. */
  handoverMs?: number;
  ringMs?: number;
  connectMs?: number;
  reconnectMs?: number;
  lingerMs?: number;
}

// Every optional field is listed (as undefined) on purpose: transitions use
// `replace`, and a key missing here would be a key that leaks from one call
// into the next (stale streams, an old connectedAt, an old reason).
const IDLE: CallSnapshot = {
  phase: 'idle',
  callId: undefined,
  peerId: undefined,
  peerName: undefined,
  media: undefined,
  micOn: true,
  camOn: false,
  camMirror: true,
  camEpoch: 0,
  speakerOn: false,
  peerCamOn: false,
  peerSharing: false,
  connectedAt: undefined,
  recordId: undefined,
  reason: undefined,
  localStream: undefined,
  remoteStream: undefined,
};

const STUN_FALLBACK = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  bundlePolicy: 'max-bundle',
};

type Listener = () => void;

/** Nothing live on screen: the dead-call screens (ended/rejected) clear
 *  themselves after a moment and must not turn a new call away meanwhile. */
const isFree = (p: CallPhase) => p === 'idle' || p === 'failed' || p === 'ended' || p === 'rejected';

export class CallController {
  private snap: CallSnapshot = IDLE;
  private readonly listeners = new Set<Listener>();
  private session: SessionLike | null = null;
  private incoming: { callId: string; peerId: string; media: CallMedia } | null = null;
  private record: string | undefined;
  private ringTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lingerTimer: ReturnType<typeof setTimeout> | undefined;
  private off: (() => void) | undefined;

  constructor(private readonly d: CallDeps) {}

  // ── store ────────────────────────────────────────────────────────────────
  getSnapshot = (): CallSnapshot => this.snap;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<CallSnapshot> | ((s: CallSnapshot) => Partial<CallSnapshot>)) {
    const p = typeof patch === 'function' ? patch(this.snap) : patch;
    this.snap = { ...this.snap, ...p };
    for (const l of this.listeners) l();
  }

  /** Start a fresh call state: nothing from the previous one may survive. */
  private replace(next: CallSnapshot) {
    this.snap = next;
    for (const l of this.listeners) l();
  }

  private log(event: string, data?: Record<string, string | number | boolean | undefined>) {
    this.d.log?.(event, data);
  }

  /** Begin listening for inbound call/rtc frames. Returns dispose. */
  start(): () => void {
    this.off?.();
    this.off = this.d.rtc.onControl((f) => void this.onFrame(f));
    return () => this.dispose();
  }

  dispose(): void {
    this.off?.();
    this.off = undefined;
    this.clearTimers();
    const s = this.session;
    const ringing = this.incoming;
    this.session = null;
    this.incoming = null;
    this.record = undefined;
    s?.close('disposed');
    // Disposed (sign-out / provider rebuilt) while still ringing: finish() is bypassed,
    // so without this the foreground ringtone would loop until the process dies.
    if (ringing) this.d.onIncomingDone?.(ringing.callId, 'cancelled');
    // Signed out (or unmounted) mid-call: nothing must survive to reappear
    // on the next sign-in.
    this.replace({ ...IDLE });
  }

  // ── timers ───────────────────────────────────────────────────────────────
  private clearRing() {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = undefined;
  }
  private clearConnectTimers() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connectTimer = this.reconnectTimer = undefined;
  }
  private clearTimers() {
    this.clearRing();
    this.clearConnectTimers();
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = undefined;
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private async iceConfig() {
    try {
      const creds = await this.d.api.turnCredentials();
      if (creds.iceServers?.length) return { iceServers: creds.iceServers, bundlePolicy: 'max-bundle' };
    } catch {
      /* STUN-only fallback: same-network calls still work */
    }
    return STUN_FALLBACK;
  }

  private closeRecord(callId: string, leaveOnly: boolean) {
    const done = () => this.d.onRecordChanged?.();
    if (leaveOnly) void this.d.api.leaveCall(callId).catch(() => {}).then(done);
    else void this.d.api.endCall(callId).catch(() => this.d.api.leaveCall(callId).catch(() => {})).then(done);
  }

  /** Leave the call. `phase` is what the UI shows next; the closed states
   *  fall back to idle on their own so nobody is stuck on a dead screen. */
  private finish(phase: 'idle' | 'ended' | 'rejected' | 'failed', reason?: string) {
    this.clearTimers();
    const s = this.session;
    this.session = null;
    s?.close(reason ?? 'ended');
    // Only a ring that is still ringing needs dismissing; an answered one was
    // already reported by accept().
    const wasIncoming = this.snap.phase === 'incoming' ? this.incoming : null;
    this.incoming = null;
    const record = this.record;
    this.record = undefined;
    if (record) this.closeRecord(record, false);
    if (wasIncoming) this.d.onIncomingDone?.(wasIncoming.callId, 'cancelled');
    this.log('call.finish', { phase, reason, callId: this.snap.callId });
    const cur = this.snap;
    this.replace(
      phase === 'idle'
        ? { ...IDLE, speakerOn: cur.speakerOn }
        : { ...IDLE, phase, reason, callId: cur.callId, peerId: cur.peerId, peerName: cur.peerName, media: cur.media },
    );
    if (phase === 'ended' || phase === 'rejected') {
      this.lingerTimer = setTimeout(() => {
        if (this.snap.phase === phase) this.replace({ ...IDLE });
      }, this.d.lingerMs ?? 2500);
    }
  }

  private newSession(callId: string, peerId: string, media: CallMedia, iceConfig: SessionOpts['iceConfig']) {
    const sessionRef: { current?: SessionLike } = {};
    const s = this.d.createSession({
      callId,
      peerId,
      media,
      iceConfig,
      sendFrame: (f) => this.d.rtc.sendFrame(f),
      onRemoteStream: (stream) => {
        // A closed session can still emit; only the live one may touch state.
        if (this.session === sessionRef.current) this.set({ remoteStream: stream });
      },
      onConnected: () => {
        if (this.session !== sessionRef.current) return;
        this.clearConnectTimers();
        this.set((cur) => ({
          phase: 'connected',
          connectedAt: cur.connectedAt ?? Date.now(),
          localStream: sessionRef.current?.localStream,
          remoteStream: sessionRef.current?.remoteStream,
          reason: undefined,
        }));
      },
      onConnectionState: (state) => {
        this.log('call.ice', { callId, state });
        if (this.session !== sessionRef.current) return;
        if (state === 'disconnected' && this.snap.phase === 'connected') {
          this.set({ phase: 'reconnecting' });
          this.reconnectTimer = setTimeout(
            () => this.fail('Call connection failed'),
            this.d.reconnectMs ?? 25_000,
          );
        } else if (state === 'connected' && this.snap.phase === 'reconnecting') {
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
          this.set({ phase: 'connected' });
        }
      },
      onPeerMessage: (m) => {
        switch (m.t) {
          case 'state':
            this.set({ peerCamOn: m.cam, peerSharing: m.sharing });
            break;
          case 'record':
            if (!this.record) {
              this.record = m.callId;
              this.set({ recordId: m.callId });
            }
            break;
          case 'room': {
            const media = this.snap.media ?? 'audio';
            this.detachForRoom();
            this.d.onEnterRoom?.(m.callId, media);
            break;
          }
        }
      },
      onMetaOpen: () => {
        if (this.record) sessionRef.current?.send({ t: 'record', callId: this.record });
      },
      onClosed: (reason) => {
        if (this.session !== sessionRef.current) return;
        if (reason === 'connection failed') this.fail('Call connection failed');
        else this.finish('ended', reason);
      },
    });
    sessionRef.current = s;
    this.session = s;
    return s;
  }

  /** Hand the call to the SFU room: drop the P2P session without ending the
   *  call row (the room now owns it). */
  private detachForRoom() {
    this.clearTimers();
    const s = this.session;
    this.session = null;
    s?.close('moved to the room');
    this.record = undefined;
    this.incoming = null;
    this.replace({ ...IDLE });
  }

  /** Connection failed: keep peer/media so the UI can offer Retry / End. */
  private fail(reason: string) {
    if (this.snap.phase === 'idle' || this.snap.phase === 'failed') return;
    this.finish('failed', reason);
  }

  private armConnectTimeout() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.snap.phase === 'connecting') this.fail('Call connection failed');
    }, this.d.connectMs ?? 45_000);
  }

  // ── actions ──────────────────────────────────────────────────────────────
  async invite(peerId: string, peerName: string, media: CallMedia): Promise<void> {
    if (!this.d.selfId() || !isFree(this.snap.phase)) return;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    const callId = this.d.newId();
    this.replace({ ...IDLE, phase: 'outgoing', callId, peerId, peerName, media, camOn: media === 'video' });
    // Ask BEFORE ringing: nobody should be rung by a call we cannot take.
    if (!(await this.d.ensurePermissions(media))) {
      if (this.snap.callId === callId) this.finish('failed', 'Microphone or camera permission is needed for calls');
      return;
    }
    if (this.snap.callId !== callId || (this.snap.phase as CallPhase) !== 'outgoing') return;
    this.log('call.invite', { callId, media });
    this.d.rtc.sendFrame({ type: 'call.invite', toUserId: peerId, callId, media });
    void this.backWithRecord(peerId, media, callId);
    this.clearRing();
    this.ringTimer = setTimeout(() => {
      this.d.rtc.sendFrame({ type: 'call.cancel', toUserId: peerId, callId });
      this.recordMissed(peerId, media);
      this.finish('ended', 'No answer');
    }, this.d.ringMs ?? 30_000);
  }

  /** Persistent call row behind the ring, so the call shows up in Meetings and
   *  history exactly like a web-placed one. Never blocks or fails the ring. */
  private async backWithRecord(peerId: string, media: CallMedia, ringId: string) {
    try {
      const row = await this.d.api.startDirectCall(peerId, media);
      if (this.snap.callId !== ringId) {
        void this.d.api.endCall(row.id).catch(() => {});
        return;
      }
      this.record = row.id;
      this.set({ recordId: row.id });
      this.session?.send({ t: 'record', callId: row.id });
      this.d.onRecordChanged?.();
    } catch {
      /* the call still works */
    }
  }

  private recordMissed(peerId: string, media: CallMedia) {
    void this.d.api
      .sendMessage(peerId, media === 'video' ? 'Missed video call' : 'Missed voice call', undefined, 'call_missed')
      .catch(() => {});
  }

  async accept(): Promise<void> {
    const inc = this.incoming;
    if (!inc || this.snap.phase !== 'incoming') return;
    this.clearRing();
    this.set({ phase: 'connecting' });
    this.armConnectTimeout();
    this.d.onIncomingDone?.(inc.callId, 'answered');
    if (!(await this.d.ensurePermissions(inc.media))) {
      if (this.incoming === inc) {
        this.d.rtc.sendFrame({ type: 'call.decline', toUserId: inc.peerId, callId: inc.callId });
        this.finish('failed', 'Microphone or camera permission is needed for calls');
      }
      return;
    }
    const cfg = await this.iceConfig();
    // The caller may have cancelled while we fetched ICE servers.
    if (this.incoming !== inc) return;
    const s = this.newSession(inc.callId, inc.peerId, inc.media, cfg);
    try {
      await s.prepareCallee();
    } catch {
      if (this.incoming === inc) {
        this.d.rtc.sendFrame({ type: 'call.decline', toUserId: inc.peerId, callId: inc.callId });
        this.finish('failed', 'Camera or microphone is unavailable');
      }
      return;
    }
    if (this.incoming !== inc || this.session !== s) return;
    this.set({ localStream: s.localStream });
    this.log('call.accept', { callId: inc.callId });
    this.d.rtc.sendFrame({ type: 'call.accept', toUserId: inc.peerId, callId: inc.callId });
  }

  decline(): void {
    const inc = this.incoming;
    if (!inc) return;
    this.log('call.decline', { callId: inc.callId });
    this.d.rtc.sendFrame({ type: 'call.decline', toUserId: inc.peerId, callId: inc.callId });
    this.d.onIncomingDone?.(inc.callId, 'declined');
    this.incoming = null;
    this.finish('idle');
  }

  /**
   * Add member to a live 1:1 call: exactly web's `addPeople` (useCall.tsx).
   *
   * Peer-to-peer carries two people, so widening moves the call to the SFU room:
   *   1. GET a room token first (nobody is added into a room that cannot exist);
   *   2. POST /calls/:id/participants for each person (the server rings them
   *      with `call.ring` and announces `call.participant_added`);
   *   3. tell the peer over the data channel (`{t:'room'}`) so it moves too;
   *   4. detach this P2P session and join the room ourselves.
   * Never throws: the outcome names each person who could not be added, and
   * `movedToRoom` says whether this device left peer-to-peer.
   */
  async addPeople(people: readonly Invitee[], onProgress?: (p: AddProgress) => void): Promise<AddPeopleOutcome> {
    const fail = (message: string): AddPeopleOutcome => ({
      added: [],
      failed: people.map((p) => ({ ...p, message })),
      movedToRoom: false,
    });
    const record = this.record;
    const s = this.session;
    const callId = this.snap.callId;
    if (people.length === 0) return { added: [], failed: [], movedToRoom: false };
    if (!record || !s || this.snap.phase !== 'connected') {
      return fail(record ? 'The call is not connected yet' : "This call can't have people added yet");
    }
    try {
      await this.d.api.callToken(record);
    } catch {
      return fail('Group calls are not available right now');
    }
    const { added, failed } = await addPeopleSequentially(people, (id) => this.d.api.addCallParticipant(record, id), onProgress);
    if (added.length === 0) return { added, failed, movedToRoom: false };

    // The call may have ended (or moved) while we were talking to the server.
    if (this.session !== s || this.snap.callId !== callId) return { added, failed, movedToRoom: false };
    const media = this.snap.media ?? 'audio';
    s.send({ t: 'room', callId: record });
    // Let the hand-over message leave before the connection carrying it closes.
    await new Promise((r) => setTimeout(r, this.d.handoverMs ?? 250));
    if (this.session !== s) return { added, failed, movedToRoom: false };
    this.detachForRoom();
    this.d.onEnterRoom?.(record, media);
    this.d.onRecordChanged?.();
    return { added, failed, movedToRoom: true };
  }

  /** Cancel while ringing, hang up once answered, or dismiss a dead screen. */
  hangup(): void {
    const { callId, peerId, phase, media } = this.snap;
    if (phase === 'incoming') return this.decline();
    if (phase === 'ended' || phase === 'rejected' || phase === 'failed') {
      this.clearTimers();
      this.replace({ ...IDLE });
      return;
    }
    if (callId && peerId) {
      if (phase === 'outgoing') {
        this.d.rtc.sendFrame({ type: 'call.cancel', toUserId: peerId, callId });
        this.recordMissed(peerId, media ?? 'audio');
      } else {
        this.d.rtc.sendFrame({ type: 'call.end', toUserId: peerId, callId });
      }
    }
    this.finish('idle');
  }

  /** After FAILED: ring the same person again as a fresh call. */
  async retry(): Promise<void> {
    const { peerId, peerName, media, phase } = this.snap;
    if (phase !== 'failed' || !peerId) return;
    await this.invite(peerId, peerName ?? 'Contact', media ?? 'audio');
  }

  toggleMic(): void {
    const on = this.session?.toggleMic();
    if (on !== undefined) this.set({ micOn: on });
  }

  private camBusy = false;

  async toggleCam(): Promise<void> {
    // One camera start at a time: a double tap must not open the camera twice.
    if (!this.session || this.camBusy) return;
    this.camBusy = true;
    const session = this.session;
    const turningOn = !this.snap.camOn;
    try {
      if (turningOn && this.d.ensureCamera && !(await this.d.ensureCamera())) return;
      const on = await session.setCam(turningOn);
      if (this.session !== session) return;
      this.set({ camOn: on, camMirror: session.frontFacing ?? true, localStream: session.localStream });
      if (turningOn && !on) this.d.cameraFailed?.();
    } catch {
      if (this.session !== session) return;
      this.set({ camOn: false, localStream: session.localStream });
      if (turningOn) this.d.cameraFailed?.();
    } finally {
      this.camBusy = false;
    }
  }

  async switchCamera(): Promise<void> {
    const session = this.session;
    if (!session || !this.snap.camOn || this.camBusy) return;
    this.camBusy = true;
    try {
      await session.switchCamera();
    } catch {
      /* no other camera / busy: the current one was put back */
    } finally {
      this.camBusy = false;
      if (this.session === session) this.set({ camMirror: session.frontFacing ?? true, camEpoch: session.camEpoch ?? 0, localStream: session.localStream });
    }
  }

  toggleSpeaker(): void {
    this.setSpeaker(!this.snap.speakerOn);
  }

  /** `force` re-applies the route even when the snapshot already says so (a
   *  fresh audio session starts on the earpiece whatever the last call chose). */
  setSpeaker(on: boolean, force = false): void {
    if (this.snap.speakerOn === on && !force) return;
    this.d.applySpeaker?.(on);
    this.set({ speakerOn: on });
  }

  // ── inbound frames ───────────────────────────────────────────────────────
  private async onFrame(f: ControlFrame): Promise<void> {
    const cur = this.snap;
    switch (f.type) {
      case 'call.invite': {
        // The same ring delivered twice must not be answered as a second caller.
        if (this.incoming?.callId === f.callId && cur.phase === 'incoming') return;
        if (this.session || !isFree(cur.phase) || this.d.isBusy?.()) {
          // Busy: auto-decline the second caller, like web.
          this.d.rtc.sendFrame({ type: 'call.decline', toUserId: f.fromUserId, callId: f.callId });
          return;
        }
        if (this.lingerTimer) clearTimeout(this.lingerTimer);
        const name = this.d.cachedName?.(f.fromUserId) ?? f.fromName ?? 'Someone';
        this.incoming = { callId: f.callId, peerId: f.fromUserId, media: f.media };
        this.log('call.incoming', { callId: f.callId, media: f.media });
        this.replace({
          ...IDLE,
          phase: 'incoming',
          callId: f.callId,
          peerId: f.fromUserId,
          peerName: name,
          media: f.media,
          camOn: f.media === 'video',
        });
        this.d.onIncoming?.({ callId: f.callId, name, media: f.media });
        this.clearRing();
        this.ringTimer = setTimeout(() => {
          const c = this.incoming;
          if (!c || c.callId !== f.callId) return;
          this.d.onMissed?.(this.snap.peerName ?? 'Someone', c.media);
          this.d.onIncomingDone?.(c.callId, 'timeout');
          this.incoming = null;
          this.finish('idle');
        }, this.d.ringMs ?? 30_000);
        void this.d.resolveName?.(f.fromUserId).then((n) => {
          if (n && this.snap.callId === f.callId) this.set({ peerName: n });
        });
        return;
      }
      case 'call.accept': {
        if (cur.phase !== 'outgoing' || f.callId !== cur.callId) return;
        this.clearRing();
        this.set({ phase: 'connecting' });
        this.armConnectTimeout();
        const cfg = await this.iceConfig();
        if (this.snap.callId !== f.callId) return;
        const s = this.newSession(f.callId, f.fromUserId, cur.media ?? 'audio', cfg);
        try {
          await s.startCaller();
        } catch {
          if (this.snap.callId === f.callId) this.finish('failed', 'Camera or microphone is unavailable');
          return;
        }
        if (this.snap.callId !== f.callId || this.session !== s) return;
        this.set({ localStream: s.localStream });
        return;
      }
      case 'call.decline':
        if (f.callId === cur.callId) this.finish('rejected', 'Call declined');
        return;
      case 'call.cancel': {
        const c = this.incoming;
        if (c && f.callId === c.callId) {
          // Caller hung up before we answered: a missed call on this side.
          this.d.onMissed?.(cur.peerName ?? 'Someone', c.media);
          this.d.onIncomingDone?.(c.callId, 'cancelled');
          this.incoming = null;
          this.finish('idle');
        }
        return;
      }
      case 'call.end':
        if (f.callId === cur.callId) this.finish('ended', 'Call ended');
        return;
      case 'rtc.offer':
        if (this.session && f.offerId === cur.callId) await this.session.onOffer(f.sdp);
        return;
      case 'rtc.answer':
        if (this.session && f.offerId === cur.callId) await this.session.onAnswer(f.sdp);
        return;
      case 'rtc.ice':
        if (this.session && f.offerId === cur.callId) await this.session.onIce(f.candidate);
        return;
      case 'rtc.peer.unreachable':
        if (f.offerId === cur.callId) this.finish('ended', 'User unavailable');
        return;
      default:
        return;
    }
  }
}
