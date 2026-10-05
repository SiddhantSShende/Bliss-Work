import { AppState, Platform, type NativeEventSubscription } from 'react-native';
import { DisconnectReason, Room, RoomEvent, Track, type LocalVideoTrack, type Participant } from 'livekit-client';
import { AUDIO_CAPTURE_DEFAULTS } from './mediaConstraints';
import type { RoomLike, RoomParticipantView } from './roomController';

/**
 * The LiveKit participant attribute key for raise-hand state.
 * '1' = raised, absent or '' = not raised.
 * Using a namespaced key avoids collision with other attributes.
 */
const HAND_ATTR = 'blissHand';

/** `livekit-client`'s Room behind the small `RoomLike` surface the controller
 *  is written (and tested) against. Requires `registerGlobals()` from
 *  @livekit/react-native to have run first (index.js does that). */
export class LiveKitRoomAdapter implements RoomLike {
  private readonly room = new Room({
    // Save CPU/bandwidth on a phone: drop resolution for small tiles and stop
    // forwarding layers nobody is looking at.
    adaptiveStream: true,
    dynacast: true,
    // Same capture defaults web uses for its room (echo/noise/gain).
    audioCaptureDefaults: { ...AUDIO_CAPTURE_DEFAULTS },
  });

  /** Which camera is live. Kept here because the native flip below does not tell
   *  LiveKit, and a camera turned off and on again must come back the same way. */
  private facing: 'user' | 'environment' = 'user';
  private appSub?: NativeEventSubscription;
  /**
   * Callback registered by onScreenShareEnded — called when we detect the
   * screen share track ended in the background (Android killed MediaProjection).
   * Stored so recoverScreenShare can fire it without re-subscribing.
   */
  private screenShareEndedCb?: () => void;

  async connect(url: string, token: string): Promise<void> {
    await this.room.connect(url, token);
    // Android takes the camera away while the screen is locked / the app is
    // stopped; the track then reads 'ended' and would stay a frozen frame.
    // The same check also detects a screen-share track killed by Android.
    this.appSub?.remove();
    this.appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        void this.recoverCamera();
        this.checkScreenShare();
      }
    });
  }

  async disconnect(): Promise<void> {
    this.appSub?.remove();
    this.appSub = undefined;
    this.screenShareEndedCb = undefined;
    await this.room.disconnect();
  }

  private async recoverCamera(): Promise<void> {
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!track || pub?.isMuted || track.mediaStreamTrack.readyState !== 'ended') return;
    await track.restartTrack({ facingMode: this.facing }).catch(() => {});
  }

  /**
   * Called when the app returns to foreground.
   *
   * Screen sharing on Android uses MediaProjection inside the
   * @livekit/react-native-webrtc foreground service. The OS may stop
   * MediaProjection when the display turns off or the screen is locked on
   * some devices/Android versions, causing the screen-share track's
   * readyState to become 'ended'. In that case we notify the controller so
   * it can update its sharing=false state; the user must tap Share again to
   * request a new MediaProjection permission.
   *
   * We do NOT try to silently restart MediaProjection here because Android
   * requires a fresh user gesture (system dialog) every time. Silently
   * calling setScreenShareEnabled(true) again would fail or show the dialog
   * unexpectedly.
   */
  private checkScreenShare(): void {
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (!pub || pub.isMuted) return;
    const track = pub.track as LocalVideoTrack | undefined;
    if (!track) return;
    // If the underlying MediaStreamTrack ended, Android has killed the capture.
    // Unpublish it cleanly so the controller and remote participants both know
    // the share has stopped, then fire the controller's screenShareEnded hook.
    if (track.mediaStreamTrack.readyState === 'ended') {
      void this.room.localParticipant.setScreenShareEnabled(false).catch(() => {});
      this.screenShareEndedCb?.();
    }
  }

  setMic(on: boolean): Promise<unknown> {
    return this.room.localParticipant.setMicrophoneEnabled(on);
  }

  setCam(on: boolean): Promise<unknown> {
    return this.room.localParticipant.setCameraEnabled(on, on ? { facingMode: this.facing } : undefined);
  }

  /** Front <-> back camera. The room stays connected: the capturer is restarted
   *  with the other facingMode and swapped onto the SAME published sender
   *  (replaceTrack — no republish, no renegotiation).
   *
   *  NOT `mediaStreamTrack._switchCamera()`: in @livekit/react-native-webrtc 144
   *  that is applyConstraints({facingMode}), and the native side refuses to
   *  change facing through applyConstraints ("a constraint violation"), so it
   *  silently keeps the current camera. */
  async switchCamera(): Promise<void> {
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!track || pub?.isMuted) return;
    const next = this.facing === 'user' ? 'environment' : 'user';
    try {
      await track.restartTrack({ facingMode: next });
      this.facing = next;
    } catch (e) {
      // No such camera (or it is busy): put the current one back rather than leave a dead track.
      await track.restartTrack({ facingMode: this.facing }).catch(() => {});
      throw e;
    }
  }

  // ── raise hand ─────────────────────────────────────────────────────────────
  // Uses LiveKit participant attributes — stored on the server, propagated to
  // all participants in real-time, and restored on reconnect.
  setHandRaised(raised: boolean): Promise<unknown> {
    return this.room.localParticipant.setAttributes({ [HAND_ATTR]: raised ? '1' : '' });
  }

  /** Track handles handed to <VideoTrack/>, cached per track so their identity
   *  is stable across the many `participants()` calls a room makes — otherwise
   *  every speaker/mute event would look like a new video to React. */
  private readonly refs = new Map<string, { participant: Participant; publication: unknown; source: Track.Source }>();

  private ref(p: Participant, pub: { trackSid: string } | undefined, source: Track.Source) {
    if (!pub) return undefined;
    const key = `${p.identity}:${pub.trackSid}`;
    let r = this.refs.get(key);
    if (!r || r.participant !== p) {
      r = { participant: p, publication: pub, source };
      this.refs.set(key, r);
    }
    return r;
  }

  participants(): RoomParticipantView[] {
    const view = (p: Participant, isLocal: boolean): RoomParticipantView => {
      const pub = p.getTrackPublication(Track.Source.Camera);
      const screen = p.getTrackPublication(Track.Source.ScreenShare);
      return {
        identity: p.identity,
        name: p.name || p.identity,
        isLocal,
        speaking: p.isSpeaking,
        micOn: p.isMicrophoneEnabled,
        camOn: p.isCameraEnabled,
        mirror: isLocal ? this.facing === 'user' : undefined,
        videoRef: pub?.track ? this.ref(p, pub, Track.Source.Camera) : undefined,
        sharing: !!screen && !screen.isMuted,
        screenRef: screen?.track ? this.ref(p, screen, Track.Source.ScreenShare) : undefined,
        // Read the HAND_ATTR attribute set by setHandRaised(); '1' = raised.
        handRaised: p.attributes?.[HAND_ATTR] === '1',
      };
    };
    return [view(this.room.localParticipant, true), ...[...this.room.remoteParticipants.values()].map((p) => view(p, false))];
  }

  onChange(cb: () => void): () => void {
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.ActiveSpeakersChanged,
      RoomEvent.ParticipantNameChanged,
      // Fires when any participant (local or remote) changes their attributes —
      // this is what drives real-time raise-hand updates to all participants.
      RoomEvent.ParticipantAttributesChanged,
    ] as const;
    for (const e of events) this.room.on(e, cb);
    return () => {
      for (const e of events) this.room.off(e, cb);
    };
  }

  onReconnecting(cb: () => void): () => void {
    this.room.on(RoomEvent.Reconnecting, cb);
    return () => this.room.off(RoomEvent.Reconnecting, cb);
  }

  onReconnected(cb: () => void): () => void {
    this.room.on(RoomEvent.Reconnected, cb);
    return () => this.room.off(RoomEvent.Reconnected, cb);
  }

  onDisconnected(cb: (reason?: string) => void): () => void {
    const handler = (reason?: DisconnectReason) => {
      // Our own leave() is not a failure.
      if (reason === DisconnectReason.CLIENT_INITIATED) return;
      cb(reason === DisconnectReason.ROOM_DELETED ? 'Call ended' : undefined);
    };
    this.room.on(RoomEvent.Disconnected, handler);
    return () => this.room.off(RoomEvent.Disconnected, handler);
  }

  // ── data channel ─────────────────────────────────────────────────────────
  sendData(bytes: Uint8Array, to?: string[]): Promise<unknown> {
    return this.room.localParticipant.publishData(bytes as Uint8Array<ArrayBuffer>, { reliable: true, destinationIdentities: to });
  }

  onData(cb: (bytes: Uint8Array, from: string) => void): () => void {
    const h = (payload: Uint8Array, from?: { identity: string }) => {
      if (from?.identity) cb(payload, from.identity);
    };
    this.room.on(RoomEvent.DataReceived, h);
    return () => this.room.off(RoomEvent.DataReceived, h);
  }

  // ── screen share ─────────────────────────────────────────────────────────
  // Android only: react-native-webrtc captures the screen with MediaProjection
  // (and runs its own foreground service for it). iOS needs a ReplayKit
  // broadcast extension, which this app does not have, so it is not offered.
  setScreenShare = Platform.OS === 'android'
    ? (on: boolean): Promise<unknown> => this.room.localParticipant.setScreenShareEnabled(on, { audio: false })
    : undefined;

  onScreenShareEnded(cb: () => void): () => void {
    // Store cb so checkScreenShare() can call it when it detects the track ended.
    this.screenShareEndedCb = cb;
    const h = (pub: { source: Track.Source }) => {
      if (pub.source === Track.Source.ScreenShare) {
        this.screenShareEndedCb?.();
      }
    };
    this.room.on(RoomEvent.LocalTrackUnpublished, h);
    return () => {
      this.room.off(RoomEvent.LocalTrackUnpublished, h);
      this.screenShareEndedCb = undefined;
    };
  }
}
