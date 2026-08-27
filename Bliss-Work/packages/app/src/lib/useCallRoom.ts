import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioPresets,
  ConnectionState,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type RemoteParticipant,
} from "livekit-client";
import { toast } from "sonner";
import { EventType } from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { decodeRoomMessage, encodeRoomMessage, type RoomMessage } from "./roomMessages";

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
 */
export function useCallRoom(callId: string | null) {
  const { api, ws } = useRuntime();
  const [status, setStatus] = useState<RoomStatus>("idle");
  const [participants, setParticipants] = useState<RoomParticipant[]>([]);
  // Neither is published on join — see the connect step in `join` below.
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  /** When this participant's own media connected, for the in-call timer. */
  const [connectedAt, setConnectedAt] = useState<number | undefined>(undefined);
  /** Whether THIS user could start the call they are waiting for. Answered by
   *  the server, because it turns on org and channel roles the client cannot
   *  see. Only meaningful while status is "waiting". */
  const [canStart, setCanStart] = useState(false);
  /** The call is over — the host ended it or walked out. Latches, and the screen
   *  showing this room is expected to close itself on it. */
  const [ended, setEnded] = useState(false);
  const roomRef = useRef<Room | null>(null);
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
  const lobbyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Unsubscribes the `call.started` listener that ends a lobby wait. */
  const lobbyOff = useRef<(() => void) | null>(null);
  /** The call we are in, and whether the server has already been told we left.
   *  Read by the unmount cleanup, which cannot close over changing values. */
  const leftRef = useRef(false);
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
      rows.push({
        identity: p.identity,
        name: p.name || p.identity,
        isLocal,
        speaking: p.isSpeaking,
        // A publication that is muted or unsubscribed is "off" as far as the
        // UI is concerned — the distinction only matters to the transport.
        micOn: !!mic && !mic.isMuted,
        camOn: !!cam && !cam.isMuted,
        sharing: !!screen && !screen.isMuted,
        videoTrack: cam?.track ?? null,
        screenTrack: screen?.track ?? null,
        audioTrack: mic?.track ?? null,
      });
    };
    add(room.localParticipant, true);
    room.remoteParticipants.forEach((p) => add(p, false));
    setParticipants(rows);
  }, []);

  /** Re-mint the room token before the current one lapses. */
  const scheduleRefresh = useCallback(
    (room: Room, id: string, expiresAt: string) => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      const msLeft = new Date(expiresAt).getTime() - Date.now();
      // Refresh at 80% of the remaining life, with a floor so a clock skew
      // cannot turn this into a tight loop against the API.
      const delay = Math.max(30_000, msLeft * 0.8);
      refreshTimer.current = setTimeout(() => {
        api
          .callToken(id)
          .then((t) => {
            // A live call cannot go back to being unstarted, so WAITING here
            // means the room we are in is no longer one we hold a grant for.
            // Treat it exactly like a refusal rather than assuming a token.
            if (t.state !== "JOINED") {
              void room.disconnect();
              return;
            }
            // LiveKit accepts a replacement token on the live connection, so a
            // refresh is invisible to the participant — no reconnect, no gap.
            void room.localParticipant.setMetadata?.("");
            room.prepareConnection?.(t.url, t.token);
            scheduleRefresh(room, id, t.expiresAt);
          })
          .catch(() => {
            // Access was withdrawn (removed from the channel, call ended, or
            // the meeting link revoked). Leaving is the correct response.
            toast.error("You no longer have access to this call");
            void room.disconnect();
          });
      }, delay);
    },
    [api],
  );

  const join = useCallback(async () => {
    // TEMP DIAGNOSTIC — remove once the stuck-on-"Joining the meeting…" bug
    // is found. Tagged so it's easy to filter/strip.
    console.info("[BW-DIAG] join() called", {
      callId,
      hasRoomRef: !!roomRef.current,
      joining: joining.current,
    });
    if (!callId || roomRef.current || joining.current) return;
    joining.current = true;
    setStatus("connecting");
    try {
      console.info("[BW-DIAG] requesting call token", callId);
      const grant = await api.callToken(callId);
      console.info("[BW-DIAG] got call token grant", { state: grant.state });
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
        lobbyOff.current = ws.on((e) => {
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
        audioCaptureDefaults: {
          // Stated rather than assumed. These are browser defaults today, but
          // they are the difference between a call and an echo chamber, and a
          // default is a thing that changes without telling you.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },

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

      const resync = () => sync(room);
      room
        .on(RoomEvent.ParticipantConnected, resync)
        .on(RoomEvent.ParticipantDisconnected, resync)
        .on(RoomEvent.TrackSubscribed, (_t: RemoteTrack, _p: RemoteTrackPublication) => resync())
        .on(RoomEvent.TrackUnsubscribed, resync)
        .on(RoomEvent.TrackMuted, resync)
        .on(RoomEvent.TrackUnmuted, resync)
        .on(RoomEvent.LocalTrackPublished, resync)
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
        })
        .on(RoomEvent.Disconnected, () => {
          setStatus("idle");
          setParticipants([]);
          setSharing(false);
          setConnectedAt(undefined);
          roomRef.current = null;
          if (refreshTimer.current) clearTimeout(refreshTimer.current);
          if (lobbyTimer.current) clearTimeout(lobbyTimer.current);
        });

      // We are in, so stop asking whether we may come in.
      if (lobbyTimer.current) clearTimeout(lobbyTimer.current);
      await room.connect(grant.url, grant.token);
      // Camera and mic are NOT published on join — the participant arrives
      // muted and camera-off, and only the controls below (toggleMic/toggleCam)
      // ever ask the room to publish either. Nothing here or on reconnect
      // enables them.
      setConnectedAt(Date.now());
      setStatus("connected");
      sync(room);
      scheduleRefresh(room, callId, grant.expiresAt);
    } catch (e) {
      // TEMP DIAGNOSTIC — remove once the stuck-on-"Joining the meeting…" bug
      // is found.
      console.error("[BW-DIAG] join() threw", e);
      roomRef.current = null;
      setStatus("failed");
      // A 503 here means the deployment has no SFU configured, which is a very
      // different problem from a denied join — say which.
      const msg =
        e instanceof Error && /503|not configured/i.test(e.message)
          ? "Group calling is not enabled on this server"
          : "Couldn't join the call";
      toast.error(msg);
    } finally {
      // Released on EVERY exit, including the lobby's early return — that path
      // is exactly the one a later poll or `call.started` has to be able to
      // re-enter.
      joining.current = false;
    }
  }, [api, callId, scheduleRefresh, stopWaiting, sync, ws]);

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
    return ws.on((e, meta) => {
      if (e.type !== EventType.CallEnded || e.callId !== callId) return;
      // NOT from the reconnect replay. The gateway replays up to 200 events on
      // every connect, so without this a "this meeting ended" from hours ago
      // would throw everyone out of the meeting they just joined — the same
      // reason queryBridge gates its toasts on `live`.
      if (meta?.replayed) return;
      stopWaiting();
      void roomRef.current?.disconnect();
      // Record the departure exactly once, the same way hanging up does — the
      // call being over is not a reason for the roster to keep showing everyone
      // as still in it.
      if (!leftRef.current) {
        leftRef.current = true;
        api.leaveCall(callId).catch(() => {});
      }
      setEnded(true);
      toast("This meeting has ended");
    });
  }, [api, callId, stopWaiting, ws]);

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
      toast.error("Couldn't start the call");
      return;
    }
    stopWaiting();
    await join();
  }, [api, callId, join, stopWaiting]);

  /** Our own identity in the room, or "" before we are in one. */
  const identity = participants.find((p) => p.isLocal)?.identity ?? "";

  const leave = useCallback(async () => {
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
          api.leaveCall(callId).catch(() => {});
        }
      }
      return;
    }
    await room.disconnect();
    if (callId && !leftRef.current) {
      leftRef.current = true;
      api.leaveCall(callId).catch(() => {});
    }
  }, [api, callId, status, stopWaiting]);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !micOn;
    await room.localParticipant.setMicrophoneEnabled(next);
    setMicOn(next);
    sync(room);
  }, [micOn, sync]);

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !camOn;
    await room.localParticipant.setCameraEnabled(next);
    setCamOn(next);
    sync(room);
  }, [camOn, sync]);

  /**
   * Start or stop sharing this screen.
   *
   * Two halves, and both matter. The SFU carries the picture — that is
   * setScreenShareEnabled, and it is what everyone in the room sees. The API
   * call is the room's RECORD of who is sharing and what they picked, which is
   * what a participant arriving mid-share is told instead of having to infer it
   * from whichever track turns up first. Publishing without recording would
   * work today and be invisible tomorrow.
   */
  const toggleShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room || !callId) return;
    if (sharing) {
      await room.localParticipant.setScreenShareEnabled(false);
      setSharing(false);
      await api.stopScreenShare(callId).catch(() => {});
      sync(room);
      return;
    }
    let pub;
    try {
      pub = await room.localParticipant.setScreenShareEnabled(true);
    } catch (e) {
      // Dismissing the picker is a normal thing to do, and not an error.
      if (!(e instanceof DOMException) || e.name !== "NotAllowedError") {
        toast.error("Couldn't share your screen");
      }
      return;
    }
    if (!pub) return;
    setSharing(true);
    sync(room);
    const settings = pub.track?.mediaStreamTrack.getSettings() as
      | (MediaTrackSettings & { displaySurface?: string })
      | undefined;
    // The API takes the browser's own spelling of what was picked, so this can
    // be forwarded as it came.
    await api.startScreenShare(callId, (settings?.displaySurface ?? "monitor") as "monitor").catch(() => {});
  }, [api, callId, sharing, sync]);

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
      for (const id of userIds) await api.addCallParticipant(callId, id);
    },
    [api, callId],
  );

  // Disconnect on unmount. Without this, navigating away leaves the camera on
  // and the participant still in the room for everyone else.
  useEffect(() => {
    return () => {
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
    participants,
    micOn,
    camOn,
    sharing,
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

/** Exposed for the tile component, which needs the enum without importing the SDK. */
export { ConnectionState };
