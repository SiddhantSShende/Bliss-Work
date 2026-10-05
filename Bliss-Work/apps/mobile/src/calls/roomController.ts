import type { CallDTO, CallJoinDTO } from '@taskboard/shared';
import type { CallMedia } from './callController';
import { addPeopleSequentially, type AddPeopleOutcome, type AddProgress, type Invitee } from './addPeople';

/**
 * Mobile's room-call state machine: meetings, channel calls, and a 1:1 call
 * that was widened into a group.
 *
 * Same server protocol as web's useCallRoom (packages/app):
 *   POST /calls/:id/token  -> JOINED {url, token}  |  WAITING {canStart}
 *   a WAITING caller re-asks when `call.started` arrives (plus a slow poll)
 *   leave -> POST /calls/:id/leave, host end -> POST /calls/:id/end
 * Media rides the LiveKit SFU. The LiveKit `Room` itself is behind
 * `RoomLike`, so this file has no native imports and is unit-tested.
 *
 * An invite (someone started/added us) is `ringing`; nothing is joined until
 * the user accepts. Declining just dismisses it — the roster is untouched.
 */

export type RoomPhase =
  | 'idle'
  | 'ringing'
  | 'joining'
  | 'waiting'
  | 'connected'
  | 'reconnecting'
  | 'ended'
  | 'failed';

export interface RoomParticipantView {
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micOn: boolean;
  camOn: boolean;
  /** Local preview only: false while the BACK camera is live (a rear view is not mirrored). */
  mirror?: boolean;
  /** Opaque handle the UI hands to LiveKit's <VideoTrack/>. */
  videoRef?: unknown;
  /** They are publishing a screen; `screenRef` is its track handle. A shared
   *  screen is what everyone is in the meeting to look at, so the UI stages it. */
  sharing?: boolean;
  screenRef?: unknown;
  /** This participant has raised their hand. Driven by LiveKit participant attributes. */
  handRaised?: boolean;
}

export interface RoomSnapshot {
  phase: RoomPhase;
  callId?: string;
  title?: string;
  /** Who is ringing us, for an invite. */
  inviter?: string;
  /** The inviter's user id, when the event carried one (lets the ring screen show their photo). */
  inviterId?: string;
  media: CallMedia;
  micOn: boolean;
  camOn: boolean;
  speakerOn: boolean;
  /** In the waiting room: whether we may start the call ourselves. */
  canStart: boolean;
  isHost: boolean;
  participants: RoomParticipantView[];
  connectedAt?: number;
  reason?: string;
  /** THIS device is sharing its screen. */
  sharing: boolean;
  /** This platform + room can share a screen (Android MediaProjection; not iOS). */
  canShareScreen: boolean;
  /** THIS device has raised its hand. */
  handRaised: boolean;
}

export interface RoomLike {
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  setMic(on: boolean): Promise<unknown>;
  setCam(on: boolean): Promise<unknown>;
  switchCamera(): Promise<unknown> | void;
  participants(): RoomParticipantView[];
  /** Any participant/track/speaker change. */
  onChange(cb: () => void): () => void;
  onReconnecting(cb: () => void): () => void;
  onReconnected(cb: () => void): () => void;
  /** The SFU connection is gone for good (kicked, room closed, token refused). */
  onDisconnected(cb: (reason?: string) => void): () => void;
  // ── optional capabilities (absent on a room that cannot do them) ─────────
  /** Publish raw bytes to the room (chat, notes); `to` = destination identities. */
  sendData?(bytes: Uint8Array, to?: string[]): Promise<unknown> | void;
  /** Bytes another participant published. */
  onData?(cb: (bytes: Uint8Array, from: string) => void): () => void;
  /** Start/stop publishing this device's screen. Rejects if the user refuses. */
  setScreenShare?(on: boolean): Promise<unknown>;
  /** The screen share stopped without us asking (system "stop sharing"). */
  onScreenShareEnded?(cb: () => void): () => void;
  /** Set the local participant's raised-hand state via LiveKit participant attributes. */
  setHandRaised?(raised: boolean): Promise<unknown> | void;
}

export interface RoomApiLike {
  callToken(callId: string): Promise<CallJoinDTO>;
  startCall(callId: string): Promise<CallDTO>;
  leaveCall(callId: string): Promise<unknown>;
  endCall(callId: string): Promise<unknown>;
  /** POST /calls/:id/participants — the server rings the newcomer and refreshes the roster. */
  addCallParticipant(callId: string, userId: string): Promise<unknown>;
  /** Tell the room's record who is sharing (the picture itself rides the SFU). */
  startScreenShare?(callId: string, source: 'SCREEN' | 'WINDOW' | 'TAB' | 'monitor' | 'window' | 'browser'): Promise<unknown>;
  stopScreenShare?(callId: string): Promise<unknown>;
}

export interface RoomDeps {
  api: RoomApiLike;
  createRoom: () => RoomLike;
  /** Subscribe to `call.started` / `call.ended` for a call id. */
  onCallEvent: (cb: (e: { type: 'started' | 'ended'; callId: string }) => void) => () => void;
  ensurePermissions: (media: CallMedia) => Promise<boolean>;
  /** Camera permission when turning the camera on mid-call. Resolve false when refused. */
  ensureCamera?: () => Promise<boolean>;
  /** The camera was permitted but would not start. */
  cameraFailed?: () => void;
  /** Screen sharing failed for a reason other than the user saying no. */
  screenShareFailed?: (reason: string) => void;
  /** `sharing` just flipped — the one hook a caller needs to lift/restore the
   *  app's screenshot/screen-record protection around a live screen share
   *  (FLAG_SECURE on this window would otherwise blank that capture too; see
   *  screenSecurity.ts's own doc). Kept as an injected callback, not a direct
   *  import, so this file stays free of native imports and unit-testable. */
  onScreenShareChanged?: (sharing: boolean) => void;
  applySpeaker?: (on: boolean) => void;
  onRinging?: (c: { callId: string; title: string; inviter?: string; inviterId?: string; media: CallMedia }) => void;
  onRingingDone?: (callId: string, why: 'joined' | 'declined' | 'timeout' | 'ended') => void;
  onRecordChanged?: () => void;
  log?: (event: string, data?: Record<string, string | number | boolean | undefined>) => void;
  ringMs?: number;
  lobbyPollMs?: number;
  accessCheckMs?: number;
  lingerMs?: number;
}

// Every optional field is listed (as undefined) so `replace` leaves nothing
// from the previous call behind.
const IDLE: RoomSnapshot = {
  phase: 'idle',
  callId: undefined,
  title: undefined,
  inviter: undefined,
  inviterId: undefined,
  connectedAt: undefined,
  reason: undefined,
  media: 'video',
  micOn: true,
  camOn: false,
  speakerOn: true,
  canStart: false,
  isHost: false,
  participants: [],
  sharing: false,
  canShareScreen: false,
  handRaised: false,
};

type Listener = () => void;

export class RoomController {
  private snap: RoomSnapshot = IDLE;
  private readonly listeners = new Set<Listener>();
  private room: RoomLike | null = null;
  private roomOffs: (() => void)[] = [];
  private lobbyOff: (() => void) | undefined;
  private endedOff: (() => void) | undefined;
  private ringTimer: ReturnType<typeof setTimeout> | undefined;
  private lobbyTimer: ReturnType<typeof setTimeout> | undefined;
  private accessTimer: ReturnType<typeof setInterval> | undefined;
  private lingerTimer: ReturnType<typeof setTimeout> | undefined;
  /** Invites already shown, so one call announced several times rings once. */
  private readonly seen = new Set<string>();
  /** Data-channel subscribers (meeting chat/notes). They outlive a single Room
   *  object: they are re-wired to whichever room is current. */
  private readonly dataSubs = new Set<(bytes: Uint8Array, from: string) => void>();
  /** Set while WE stop the share, so the room's "share ended" event for it is
   *  not treated as the system stopping it behind our back. */
  private stoppingShare = false;
  /** Bumped by every join/leave so a slow token request cannot resurrect a call
   *  the user already walked away from. */
  private attempt = 0;
  private left = false;
  private hands = new Set<string>();

  /** The room's participants with the raised-hand overlay applied. Hands travel as
   *  `{t:'hand'}` data messages (like web), so the adapter's own list never carries
   *  them: every snapshot of the participants MUST come through here, or a camera
   *  flip / share toggle silently drops everyone's raised hand from the UI. Hands of
   *  people no longer in the room are pruned (web does too), so a rejoin starts lowered. */
  private participantsOf(room: RoomLike, localRaised: boolean = this.snap.handRaised): RoomParticipantView[] {
    const list = room.participants();
    const ids = new Set(list.map((p) => p.identity));
    for (const id of this.hands) if (!ids.has(id)) this.hands.delete(id);
    return list.map((p) => ({ ...p, handRaised: this.hands.has(p.identity) || (p.isLocal && localRaised) }));
  }

  constructor(private readonly d: RoomDeps) { }

  getSnapshot = (): RoomSnapshot => this.snap;
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<RoomSnapshot>) {
    if (patch.sharing !== undefined && patch.sharing !== this.snap.sharing) this.d.onScreenShareChanged?.(patch.sharing);
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  private replace(next: RoomSnapshot) {
    // A call can reset straight to IDLE (ended, kicked, failed) while a screen
    // share was live — this must restore protection exactly like an explicit
    // stop does, not just the paths that go through set().
    if (next.sharing !== this.snap.sharing) this.d.onScreenShareChanged?.(next.sharing);
    this.snap = next;
    for (const l of this.listeners) l();
  }

  private log(event: string, data?: Record<string, string | number | boolean | undefined>) {
    this.d.log?.(event, data);
  }

  /** True while a room call occupies the screen (ringing does not count as busy
   *  for the purposes of a second, different invite — see announce). */
  get busy(): boolean {
    const p = this.snap.phase;
    return p !== 'idle' && p !== 'ringing';
  }

  // ── invites ──────────────────────────────────────────────────────────────
  announce(callId: string, title: string, media: CallMedia, inviter?: string, inviterId?: string): void {
    if (this.seen.has(callId) || this.snap.phase !== 'idle') return;
    this.seen.add(callId);
    this.log('room.invite', { callId });
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.replace({ ...IDLE, phase: 'ringing', callId, title, inviter, inviterId, media, camOn: media === 'video' });
    this.d.onRinging?.({ callId, title, inviter, inviterId, media });
    this.ringTimer = setTimeout(() => {
      if (this.snap.phase === 'ringing' && this.snap.callId === callId) {
        this.d.onRingingDone?.(callId, 'timeout');
        this.replace({ ...IDLE });
      }
    }, this.d.ringMs ?? 30_000);
  }

  /** The call this invite was for ended/was answered elsewhere: stop ringing. */
  dismissInvite(callId: string): void {
    if (this.snap.phase === 'ringing' && this.snap.callId === callId) {
      if (this.ringTimer) clearTimeout(this.ringTimer);
      this.d.onRingingDone?.(callId, 'ended');
      this.replace({ ...IDLE });
    }
  }

  decline(): void {
    if (this.snap.phase !== 'ringing' || !this.snap.callId) return;
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.d.onRingingDone?.(this.snap.callId, 'declined');
    this.replace({ ...IDLE });
  }

  // ── join / leave ─────────────────────────────────────────────────────────
  /** Enter a call: from accepting an invite, a Join button, or a link. */
  async join(callId: string, media: CallMedia = 'video', title?: string): Promise<void> {
    if (this.busy) return;
    if (this.ringTimer) clearTimeout(this.ringTimer);
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    if (this.snap.phase === 'ringing') this.d.onRingingDone?.(this.snap.callId ?? callId, 'joined');
    const attempt = ++this.attempt;
    this.left = false;
    this.seen.add(callId);
    this.replace({
      ...IDLE,
      phase: 'joining',
      callId,
      title: title ?? this.snap.title,
      media,
      camOn: media === 'video',
      speakerOn: media === 'video',
    });
    this.d.applySpeaker?.(media === 'video');
    if (!(await this.d.ensurePermissions(media))) {
      if (attempt === this.attempt) this.fail('Microphone or camera permission is needed for calls');
      return;
    }
    if (attempt !== this.attempt) return;
    await this.enter(callId, attempt);
  }

  /** The waiting-room host pressing Start and the server's `call.started` event
   *  both call enter(); without this guard both passed the attempt check and each
   *  created a LiveKit room, leaving the first connected (mic/camera live) but
   *  unreferenced. */
  private entering = false;

  private async enter(callId: string, attempt: number): Promise<void> {
    if (this.entering) return;
    this.entering = true;
    try {
      await this.enterOnce(callId, attempt);
    } finally {
      this.entering = false;
    }
  }

  private async enterOnce(callId: string, attempt: number): Promise<void> {
    const t0 = Date.now();
    let grant: CallJoinDTO;
    try {
      grant = await this.d.api.callToken(callId);
    } catch {
      if (attempt === this.attempt) this.fail('Call connection failed');
      return;
    }
    if (attempt !== this.attempt) {
      // leave() ran while the request was in flight: report the departure for a
      // grant we are not going to use, and do not settle into the room.
      void this.d.api.leaveCall(callId).catch(() => { });
      return;
    }

    if (grant.state === 'WAITING') {
      this.set({ phase: 'waiting', canStart: grant.canStart });
      this.stopLobby();
      // The host opening the call is what normally ends the wait; the slow
      // poll only covers a websocket that is down.
      this.lobbyOff = this.d.onCallEvent((e) => {
        if (e.type === 'started' && e.callId === callId && attempt === this.attempt) void this.enter(callId, attempt);
      });
      this.lobbyTimer = setTimeout(() => {
        if (attempt === this.attempt) void this.enter(callId, attempt);
      }, this.d.lobbyPollMs ?? 30_000);
      return;
    }

    this.stopLobby();
    const room = this.d.createRoom();
    this.room = room;
    const refresh = () => {
      if (this.room === room) {
        this.set({ participants: this.participantsOf(room) });
      }
    };
    this.roomOffs = [
      room.onChange(refresh),
      room.onReconnecting(() => {
        if (this.room === room && this.snap.phase === 'connected') this.set({ phase: 'reconnecting' });
      }),
      room.onReconnected(() => {
        if (this.room === room && this.snap.phase === 'reconnecting') this.set({ phase: 'connected' });
      }),
      ...(room.onData
        ? [
          room.onData((bytes, from) => {
            if (this.room !== room) return;
            try {
              const msg = JSON.parse(new TextDecoder().decode(bytes));
              if (msg && msg.t === 'hand' && typeof msg.raised === 'boolean') {
                if (msg.raised) this.hands.add(from);
                else this.hands.delete(from);
                refresh();
              } else if (msg && msg.t === 'notes-request') {
                if (this.snap.handRaised) {
                  const outBytes = new TextEncoder().encode(JSON.stringify({ t: 'hand', raised: true }));
                  if (room.sendData) void Promise.resolve(room.sendData(outBytes, [from])).catch(() => {});
                }
              }
            } catch {
              // ignore parse errors
            }
            for (const sub of this.dataSubs) sub(bytes, from);
          }),
        ]
        : []),
      ...(room.onScreenShareEnded
        ? [
          room.onScreenShareEnded(() => {
            if (this.room !== room || !this.snap.sharing || this.stoppingShare) return;
            this.set({ sharing: false, participants: this.participantsOf(room) });
            const id = this.snap.callId;
            if (id) void this.d.api.stopScreenShare?.(id).catch(() => { });
          }),
        ]
        : []),
      room.onDisconnected((reason) => {
        if (this.room !== room || this.left) return;
        // The SFU dropped us. A deleted room is the call ending; anything else
        // (network gone for good, kicked) is a failure worth showing.
        if (reason === 'Call ended') this.finishRoom('ended', reason, false);
        else this.finishRoom('failed', reason ?? 'Call connection failed');
      }),
    ];
    try {
      await room.connect(grant.url, grant.token);
      if (attempt !== this.attempt) {
        await room.disconnect().catch(() => { });
        return;
      }
      await room.setMic(true);
      await room.setCam(this.snap.media === 'video').catch(() => {
        this.set({ camOn: false });
        this.d.cameraFailed?.();
      });
    } catch {
      if (attempt === this.attempt) this.finishRoom('failed', 'Call connection failed');
      return;
    }
    if (attempt !== this.attempt) return;
    this.log('room.connected', { callId, setupMs: Date.now() - t0 });
    this.set({
      phase: 'connected',
      isHost: grant.role === 'HOST',
      micOn: true,
      camOn: this.snap.media === 'video' && this.snap.camOn,
      participants: this.participantsOf(room),
      connectedAt: this.snap.connectedAt ?? Date.now(),
      reason: undefined,
      canShareScreen: typeof room.setScreenShare === 'function',
    });
    this.d.onRecordChanged?.();
    this.watchEnd(callId);
    this.armAccessCheck(callId, attempt);
  }

  /** Waiting room, host only: open the call for everyone. */
  async startNow(): Promise<void> {
    const { callId, phase, canStart } = this.snap;
    if (!callId || phase !== 'waiting' || !canStart) return;
    try {
      await this.d.api.startCall(callId);
    } catch {
      /* the server is the authority; the lobby keeps waiting */
    }
    void this.enter(callId, this.attempt);
  }

  private watchEnd(callId: string) {
    this.endedOff?.();
    this.endedOff = this.d.onCallEvent((e) => {
      if (e.type === 'ended' && e.callId === callId) this.finishRoom('ended', 'Call ended', false);
    });
  }

  /** Access is re-decided by the server on every token request; asking again is
   *  how someone removed from a channel actually loses the room. */
  private armAccessCheck(callId: string, attempt: number) {
    if (this.accessTimer) clearInterval(this.accessTimer);
    this.accessTimer = setInterval(() => {
      if (attempt !== this.attempt) return;
      void this.d.api.callToken(callId).catch((e: { status?: number }) => {
        if (attempt === this.attempt && (e?.status === 403 || e?.status === 404)) {
          this.finishRoom('ended', 'You no longer have access to this call');
        }
      });
    }, this.d.accessCheckMs ?? 10 * 60_000);
  }

  private stopLobby() {
    this.lobbyOff?.();
    this.lobbyOff = undefined;
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
    this.lobbyTimer = undefined;
  }

  private teardownRoom() {
    for (const off of this.roomOffs) off();
    this.roomOffs = [];
    this.endedOff?.();
    this.endedOff = undefined;
    if (this.accessTimer) clearInterval(this.accessTimer);
    this.accessTimer = undefined;
    this.stopLobby();
    const room = this.room;
    this.room = null;
    this.hands.clear();
    void room?.disconnect().catch(() => { });
  }

  private fail(reason: string) {
    this.finishRoom('failed', reason);
  }

  private finishRoom(phase: 'ended' | 'failed' | 'idle', reason?: string, report = true) {
    const callId = this.snap.callId;
    this.attempt++;
    this.left = true;
    this.teardownRoom();
    if (report && callId) void this.d.api.leaveCall(callId).catch(() => { });
    this.d.onRecordChanged?.();
    this.log('room.finish', { phase, reason, callId });
    if (phase === 'idle') {
      this.replace({ ...IDLE });
      return;
    }
    this.replace({
      ...IDLE,
      phase,
      reason,
      callId,
      title: this.snap.title,
      media: this.snap.media,
    });
    if (phase === 'ended') {
      this.lingerTimer = setTimeout(() => {
        if (this.snap.phase === 'ended') this.replace({ ...IDLE });
      }, this.d.lingerMs ?? 2500);
    }
  }

  /** Leave (and, from a dead/failed screen, dismiss). */
  leave(): void {
    const { phase } = this.snap;
    if (phase === 'ringing') return this.decline();
    if (phase === 'ended' || phase === 'failed') {
      this.attempt++;
      this.replace({ ...IDLE });
      return;
    }
    if (phase === 'idle') return;
    this.finishRoom('idle');
  }

  /** Host only: end the call for everyone. */
  endForAll(): void {
    const { callId, isHost } = this.snap;
    if (!callId || !isHost) return this.leave();
    void this.d.api.endCall(callId).catch(() => { });
    this.finishRoom('idle', undefined, false);
  }

  retry(): void {
    const { callId, media, title, phase } = this.snap;
    if (phase !== 'failed' || !callId) return;
    this.replace({ ...IDLE });
    void this.join(callId, media, title);
  }

  /** Add member to a live room call (web useCallRoom `addPeople`): one request
   *  per person, sequentially. The server rings each newcomer (`call.ring`) and
   *  sends `call.participant_added` to everyone already here; the roster itself
   *  updates through LiveKit as they join. Never throws. */
  async addPeople(people: readonly Invitee[], onProgress?: (p: AddProgress) => void): Promise<AddPeopleOutcome> {
    const { callId, phase } = this.snap;
    if (people.length === 0) return { added: [], failed: [], movedToRoom: false };
    if (!callId || phase !== 'connected') {
      const message = 'The call is not connected yet';
      return { added: [], failed: people.map((p) => ({ ...p, message })), movedToRoom: false };
    }
    const r = await addPeopleSequentially(people, (id) => this.d.api.addCallParticipant(callId, id), onProgress);
    this.d.onRecordChanged?.();
    return { ...r, movedToRoom: false };
  }

  // ── controls ─────────────────────────────────────────────────────────────
  async toggleMic(): Promise<void> {
    const on = !this.snap.micOn;
    try {
      await this.room?.setMic(on);
      this.set({ micOn: on });
    } catch {
      /* refused: stays as it was */
    }
  }

  private camBusy = false;

  async toggleCam(): Promise<void> {
    // One camera start at a time: a double tap must not open the camera twice.
    if (this.camBusy || !this.room) return;
    this.camBusy = true;
    const room = this.room;
    const on = !this.snap.camOn;
    try {
      if (on && this.d.ensureCamera && !(await this.d.ensureCamera())) return;
      await room.setCam(on);
      if (this.room !== room) return;
      const participants = this.participantsOf(room);
      // The button follows the REAL track, not the tap.
      const local = participants.find((p) => p.isLocal);
      this.set({ camOn: local ? local.camOn : on, participants });
    } catch {
      if (this.room !== room) return;
      this.set({ camOn: false, participants: this.participantsOf(room) });
      if (on) this.d.cameraFailed?.();
    } finally {
      this.camBusy = false;
    }
  }

  async switchCamera(): Promise<void> {
    const room = this.room;
    if (!room || !this.snap.camOn || this.camBusy) return;
    this.camBusy = true;
    try {
      await room.switchCamera();
    } catch {
      /* no other camera / busy: the current one was put back */
    } finally {
      this.camBusy = false;
      if (this.room === room) this.set({ participants: this.participantsOf(room) });
    }
  }

  async toggleRaiseHand(): Promise<void> {
    const room = this.room;
    if (!room?.sendData) return;
    const next = !this.snap.handRaised;
    const me = this.snap.participants.find((p) => p.isLocal)?.identity;
    try {
      // Send data channel message instead of participant attributes
      const bytes = new TextEncoder().encode(JSON.stringify({ t: 'hand', raised: next }));
      await Promise.resolve(room.sendData(bytes));
      
      if (me) {
        if (next) this.hands.add(me);
        else this.hands.delete(me);
      }
      
      if (this.room === room) {
        this.set({ handRaised: next, participants: this.participantsOf(room, next) });
      }
    } catch {
      /* permission refused or connection lost: stay as-is */
    }
  }

  // ── data channel (meeting chat / notes) ──────────────────────────────────
  /** Publish bytes to the room. A no-op with no room yet: there is nobody to tell. */
  sendData(bytes: Uint8Array, to?: string[]): void {
    const r = this.room;
    if (!r?.sendData) return;
    try {
      void Promise.resolve(r.sendData(bytes, to)).catch(() => {
        /* a lost datagram is re-sent by the next sync request */
      });
    } catch {
      /* same */
    }
  }

  /** Subscribe to bytes from other participants; survives reconnects/rejoins. */
  onData(cb: (bytes: Uint8Array, from: string) => void): () => void {
    this.dataSubs.add(cb);
    return () => {
      this.dataSubs.delete(cb);
    };
  }

  // ── screen share ─────────────────────────────────────────────────────────
  /** Start or stop sharing THIS device's screen. Returns whether we are sharing
   *  afterwards. The OS asks for consent (Android MediaProjection); a refusal is
   *  not an error worth interrupting the meeting for — it just stays off. */
  async toggleScreenShare(): Promise<boolean> {
    const room = this.room;
    const callId = this.snap.callId;
    if (!room?.setScreenShare || !callId || this.snap.phase !== 'connected') return this.snap.sharing;
    if (this.snap.sharing) {
      this.stoppingShare = true;
      try {
        await room.setScreenShare(false);
      } catch {
        /* already stopped */
      } finally {
        this.stoppingShare = false;
      }
      if (this.room === room) this.set({ sharing: false, participants: this.participantsOf(room) });
      void this.d.api.stopScreenShare?.(callId).catch(() => { });
      return false;
    }
    try {
      await room.setScreenShare(true);
    } catch (e) {
      // The user declining the system dialog is a choice, not a failure; anything
      // else (no foreground service, capture error) must be visible, not silent.
      const reason = e instanceof Error ? e.message : String(e);
      this.log('screenshare.failed', { error: reason });
      if (!/denied|cancel|declin|NotAllowed|AbortError/i.test(reason)) this.d.screenShareFailed?.(reason);
      if (this.room === room) this.set({ sharing: false, participants: this.participantsOf(room) });
      return false;
    }
    if (this.room !== room) return false;
    // The button follows the REAL screen track, not the tap.
    const participants = this.participantsOf(room);
    const live = participants.find((p) => p.isLocal)?.sharing ?? true;
    this.set({ sharing: live, participants });
    if (!live) return false;
    // The picture is already on its way; this is the room's record of who is sharing.
    void this.d.api.startScreenShare?.(callId, 'monitor').catch(() => { });
    return true;
  }

  setSpeaker(on: boolean): void {
    if (this.snap.speakerOn === on) return;
    this.d.applySpeaker?.(on);
    this.set({ speakerOn: on });
  }

  toggleSpeaker(): void {
    this.setSpeaker(!this.snap.speakerOn);
  }

  dispose(): void {
    this.attempt++;
    this.left = true;
    if (this.ringTimer) clearTimeout(this.ringTimer);
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    const ringingId = this.snap.phase === 'ringing' ? this.snap.callId : undefined;
    this.teardownRoom();
    this.replace({ ...IDLE });
    // Same reason as CallController.dispose: an unanswered invite's ring must not outlive it.
    if (ringingId) this.d.onRingingDone?.(ringingId, 'ended');
  }
}
