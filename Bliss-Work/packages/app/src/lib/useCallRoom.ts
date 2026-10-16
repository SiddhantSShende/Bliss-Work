import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioPresets,
  DisconnectReason,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  LogLevel as LiveKitLogLevel,
  setLogLevel as setLiveKitLogLevel,
  type LocalTrack,
  type RemoteParticipant,
} from "livekit-client";
import { toast } from "sonner";
import { addCallParticipants } from "./addCallParticipants";
import { useTranslation } from "react-i18next";
import { ApiError, EventType, isDevelopmentBuild, logger, type ServerEvent, type WsEventMeta } from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { decodeRoomMessage, encodeRoomMessage, type RoomMessage } from "./roomMessages";
import { AUDIO_CAPTURE_DEFAULTS } from "./mediaConstraints";
import { watchLivekitMic } from "./micDiagnostics";

setLiveKitLogLevel(isDevelopmentBuild ? LiveKitLogLevel.debug : LiveKitLogLevel.warn);

/**
 * A participant as the call UI needs to render them.
 *
 * Deliberately a flat, serialisable shape rather than LiveKit's Participant
 * objects: those mutate in place, so React never sees a change and tiles go
 * stale. Everything here is rebuilt on each room event.
 */
export interface RoomParticipant {
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micOn: boolean;
  camOn: boolean;
  /** They are publishing a screen. Rendered instead of their camera, because a
   *  shared screen is what everyone is in the call to look at. */
  sharing: boolean;
  /** Attach with `track.attach(el)`; null until they publish video. */
  videoTrack: Track | null;
  screenTrack: Track | null;
  audioTrack: Track | null;
}

export type RoomStatus =
  | "idle"
  | "connecting"
  /** In the waiting room: on the roster, but the call has not been started by
   *  anyone entitled to start it, so the server has issued no room token. */
  | "waiting"
  | "connected"
  | "reconnecting"
  /** A different active client owns this user's participant slot. */
  | "switch_required"
  | "failed";

/** How often to re-ask whether a call we are waiting for has started.
 *
 *  A backstop, not the main path: `call.started` arrives over the websocket the
 *  moment a host opens the call (see the subscription in `join` below), and that
 *  is what normally ends the wait. This only has to cover a socket that is down,
 *  so it is deliberately unhurried.
 *
 *  It used to be 5s, and the socket subscription this defers to did not exist —
 *  the event was emitted by the server and defined in the shared types, but
 *  nothing on the client listened for it, so polling was the only mechanism and
 *  had to be fast enough to serve as one. That made the lobby cost scale with
 *  the number of people in it: a five-hundred person all-hands waiting on a late
 *  host was a hundred access decisions a second, every second, on the primary. */
const LOBBY_POLL_MS = 30_000;

/** Whether `e` is exactly a media-capture prompt's "the OS/browser refused
 *  this" rejection — as opposed to "no such device" (NotFoundError),
 *  "already in use" (NotReadableError), or anything else. Shared by every
 *  getUserMedia/getDisplayMedia call site below (mic, camera, screen share)
 *  since they all throw the same DOMException shape on denial. */
export function isGetUserMediaDenied(e: unknown): boolean {
  return e instanceof DOMException && e.name === "NotAllowedError";
}

/**
 * Whether `track` is one `sync()` should still treat as live.
 *
 * A remote unpublish (RemoteParticipant.unpublishTrack in livekit-client)
 * calls `track.stop()` — which sets the underlying MediaStreamTrack's
 * `readyState` to "ended" synchronously — and only THEN clears the
 * publication's own `.track` and emits TrackUnsubscribed, a tick before the
 * publication is removed from the room altogether and TrackUnpublished
 * fires. A resync that runs inside that window (which TrackUnsubscribed
 * itself triggers) would otherwise see a publication that still exists, is
 * not marked muted, and still points at this same stale, already-stopped
 * track — exactly the shape of a genuinely live one. Reading the
 * MediaStreamTrack's own `readyState` instead of trusting the SDK's
 * bookkeeping to have caught up with itself is what tells the two apart
 * regardless of which event this resync is reacting to.
 */
function isLive(track: Track | undefined): track is Track {
  return !!track && track.mediaStreamTrack.readyState !== "ended";
}

/**
 * Joins the SFU room backing a call.
 *
 * ── Why an SFU and not the existing peer connection ──────────────────────────
 * `callManager.ts` holds ONE RTCPeerConnection, which is all a 1:1 call needs.
 * Group calls cannot extend that: peer-to-peer with N people is a full mesh, so
 * every client encodes and uploads N-1 copies of its own camera. The limit is
 * the participant's uplink, not the server, which is why mesh calls fall apart
 * around five people. Here each client publishes once.
 *
 * ── Token lifetime is a feature ──────────────────────────────────────────────
 * Room tokens last ~15 minutes and this hook re-mints before expiry. That is
 * not a nuisance to work around: each refresh re-checks access against the
 * database, so someone removed from a channel actually loses the room instead
 * of holding it until they hang up. If a refresh is refused, we disconnect —
 * quietly staying in a room you are no longer entitled to would be the bug.
 *
 * ── The refresh itself is a real, brief reconnect ────────────────────────────
 * LiveKit 2.21 (the version pinned here — checked directly against
 * node_modules/livekit-client before writing this) has no public API to hand
 * a live connection a replacement token. `prepareConnection()` only pre-warms
 * DNS/TLS ahead of `Room.connect()` — it no-ops once the room is already
 * connected — and `connect()` itself no-ops once state is already Connected.
 * The one token-swap-without-reconnect mechanism that exists at the protocol
 * level, a server-pushed `refreshToken` signal message
 * (`RTCEngine`'s private `onTokenRefresh`), is receive-only: nothing in the
 * SDK's public surface lets a CLIENT request one, and this self-hosted
 * `livekit-server` deployment (no `livekit-server-sdk` dependency anywhere in
 * messaging-svc) was confirmed live, against a throwaway instance of the same
 * pinned image, to never send it — a token is validated once, at the initial
 * join handshake, and never re-checked for the life of that connection. So
 * scheduleRefresh below disconnects and reconnects the SAME Room with the new
 * token (LiveKit resets `engine` to undefined on disconnect and rebuilds it
 * on the next connect(), which is what makes reusing one Room instance across
 * that gap the supported pattern — it also means every event listener
 * registered in `join` stays attached, so this is the one disconnect in this
 * hook that must NOT run the normal Disconnected handler's "the call is
 * over" cleanup; see `refreshingRef`).
 *
 * ── Camera/mic/screen survive the gap, not just resume after it ─────────────
 * `room.disconnect(false)` — a documented, public parameter (Room.d.ts:
 * `disconnect: (stopTracks?: boolean) => Promise<void>`) — tells LiveKit NOT
 * to call `.stop()` on the local tracks it is about to unpublish (confirmed
 * by reading `handleDisconnect`: with `stopTracks=false` it calls
 * `track.stopMonitor()` instead of `track.detach()`+`track.stop()`). The
 * actual camera/mic/screen `MediaStreamTrack`s keep capturing, uninterrupted,
 * through the gap — this hook holds onto the `LocalTrack` objects themselves
 * (not just on/off booleans) across the reconnect and republishes those SAME
 * objects via `LocalParticipant.publishTrack()` afterward. Measured live
 * (fake devices, real getUserMedia/getDisplayMedia call counting): this
 * republish triggers ZERO new device-capture calls, where the previous
 * `setMicrophoneEnabled(true)`/`setCameraEnabled(true)` approach triggered
 * two. Screen share specifically could never be resumed the old way —
 * `getDisplayMedia()` requires a fresh user gesture in every major browser —
 * so it was unconditionally reported as lost; now the SAME capture is simply
 * republished, with no gesture needed, because it was never stopped.
 */
export function useCallRoom(callId: string | null, adhoc = false) {
  // Named `tr`, not `t`: this hook already uses `t` throughout for the
  // call-token response (see scheduleRefresh/join below).
  const { t: tr } = useTranslation("callRoom");
  const { api, ws, config } = useRuntime();
  // Subscribe to live ServerEvents the same way WsEventBridge does (see
  // queryBridge.tsx): through config.eventSource on Electron, where the
  // socket lives in the utilityProcess and this `ws` is never connected —
  // nothing else ever calls ws.connect() there — and through `ws` directly
  // on web. Calling `ws.on(...)` unconditionally, as both subscriptions below
  // used to, left them permanently dead on desktop: the CallStarted lobby
  // listener and the CallEnded listener never fired, so a call ending under a
  // desktop participant never disconnected their room or closed the window.
  const subscribeToEvents = useCallback(
    (cb: (e: ServerEvent, meta?: WsEventMeta) => void) =>
      config.eventSource ? config.eventSource.subscribe(cb) : ws.on(cb),
    [config.eventSource, ws],
  );
  const [status, setStatus] = useState<RoomStatus>("idle");
  const [participants, setParticipants] = useState<RoomParticipant[]>([]);
  // Neither is published on join — see the connect step in `join` below.
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  /** A share start/stop request is in flight — the button must be disabled
   *  for this whole window, not just for the instantaneous `sharing` flip,
   *  or a second click before the first request resolves can fire
   *  `setScreenShareEnabled` twice or race a start against a stop. */
  const [sharingPending, setSharingPending] = useState(false);
  /** When this participant's own media connected, for the in-call timer. */
  const [connectedAt, setConnectedAt] = useState<number | undefined>(undefined);
  /** Whether THIS user could start the call they are waiting for. Answered by
   *  the server, because it turns on org and channel roles the client cannot
   *  see. Only meaningful while status is "waiting". */
  const [canStart, setCanStart] = useState(false);
  /** The call is over — the host ended it or walked out. Latches, and the screen
   *  showing this room is expected to close itself on it. */
  const [ended, setEnded] = useState(false);
  /** Which stage a "failed" status came from — the token request, the room
   *  connect that follows it, or a mid-call disconnect that LiveKit's own
   *  reconnection gave up recovering — so the UI can tell a credentials
   *  problem from a connectivity one from a connection that was lost
   *  outright, instead of one generic message for all three. Meaningful only
   *  while status is "failed". Reset at the start of every join attempt; a
   *  disconnect sets it directly instead, since that path never goes through
   *  join(). */
  const [failStage, setFailStage] = useState<"token" | "connect" | "disconnected" | "displaced" | "ended" | null>(null);
  const roomRef = useRef<Room | null>(null);
  /** Which call `roomRef.current` is connected — or connecting — to. Set
   *  alongside `roomRef.current`, cleared alongside it too.
   *
   *  CallRoom is deliberately never unmounted between calls (see
   *  MeetingSession's `enter`), so `callId` can change while a room from a
   *  PREVIOUS call is still sitting in `roomRef` — accepting a second
   *  meeting invite while minimised, or hitting Join on a different call's
   *  card, both do this without ever tearing this hook down. This is what
   *  lets join()'s reentry guard below tell that apart from a genuine
   *  re-entry into the SAME call. */
  const roomCallId = useRef<string | null>(null);
  /**
   * A join is in flight.
   *
   * `roomRef` cannot serve as this guard on its own: it is only assigned AFTER
   * the token request returns, and join() has three callers that can overlap
   * inside that window — the mount effect (twice under StrictMode), the lobby's
   * poll timer, and the `call.started` subscription firing at the same moment
   * the poll comes round. Two concurrent joins each construct a Room and each
   * publish a camera; the second assignment orphans the first, which stays
   * connected, on the roster and holding the device for the rest of the session.
   */
  const joining = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True while scheduleRefresh's own disconnect()+connect() cycle is in
   *  flight on the CURRENT room. The Disconnected handler registered in
   *  join() checks this to skip its normal "the call is over" cleanup for
   *  that one, deliberately transient disconnect — see the module doc above. */
  const refreshingRef = useRef(false);
  const lobbyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Unsubscribes the `call.started` listener that ends a lobby wait. */
  const lobbyOff = useRef<(() => void) | null>(null);
  /** The call we are in, and whether the server has already been told we left.
   *  Read by the unmount cleanup, which cannot close over changing values. */
  const leftRef = useRef(false);
  /** leave() was called while a join was still awaiting its token — status
   *  "connecting", but roomRef.current is not yet set (join() only assigns it
   *  once the token comes back JOINED, and stays "connecting" through the
   *  WAITING branch's decision too). There is no room yet for leave() to
   *  disconnect, so it just records the request here; join() checks it the
   *  moment the token resolves and, if set, reports the departure and stops
   *  instead of entering the waiting room or connecting to the SFU — without
   *  this a leave clicked mid-request was silently swallowed and the join
   *  completed normally, landing the user back in the call. Reset at the
   *  start of every join attempt. */
  const leaveRequestedWhileConnecting = useRef(false);
  /** The component is gone. A join() still awaiting its token must not build a
   *  Room afterwards: nothing would ever disconnect it, leaving this user on the
   *  roster and the room (and any device) held with no UI attached. */
  const unmountedRef = useRef(false);
  const callIdRef = useRef(callId);
  callIdRef.current = callId;
  const apiRef = useRef(api);
  apiRef.current = api;
  /**
   * Subscribers to what other participants say directly to this room.
   *
   * A ref rather than state: the set changes when a panel opens, and rebuilding
   * the room's event handlers for that would tear down the connection. The room
   * dispatches into whatever is registered at the moment a message lands.
   */
  const dataSubs = useRef(new Set<(m: RoomMessage, from: string) => void>());

  /** Stop waiting on a lobby, by either route. Both the timer and the socket
   *  subscription have to go together — leaving either behind re-joins a call
   *  the user has walked away from. */
  const stopWaiting = useCallback(() => {
    if (lobbyTimer.current) {
      clearTimeout(lobbyTimer.current);
      lobbyTimer.current = null;
    }
    if (lobbyOff.current) {
      lobbyOff.current();
      lobbyOff.current = null;
    }
  }, []);
  // Lets the lobby poll re-enter the latest join() without join having to
  // reference itself in its own dependency list.
  const joinRef = useRef<(() => Promise<void>) | null>(null);

  /** Rebuild the flat participant list from whatever the room currently holds. */
  const sync = useCallback((room: Room) => {
    const rows: RoomParticipant[] = [];
    const add = (p: RemoteParticipant | Room["localParticipant"], isLocal: boolean) => {
      const cam = p.getTrackPublication(Track.Source.Camera);
      const mic = p.getTrackPublication(Track.Source.Microphone);
      const screen = p.getTrackPublication(Track.Source.ScreenShare);
      // A live track, not merely a publication that hasn't been torn down
      // yet — see isLive's own doc comment for the race this closes. Only
      // the share needs this: a stale, stuck-on presentation is the actual
      // bug; a stale camera/mic publication is not something a participant
      // list is currently getting wrong.
      const screenTrack = isLive(screen?.track) ? screen.track : undefined;
      rows.push({
        identity: p.identity,
        name: p.name || p.identity,
        isLocal,
        speaking: p.isSpeaking,
        // A publication that is muted or unsubscribed is "off" as far as the
        // UI is concerned — the distinction only matters to the transport.
        micOn: !!mic && !mic.isMuted,
        camOn: !!cam && !cam.isMuted,
        sharing: !!screenTrack && !screen?.isMuted,
        videoTrack: cam?.track ?? null,
        screenTrack: screenTrack ?? null,
        audioTrack: mic?.track ?? null,
      });
    };
    add(room.localParticipant, true);
    room.remoteParticipants.forEach((p) => add(p, false));
    setParticipants(rows);
  }, []);

  /** Release whatever devices `heldTracks` still holds open. Only ever needed
   *  on a refresh that did not end in a successful republish: `disconnect
   *  (false)` deliberately left these live (see the module doc), so giving up
   *  on the reconnect — for any reason — must stop them itself, or the
   *  camera/mic/screen stay silently captured with nothing publishing them. */
  function stopHeldTracks(tracks: (LocalTrack | undefined)[]): void {
    for (const track of tracks) track?.stop();
  }

  /** Re-mint the room token before the current one lapses, and hand it to
   *  LiveKit via a real reconnect — see the module doc above for why, and for
   *  why the local tracks are held across it instead of stopped. */
  const scheduleRefresh = useCallback(
    (room: Room, id: string, expiresAt: string) => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      const msLeft = new Date(expiresAt).getTime() - Date.now();
      // Refresh at 80% of the remaining life, with a floor so a clock skew
      // cannot turn this into a tight loop against the API.
      const delay = Math.max(30_000, msLeft * 0.8);
      refreshTimer.current = setTimeout(() => {
        // A stale timer from a room this hook has already left or switched
        // away from must not act on whatever room/call is now current.
        if (roomRef.current !== room || roomCallId.current !== id) return;
        void (async () => {
          let t;
          try {
            t = await apiRef.current.callToken(id, "REFRESH");
          } catch {
            // Access was withdrawn (removed from the channel, call ended, or
            // the meeting link revoked). Leaving is the correct response.
            toast.error(tr("errors.accessRevoked"));
            void room.disconnect();
            return;
          }
          if (roomRef.current !== room || roomCallId.current !== id) return;
          // A live call cannot go back to being unstarted, so WAITING here
          // means the room we are in is no longer one we hold a grant for.
          // Treat it exactly like a refusal rather than assuming a token.
          if (t.state !== "JOINED") {
            void room.disconnect();
            return;
          }
          // Hold the actual LocalTrack objects, not just on/off booleans —
          // see the module doc's "survive the gap" section. Read BEFORE
          // disconnecting: once unpublished there is nothing left to ask.
          const micTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
          const camTrack = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
          const screenTrack = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
          const heldTracks = [micTrack, camTrack, screenTrack];
          setStatus("reconnecting");
          refreshingRef.current = true;
          try {
            // false: do not stop the local tracks on disconnect (see the
            // module doc) — they get explicitly republished below, or
            // explicitly stopped on whichever path gives up instead.
            await room.disconnect(false);
            // Left, or switched calls, while disconnecting — the reconnect
            // below is no longer wanted; leave the (now genuinely closed)
            // room alone and let whatever left/switched handle its own state.
            if (roomRef.current !== room || roomCallId.current !== id) {
              refreshingRef.current = false;
              stopHeldTracks(heldTracks);
              return;
            }
            await room.connect(t.url, t.token);
          } catch (e) {
            logger.error("[CALL ROOM] Refresh reconnect failed", e);
            refreshingRef.current = false;
            stopHeldTracks(heldTracks);
            void room.disconnect();
            return;
          }
          refreshingRef.current = false;
          if (roomRef.current !== room || roomCallId.current !== id) {
            // Left, or switched calls, while the reconnect itself was in
            // flight — this room is no longer this hook's to keep.
            stopHeldTracks(heldTracks);
            void room.disconnect();
            return;
          }
          setStatus("connected");
          // Republish each track that was actually held, independently: one
          // failing (a negotiation error, say) must not stop the others from
          // going back up, matching the old per-control try/catch this
          // replaces. Screen share gets the one behavior a failure here
          // genuinely needs to report — see below — because unlike mic/cam it
          // cannot be silently retried from a background refresh.
          for (const track of [micTrack, camTrack] as const) {
            if (!track) continue;
            try {
              await room.localParticipant.publishTrack(track);
            } catch (e) {
              logger.error("[CALL ROOM] Failed to republish a track after refresh", e);
            }
          }
          if (screenTrack) {
            try {
              await room.localParticipant.publishTrack(screenTrack);
            } catch (e) {
              logger.error("[CALL ROOM] Failed to republish the screen share after refresh", e);
              screenTrack.stop();
              setSharing(false);
              void apiRef.current.stopScreenShare(id).catch(() => {});
              toast(tr("notify.screenShareStopped"), {
                description: tr("notify.screenShareStoppedDescription"),
              });
            }
          }
          // Read back from the room rather than trust the booleans read
          // before disconnecting: this is exactly what isMicrophoneEnabled/
          // isCameraEnabled/isScreenShareEnabled themselves compute (published
          // AND not muted), so it can never drift from what LiveKit itself
          // would say immediately after.
          setMicOn(room.localParticipant.isMicrophoneEnabled);
          setCamOn(room.localParticipant.isCameraEnabled);
          setSharing(room.localParticipant.isScreenShareEnabled);
          sync(room);
          // See metrics.CallReconnectTotal's own doc: this reconnect is a
          // deliberate disconnect()+connect(), which LiveKit does not surface
          // as RoomEvent.Reconnected — relying on that event alone would
          // leave the single most frequent reconnect a long call sees
          // invisible on this counter.
          void apiRef.current.callTelemetryReconnected(id, "token_refresh").catch(() => {});
          scheduleRefresh(room, id, t.expiresAt);
        })();
      }, delay);
    },
    [sync, tr],
  );

  const join = useCallback(async (opts?: { switchHere?: boolean }) => {
    if (!callId || joining.current) return;
    const currentRoom = roomRef.current;
    // `currentRoom` can belong to a call we have since switched away from —
    // see `roomCallId`'s own comment for why. A plain `roomRef.current`
    // check here cannot tell that apart from a genuine re-entry into the
    // SAME call, and used to silently no-op the switch: the UI moved on to
    // the new call while the actual connection stayed on the old one, and a
    // later Leave posted the departure under the NEW call's id instead of
    // the old one's.
    const stale =
      currentRoom && roomCallId.current !== null && roomCallId.current !== callId
        ? { room: currentRoom, id: roomCallId.current }
        : null;
    if (currentRoom && !stale) return; // same call, already connected/connecting
    joining.current = true;
    if (stale) {
      // Leave it properly, under ITS OWN id, before joining the new one —
      // the same disconnect+report `leave()` itself does below, just for a
      // call this hook is no longer being asked to represent rather than
      // the one a person clicked Leave on.
      try {
        await stale.room.disconnect();
      } catch {
        // Going ahead regardless. This runs after `joining` was claimed but
        // before the try/finally below, so a throw here used to leave `joining`
        // stuck true and every later join() a silent no-op.
      }
      if (!leftRef.current) {
        leftRef.current = true;
        api.leaveCall(stale.id).catch(() => {});
      }
      // Fresh for the call about to be joined: this flag is per CONNECTION,
      // and the one it just recorded a departure for is over.
      leftRef.current = false;
    }
    setStatus("connecting");
    setFailStage(null);
    leaveRequestedWhileConnecting.current = false;
    let stage: "token" | "connect" = "token";
    // The setup-duration clock starts HERE, not at room.connect(): a slow
    // token request is as much "how long did joining take" as a slow SFU
    // handshake is, and the server cannot see either half itself — see
    // messaging-svc's metrics/calls.go for why this measurement lives here,
    // client-side, rather than being reconstructed from two timestamps on
    // two different service replicas.
    const attemptStartedAt = Date.now();
    try {
      logger.debug("[CALL ROOM] Requesting meeting token");
      const grant = await api.callToken(callId, opts?.switchHere ? "SWITCH" : "JOIN");
      logger.debug("[CALL ROOM] Token received");
      if (leaveRequestedWhileConnecting.current || unmountedRef.current) {
        // leave() ran while this request was in flight — there was no room
        // yet for it to disconnect (see the ref's own comment), so it just
        // recorded the request. (Unmounting is the same request, made by the
        // component going away; its cleanup had no room to disconnect either.)
        // Honor it now, before entering the waiting
        // room or connecting to the SFU either one: settling into either
        // would silently land the user back in the call they just tried to
        // leave. Same departure report leave()'s own waiting-room branch
        // sends, since from the server's point of view this is that same
        // case — a grant we are not going to act on.
        leaveRequestedWhileConnecting.current = false;
        setStatus("idle");
        if (!leftRef.current) {
          leftRef.current = true;
          api.leaveCall(callId).catch(() => {});
        }
        return;
      }
      // The call has not been started yet. There is no token to connect with —
      // that absence IS the waiting room, not a screen we chose to show — so
      // sit here and ask again until someone entitled to start it does.
      if (grant.state === "WAITING") {
        setCanStart(grant.canStart);
        setStatus("waiting");
        stopWaiting();
        lobbyTimer.current = setTimeout(() => void joinRef.current?.(), LOBBY_POLL_MS);
        // Listen for the host opening the call, which is how the wait normally
        // ends. The server fans `call.started` out to the WHOLE roster the
        // moment someone entitled to start it does, so this turns the lobby
        // from a polling loop into something that costs nothing while it waits.
        //
        // Subscribed here rather than once for the hook's lifetime because it
        // is only meaningful while we are actually in a lobby, and unsubscribing
        // the moment we leave one is what keeps a stale handler from re-joining
        // a call the user has walked away from.
        lobbyOff.current = subscribeToEvents((e) => {
          if (e.type !== EventType.CallStarted || e.callId !== callId) return;
          // Re-mint rather than trusting the event: it says the call is open,
          // not that this person may enter it, and the token endpoint is still
          // the only thing that decides that.
          void joinRef.current?.();
        });
        return;
      }
      // Past the lobby — nothing left to wait for, by either route.
      stopWaiting();
      const room = new Room({
        // Drop the resolution of tiles that are small or off-screen. At more
        // than a handful of participants this is the difference between a
        // usable call and a hot laptop.
        adaptiveStream: true,
        // Only forward layers someone is actually subscribed to.
        dynacast: true,

        // ── Capture ──────────────────────────────────────────────────────────
        // Everything below used to be left to the library's defaults, which is
        // why calls looked and sounded poor: the two options above are both
        // QUALITY-REDUCING (they exist to save CPU and bandwidth) and there was
        // nothing set on the other side of the trade telling them what floor to
        // stop at.
        videoCaptureDefaults: {
          // 720p is the point where a face in a grid tile stops looking soft.
          // Capturing higher only feeds a layer nobody subscribes to on a call
          // of more than two.
          resolution: VideoPresets.h720.resolution,
        },
        // Shared with the 1:1 call path (callManager.ts) — see mediaConstraints.ts.
        audioCaptureDefaults: AUDIO_CAPTURE_DEFAULTS,

        // ── Publish ──────────────────────────────────────────────────────────
        publishDefaults: {
          // Explicit rungs for adaptiveStream/dynacast to step DOWN to. Without
          // them the library picks its own, and a tile that shrinks can land on
          // a layer far below what the space it occupies could show.
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
          // Speech, not the telephone-grade default. This is the single biggest
          // change to how a meeting sounds.
          audioPreset: AudioPresets.speech,
          // Stop sending while nobody is talking (saves bandwidth for the
          // people who are), and carry redundant audio so a lost packet is
          // recovered rather than heard as a dropout — the artefact people
          // describe as the audio "breaking up".
          dtx: true,
          red: true,
        },
      });
      roomRef.current = room;
      roomCallId.current = callId;

      const resync = () => sync(room);
      room
        .on(RoomEvent.ParticipantConnected, resync)
        .on(RoomEvent.ParticipantDisconnected, resync)
        .on(RoomEvent.TrackSubscribed, (_t: RemoteTrack, _p: RemoteTrackPublication) => resync())
        .on(RoomEvent.TrackUnsubscribed, resync)
        // A remote unpublish (the sharer clicked Stop, or their track ended)
        // fires TrackUnsubscribed first and removes the publication — the
        // moment isLive() above can finally see it's gone — only afterward,
        // when THIS fires. Without listening here too, a resync that landed
        // during that in-between window (see isLive's doc comment) was the
        // last one anybody ran: the stage stayed on a screen share that had
        // already ended until some unrelated event happened to trigger
        // another sync.
        .on(RoomEvent.TrackUnpublished, resync)
        .on(RoomEvent.TrackMuted, resync)
        .on(RoomEvent.TrackUnmuted, resync)
        .on(RoomEvent.LocalTrackPublished, (pub) => {
          // Fires for the first publish AND for the re-acquire after a token
          // refresh (scheduleRefresh disconnects, reconnects, then republishes
          // the mic) — the moments worth checking the capture settings at.
          if (pub.source === Track.Source.Microphone && pub.audioTrack) watchLivekitMic(pub.audioTrack);
          resync();
        })
        .on(RoomEvent.LocalTrackUnpublished, (pub) => {
          // Chrome's own "Stop sharing" bar ends the track, and LiveKit
          // unpublishes it for us. Without this the app would go on claiming to
          // share a screen that stopped, and the server's record would say so
          // to everyone who joined afterwards.
          if (pub.source === Track.Source.ScreenShare) {
            setSharing(false);
            if (callId) void api.stopScreenShare(callId).catch(() => {});
          }
          resync();
        })
        .on(RoomEvent.ActiveSpeakersChanged, resync)
        // Raised hands, shared notes and the recording notice — see
        // lib/roomMessages for why they travel here rather than through the
        // server, and why every one of them is validated before it is believed.
        .on(RoomEvent.DataReceived, (payload: Uint8Array, from?: { identity: string }) => {
          const msg = decodeRoomMessage(payload);
          if (!msg || !from?.identity) return;
          for (const sub of dataSubs.current) sub(msg, from.identity);
        })
        .on(RoomEvent.Reconnecting, () => setStatus("reconnecting"))
        .on(RoomEvent.Reconnected, () => {
          setStatus("connected");
          resync();
          // Best-effort: a lost telemetry POST — or even a THROWING one, which
          // a plain .catch() would not protect against, since the exception
          // happens before there is a promise to attach it to — must never
          // affect the call itself, only the dashboard measuring it.
          if (callId) {
            try {
              void api.callTelemetryReconnected(callId, "media").catch(() => {});
            } catch {
              // reported nowhere on purpose — see above.
            }
          }
        })
        .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
          // scheduleRefresh disconnects and reconnects this SAME room
          // deliberately, mid-call, to hand LiveKit a fresh token — see the
          // module doc above. None of the "the call is over" cleanup below
          // applies to that transient disconnect; scheduleRefresh manages
          // this room's state itself while refreshingRef is set, and will
          // reconnect (or, on failure, disconnect for real and let this
          // handler run normally on that second, non-refresh disconnect).
          if (refreshingRef.current) return;
          setParticipants([]);
          setSharing(false);
          setConnectedAt(undefined);
          roomRef.current = null;
          roomCallId.current = null;
          if (refreshTimer.current) clearTimeout(refreshTimer.current);
          if (lobbyTimer.current) clearTimeout(lobbyTimer.current);
          // CLIENT_INITIATED is what LiveKit reports for every disconnect WE
          // asked for — leave(), the CallEnded handler, a revoked-token
          // refresh, and the stale-room cleanup in join() above all call
          // room.disconnect() themselves and already handle telling the
          // server we left. Anything else is LiveKit giving up on its own:
          // its reconnect policy (see Reconnecting/Reconnected above)
          // exhausted every retry, or the server/SFU ended the session
          // outright. Nothing else in this hook reacts to that on its own,
          // so this is the one place that can — without it the participant
          // was left on a bare "Connecting…" placeholder with every control
          // silently no-op'ing on a null room, and the server never heard
          // they had gone.
          if (reason === DisconnectReason.CLIENT_INITIATED) {
            setStatus("idle");
            return;
          }
          setStatus("failed");
          const displaced = reason === DisconnectReason.DUPLICATE_IDENTITY;
          setFailStage(displaced ? "displaced" : "disconnected");
          if (!displaced && callId && !leftRef.current) {
            leftRef.current = true;
            api.leaveCall(callId).catch(() => {});
          }
        });

      // We are in, so stop asking whether we may come in.
      if (lobbyTimer.current) clearTimeout(lobbyTimer.current);
      stage = "connect";
      logger.debug("[CALL ROOM] Connecting to LiveKit");
      await room.connect(grant.url, grant.token);
      // Camera and mic are NOT published on join — the participant arrives
      // muted and camera-off, and only the controls below (toggleMic/toggleCam)
      // ever ask the room to publish either. Nothing here or on reconnect
      // enables them.
      setConnectedAt(Date.now());
      setStatus("connected");
      logger.debug("[CALL ROOM] Connected");
      sync(room);
      scheduleRefresh(room, callId, grant.expiresAt);
      // Best-effort, same contract as the reconnect report above — a throw
      // here must not turn a call that just connected into one reported as
      // "failed".
      try {
        void api.callTelemetrySetupComplete(callId, Date.now() - attemptStartedAt).catch(() => {});
      } catch {
        // reported nowhere on purpose — see the reconnect handler's comment.
      }
    } catch (e) {
      roomRef.current = null;
      roomCallId.current = null;
      if (e instanceof ApiError && e.code === "call_session_active") {
        setStatus("switch_required");
        setFailStage(null);
        return;
      }
      // The server answers 409 `call_ended` for a call that is over. That is
      // not a credentials problem and not retryable — say so, and do not toast
      // an error for what is simply the state of the meeting. (A 403 is a real
      // refusal and keeps the generic path below.)
      if (stage === "token" && e instanceof ApiError && e.code === "call_ended") {
        setStatus("failed");
        setFailStage("ended");
        return;
      }
      setStatus("failed");
      setFailStage(stage);
      logger.error(`[CALL ROOM] Join failed at "${stage}" stage`, e);
      // A 503 here means the deployment has no SFU configured, which is a very
      // different problem from a denied join — say which.
      const msg =
        e instanceof Error && /503|not configured/i.test(e.message)
          ? tr("errors.notConfigured")
          : tr("errors.couldNotJoin");
      toast.error(msg);
    } finally {
      // Released on EVERY exit, including the lobby's early return — that path
      // is exactly the one a later poll or `call.started` has to be able to
      // re-enter.
      joining.current = false;
    }
  }, [api, callId, scheduleRefresh, stopWaiting, subscribeToEvents, sync, tr]);

  // Keep the lobby poll pointed at the current join without making join depend
  // on itself.
  useEffect(() => {
    joinRef.current = join;
  }, [join]);

  /**
   * The call ended under us — its host left, or ended it deliberately.
   *
   * This is the ONLY thing that gets a participant out of a room that is over.
   * Their room token is still valid for minutes, the SFU keeps the room alive
   * while anybody is in it, and the server does not kick anyone; without this
   * they sit in a meeting nobody is hosting, looking at tiles of people whose
   * clients did close it.
   *
   * Subscribed for the hook's whole life rather than only while connected: the
   * event has to land for someone sitting in the lobby of a call that is
   * cancelled before it ever starts, too.
   */
  useEffect(() => {
    if (!callId) return;
    return subscribeToEvents((e, meta) => {
      if (e.type !== EventType.CallEnded || e.callId !== callId) return;
      // NOT from the reconnect replay. The gateway replays up to 200 events on
      // every connect, so without this a "this meeting ended" from hours ago
      // would throw everyone out of the meeting they just joined — the same
      // reason queryBridge gates its toasts on `live`.
      if (meta?.replayed) return;
      stopWaiting();
      // This disconnect must run the Disconnected handler's normal cleanup
      // even if it lands mid-refresh (scheduleRefresh's own disconnect+
      // connect cycle) — the call is genuinely over, so there is nothing
      // left for that reconnect to resume.
      refreshingRef.current = false;
      void roomRef.current?.disconnect();
      // Record the departure exactly once, the same way hanging up does — the
      // call being over is not a reason for the roster to keep showing everyone
      // as still in it.
      if (!leftRef.current) {
        leftRef.current = true;
        api.leaveCall(callId).catch(() => {});
      }
      setEnded(true);
      toast(tr("notify.meetingEnded", { context: adhoc ? "call" : undefined }));
    });
  }, [adhoc, api, callId, stopWaiting, subscribeToEvents, tr]);

  /** Start the call we are waiting for, admitting everyone else waiting on it
   *  at the same moment. Only does anything for the people the server named in
   *  `canStart`; everyone else gets a 403 and keeps waiting.
   *
   *  Joining is a separate step, and stays that way: starting the call is what
   *  makes a token mintable, and the join that follows is the ordinary one
   *  everybody arriving late also makes. */
  const start = useCallback(async () => {
    if (!callId) return;
    try {
      await api.startCall(callId);
    } catch {
      toast.error(tr("errors.couldNotStart"));
      return;
    }
    stopWaiting();
    await join();
  }, [api, callId, join, stopWaiting, tr]);

  /** Our own identity in the room, or "" before we are in one. */
  const identity = participants.find((p) => p.isLocal)?.identity ?? "";

  const leave = useCallback(async (opts?: { awaitServer?: boolean }) => {
    stopWaiting();
    const room = roomRef.current;
    // Leaving the WAITING ROOM is a real departure too — there is no room to
    // disconnect from, but the server should stop counting us as waiting, and
    // an earlier version returned here and left us in the lobby forever.
    if (!room) {
      if (status === "waiting") {
        setStatus("idle");
        if (callId && !leftRef.current) {
          leftRef.current = true;
          const p = api.leaveCall(callId).catch(() => {});
          if (opts?.awaitServer) await p;
        }
      } else if (status === "connecting") {
        // A join is still awaiting its token, so there is no room yet to
        // disconnect. Record the request — join() checks it the moment the
        // token comes back and reports the departure itself instead of
        // entering the waiting room or connecting to the SFU. See
        // leaveRequestedWhileConnecting's own comment.
        leaveRequestedWhileConnecting.current = true;
      } else if (status === "switch_required") {
        setStatus("idle");
      }
      return;
    }
    // Same reasoning as the CallEnded handler above: an explicit Leave must
    // get the Disconnected handler's normal cleanup even if it lands
    // mid-refresh.
    refreshingRef.current = false;
    await room.disconnect();
    if (callId && !leftRef.current) {
      leftRef.current = true;
      const p = api.leaveCall(callId).catch(() => {});
      if (opts?.awaitServer) await p;
    }
  }, [api, callId, status, stopWaiting]);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    // Only ENABLING risks a permission prompt/denial — disabling an
    // already-negotiated track cannot fail this way, so only that path needs
    // the try/catch (mirrors toggleShare's own on/off split below).
    if (micOn) {
      await room.localParticipant.setMicrophoneEnabled(false);
      setMicOn(false);
      sync(room);
      return;
    }
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (e) {
      const denied = isGetUserMediaDenied(e);
      toast(tr(denied ? "notify.micBlocked" : "notify.micUnavailable"), {
        description: tr(denied ? "notify.micBlockedHint" : "notify.micUnavailableHint"),
      });
      return;
    }
    setMicOn(true);
    sync(room);
  }, [micOn, sync, tr]);

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    if (camOn) {
      await room.localParticipant.setCameraEnabled(false);
      setCamOn(false);
      sync(room);
      return;
    }
    try {
      await room.localParticipant.setCameraEnabled(true);
    } catch (e) {
      const denied = isGetUserMediaDenied(e);
      toast(tr(denied ? "notify.cameraBlocked" : "notify.cameraUnavailable"), {
        description: tr(denied ? "notify.cameraBlockedHint" : "notify.cameraUnavailableHint"),
      });
      return;
    }
    setCamOn(true);
    sync(room);
  }, [camOn, sync, tr]);

  /**
   * Start or stop sharing this screen.
   *
   * Two halves, and both matter. The SFU carries the picture — that is
   * setScreenShareEnabled, and it is what everyone in the room sees. The API
   * call is the room's RECORD of who is sharing and what they picked, which is
   * what a participant arriving mid-share is told instead of having to infer it
   * from whichever track turns up first. Publishing without recording would
   * work today and be invisible tomorrow.
   *
   * The backend is the one that actually enforces "only one share per call" —
   * see messaging-svc's StartScreenShare — so a start here can be rejected
   * even after LiveKit has already begun publishing the track (most commonly:
   * another participant started first, the two races being close enough that
   * local disabling below did not catch it). When that happens the LiveKit
   * publish is rolled back rather than left live with the server having
   * refused to record it — a share nobody else is told about, that this
   * client alone believes is on.
   */
  const toggleShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room || !callId || sharingPending) return;
    setSharingPending(true);
    try {
      if (sharing) {
        await room.localParticipant.setScreenShareEnabled(false);
        setSharing(false);
        try {
          await api.stopScreenShare(callId);
        } catch {
          // Stopping is idempotent server-side (duplicate/late stops are not
          // an error) — a failed network call here cannot leave the server
          // thinking this client is still sharing in a way that matters,
          // since the LiveKit track is already torn down either way.
        }
        sync(room);
        return;
      }
      let pub;
      try {
        pub = await room.localParticipant.setScreenShareEnabled(true);
      } catch (e) {
        // Dismissing the picker is a normal thing to do, and not an error.
        if (!isGetUserMediaDenied(e)) {
          toast.error(tr("errors.couldNotShareScreen"));
        }
        return;
      }
      if (!pub) return;
      const settings = pub.track?.mediaStreamTrack.getSettings() as
        | (MediaTrackSettings & { displaySurface?: string })
        | undefined;
      try {
        // The API takes the browser's own spelling of what was picked, so
        // this can be forwarded as it came.
        await api.startScreenShare(callId, (settings?.displaySurface ?? "monitor") as "monitor");
      } catch (e) {
        await room.localParticipant.setScreenShareEnabled(false).catch(() => {});
        sync(room);
        toast.error(
          e instanceof ApiError && e.code === "share_active"
            ? tr("errors.someoneElseSharing")
            : tr("errors.couldNotShareScreen"),
        );
        return;
      }
      setSharing(true);
      sync(room);
    } finally {
      setSharingPending(false);
    }
  }, [api, callId, sharing, sharingPending, sync, tr]);

  /**
   * Say something to the room — everyone, or named participants.
   *
   * Reliable delivery: every message this app sends is state somebody would
   * otherwise be missing (a hand that stays up, a note nobody else got), and
   * none of them are frequent enough for lossy to buy anything.
   *
   * Silently does nothing when there is no room yet, which is the honest
   * behaviour for a call that has not connected: there is nobody to tell.
   */
  const sendData = useCallback((msg: RoomMessage, to?: string[]) => {
    const room = roomRef.current;
    if (!room) return;
    void room.localParticipant
      .publishData(encodeRoomMessage(msg), { reliable: true, destinationIdentities: to })
      .catch(() => {
        // A failed datagram is not worth interrupting a call for. The state it
        // carried is re-sent on the next sync request.
      });
  }, []);

  /** Subscribe to room messages; returns an unsubscribe. */
  const onData = useCallback((cb: (m: RoomMessage, from: string) => void) => {
    dataSubs.current.add(cb);
    return () => {
      dataSubs.current.delete(cb);
    };
  }, []);

  /** Pull more people from this org into the call. The server rings them and
   *  refreshes the roster for everyone already here. */
  const addPeople = useCallback(
    async (userIds: string[]) => {
      if (!callId) return;
      const { added, failed } = await addCallParticipants((id) => api.addCallParticipant(callId, id), userIds);
      // Nobody got in: say why. Some did: they are on their way, so this is
      // not a failure — only a note that the rest were not added.
      if (added.length === 0 && failed.length > 0) throw failed[0]!.error;
      if (failed.length > 0) toast.warning(tr("notify.addedSome", { added: added.length, total: userIds.length }));
    },
    [api, callId, tr],
  );

  // Disconnect on unmount. Without this, navigating away leaves the camera on
  // and the participant still in the room for everyone else.
  useEffect(() => {
    unmountedRef.current = false; // StrictMode re-mounts after a simulated unmount
    return () => {
      unmountedRef.current = true;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      // Without these the lobby outlives the component and keeps asking to be
      // let into a call nobody is looking at any more — the timer by polling,
      // and the socket subscription by re-joining the moment a host starts it,
      // which is the worse of the two because it fires with no UI attached.
      // Written out rather than calling stopWaiting so this stays a []-dep
      // effect that runs exactly once, on unmount.
      if (lobbyTimer.current) clearTimeout(lobbyTimer.current);
      if (lobbyOff.current) lobbyOff.current();
      const wasIn = !!roomRef.current;
      void roomRef.current?.disconnect();
      roomRef.current = null;
      // Navigating away IS leaving. Disconnecting alone only tells the SFU;
      // the server's own roster kept this participant joined forever, and a
      // screen share they had running stayed recorded as live for everyone who
      // joined afterwards — MarkLeft is what stops both. Hanging up already
      // did this, hence the flag: it must not be sent twice.
      const id = callIdRef.current;
      if (wasIn && id && !leftRef.current) {
        leftRef.current = true;
        apiRef.current.leaveCall(id).catch(() => {});
      }
    };
  }, []);

  return {
    status,
    failStage,
    participants,
    micOn,
    camOn,
    sharing,
    sharingPending,
    /** Someone OTHER than this participant is currently sharing. The Share
     *  Screen control uses this to disable itself — not as the enforcement
     *  (the backend's unique-share-per-call constraint is; see toggleShare's
     *  doc comment), but so a participant is not sent through the picker
     *  only to have the request rejected. Derived from the same per-tile
     *  `sharing` flag `sync()` already computes from LiveKit's own track
     *  state for every participant (local and remote) on every relevant room
     *  event — connect, reconnect, and every subscribe/unsubscribe/mute — so
     *  it stays correct through state sync and reconnects without a second,
     *  independently-updated notion of "who is sharing" to drift out of
     *  sync with the tiles themselves. */
    someoneElseSharing: participants.some((p) => p.sharing && !p.isLocal),
    connectedAt,
    canStart,
    ended,
    join,
    start,
    leave,
    toggleMic,
    toggleCam,
    toggleShare,
    addPeople,
    sendData,
    onData,
    /** This client's own participant identity — the BlissWork user id, which is
     *  what every message's `from` is compared against. */
    identity,
    connected: status === "connected" || status === "reconnecting",
    waiting: status === "waiting",
  };
}
