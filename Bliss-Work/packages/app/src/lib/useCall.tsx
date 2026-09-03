import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UserDTO } from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { useSession } from "../store/session";
import { CallSession, type CallMedia } from "./callManager";
import { isGetUserMediaDenied } from "./useCallRoom";
import { toast } from "sonner";
import { createRingtone, primeRingtoneAudio } from "./ringtone";
import { notifyIncomingCall, notifyMissedCall, primeCallNotifications } from "./callNotify";
import { qk } from "./queryBridge";
import { usersByIdsQuery } from "./userLabel";

export type CallStatus = "idle" | "outgoing" | "incoming" | "connecting" | "in-call" | "ended";

export interface CallState {
  status: CallStatus;
  callId?: string;
  peerId?: string;
  peerName?: string;
  media?: CallMedia;
  endedReason?: string;
  micOn: boolean;
  camOn: boolean;
  localStream?: MediaStream;
  remoteStream?: MediaStream;
  /** Our own screen capture, while we are sharing one. */
  screenStream?: MediaStream;
  /** We are sharing our screen. Only ever true for the sharer, which is what
   *  makes the Stop control the sharer's alone — the API has no way to stop
   *  anyone else's share either. */
  sharing: boolean;
  /** The peer is sharing theirs. */
  peerSharing: boolean;
  /** The peer's camera is on. */
  peerCamOn: boolean;
  /** The peer's video slot is carrying pictures — their camera or their screen.
   *  Distinct from the two flags above, which are what their controls say; this
   *  is what has actually arrived. */
  remoteVideo: boolean;
  /** When the media connected, for the in-call timer. */
  connectedAt?: number;
  /** The persistent call row backing this ring, once it has been created. Its
   *  absence is why Add People and Share Screen can be unavailable. */
  recordId?: string;
  /** Set once the call has been widened past two people and handed to the SFU.
   *  The peer connection is closed at that point and the room owns the media. */
  roomCallId?: string;
}

export interface CallApi extends CallState {
  /** Place a call to a peer (only valid when idle). */
  invite: (peerId: string, peerName: string, media: CallMedia) => void;
  accept: () => void;
  decline: () => void;
  /** Cancel (while ringing) or hang up (once connecting/connected). */
  hangup: () => void;
  toggleMic: () => void;
  toggleCam: () => void;
  /** Start or stop sharing this screen. */
  toggleShare: () => void;
  /** Pull more people in. Rejects with a message worth showing when the call
   *  cannot be widened — the room is what carries three or more people, so a
   *  deployment without an SFU adds nobody rather than adding someone who
   *  could never be heard. */
  addPeople: (userIds: string[]) => Promise<void>;
}

const CallCtx = createContext<CallApi | null>(null);

const RING_TIMEOUT_MS = 30_000;
// Last-resort ICE if /turn-credentials is unreachable — same-network calls still
// work; cross-NAT needs the real TURN creds the endpoint returns.
const STUN_FALLBACK: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  bundlePolicy: "max-bundle",
};

const IDLE: CallState = {
  status: "idle",
  micOn: true,
  camOn: true,
  sharing: false,
  peerSharing: false,
  peerCamOn: false,
  remoteVideo: false,
};

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { rtc, api, config } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user);
  const [state, setState] = useState<CallState>(IDLE);
  const sessionRef = useRef<CallSession | null>(null);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const incomingRef = useRef<{ callId: string; peerId: string; media: CallMedia } | null>(null);
  /** The call row backing this ring. Held in a ref as well as in state because
   *  the session callbacks below are stable and still have to reach it. */
  const recordRef = useRef<string | undefined>(undefined);
  // Mirror the live call id/status into refs so the (stable) onControl handler
  // can read them without re-subscribing on every state change.
  const stateRef = useRef(state);
  stateRef.current = state;

  const clearRing = () => {
    if (ringTimer.current) {
      clearTimeout(ringTimer.current);
      ringTimer.current = undefined;
    }
  };

  /** Close the call row this ring was backed by.
   *
   *  endCall first because the caller is its HOST and that is what marks the
   *  row ENDED — left LIVE, every 1:1 call anyone ever placed would sit in the
   *  Meetings "Live" list forever. The callee is not a host and gets a 403, so
   *  they record their own departure instead. Both are best-effort: the call is
   *  over on screen either way, and a stuck row is not worth an error toast.
   *
   *  `leaveOnly` is the case where the call was widened and handed to the room:
   *  ending it there would throw everyone else out because the person who
   *  placed the original 1:1 call happens to be its host, which is not what
   *  leaving a group call means. */
  const closeRecord = useCallback(
    (callId: string, leaveOnly: boolean) => {
      if (leaveOnly) void api.leaveCall(callId).catch(() => {});
      else void api.endCall(callId).catch(() => api.leaveCall(callId).catch(() => {}));
      void qc.invalidateQueries({ queryKey: qk.calls });
    },
    [api, qc],
  );

  const teardown = useCallback(
    (status: CallStatus, reason?: string) => {
      clearRing();
      sessionRef.current?.close(reason ?? "ended");
      sessionRef.current = null;
      incomingRef.current = null;
      const record = recordRef.current;
      recordRef.current = undefined;
      if (record) closeRecord(record, !!stateRef.current.roomCallId);
      setState((s) => ({ ...IDLE, status, endedReason: reason, peerName: s.peerName }));
      if (status === "ended") {
        setTimeout(() => setState((s) => (s.status === "ended" ? IDLE : s)), 2500);
      }
    },
    [closeRecord],
  );

  /** Record a call nobody picked up, so it survives in the conversation instead
   *  of vanishing with the overlay. Written by the CALLER only — both sides read
   *  the same thread, and one writer means no duplicate entry. The recipient's
   *  unread badge, inbox and notification all come free with the message. */
  const recordMissedCall = useCallback(
    (peerId: string, media: CallMedia) => {
      void api
        .sendMessage(peerId, media === "video" ? "Missed video call" : "Missed voice call", undefined, "call_missed")
        .then((res) => {
          // The WS echo of our OWN message is deliberately dropped (the composer
          // renders those optimistically), and this one never went through the
          // composer — so refresh the thread ourselves or the caller sees the
          // entry only after a reload.
          void qc.invalidateQueries({ queryKey: qk.messages(res.conversationId) });
          void qc.invalidateQueries({ queryKey: qk.conversations });
        })
        .catch(() => {
          /* best-effort: never let bookkeeping surface as a call error */
        });
    },
    [api, qc],
  );

  /** Caller's display name from the already-loaded directory, if it's there. */
  const cachedName = useCallback(
    (userId: string) => qc.getQueryData<UserDTO[]>(qk.directory)?.find((u) => u.id === userId)?.displayName,
    [qc],
  );

  /** Resolve the caller's display name when the cache is cold, so an incoming
   *  call can show a name rather than an e-mail fragment. Best-effort: the
   *  gateway-stamped username is already on screen, so a failure here just
   *  leaves that in place.
   *
   *  This is the worst directory fetch in the app when it falls back: a ringing
   *  phone is the most latency-sensitive moment in the product, and the REST
   *  path downloads every member of the organisation to read ONE name. With a
   *  GraphQL gateway configured it asks for that one person instead. */
  const resolveName = useCallback(
    async (userId: string, callId: string) => {
      if (cachedName(userId)) return;
      try {
        const name = config.graphBase
          ? (await qc.fetchQuery(usersByIdsQuery(api, [userId])))[0]?.displayName
          : (
              await qc.fetchQuery({ queryKey: qk.directory, queryFn: () => api.directory() })
            ).find((u) => u.id === userId)?.displayName;
        if (!name) return;
        setState((s) => (s.callId === callId ? { ...s, peerName: name } : s));
      } catch {
        /* keep whatever the invite frame carried */
      }
    },
    [api, cachedName, config.graphBase, qc],
  );

  const iceConfig = useCallback(async (): Promise<RTCConfiguration> => {
    try {
      const creds = await api.turnCredentials();
      if (creds.iceServers?.length) {
        return { iceServers: creds.iceServers as RTCIceServer[], bundlePolicy: "max-bundle" };
      }
    } catch {
      /* fall through to STUN-only */
    }
    return STUN_FALLBACK;
  }, [api]);

  /** Hand this call over to the SFU room and close the peer connection.
   *
   *  Peer-to-peer carries exactly two people: with three, every client uploads
   *  a copy of its camera to every other one. So the moment a call is widened
   *  it stops being peer-to-peer — both ends move to the room, and the person
   *  who was just added joins the same room from their side. */
  const enterRoom = useCallback((roomCallId: string) => {
    clearRing();
    // Detach BEFORE closing: onClosed only tears the call down when the session
    // it is reporting is still the live one, and this is a hand-over rather
    // than a hang-up.
    const s = sessionRef.current;
    sessionRef.current = null;
    s?.close("moved to the room");
    recordRef.current = roomCallId;
    setState((st) => ({
      ...IDLE,
      status: "in-call",
      callId: st.callId,
      peerId: st.peerId,
      peerName: st.peerName,
      media: st.media,
      connectedAt: st.connectedAt ?? Date.now(),
      recordId: roomCallId,
      roomCallId,
    }));
  }, []);

  const newSession = useCallback(
    (callId: string, peerId: string, media: CallMedia, cfg: RTCConfiguration) => {
      /** Give the peer the id of the call row, which only our side knows. */
      const pushRecord = () => {
        if (recordRef.current) s.send({ t: "record", callId: recordRef.current });
      };
      const s: CallSession = new CallSession({
        callId,
        peerId,
        media,
        iceConfig: cfg,
        sendFrame: (f) => rtc.sendFrame(f),
        onRemoteStream: (stream) => setState((st) => ({ ...st, remoteStream: stream })),
        onConnected: () =>
          setState((st) => ({
            ...st,
            status: "in-call",
            connectedAt: st.connectedAt ?? Date.now(),
            localStream: s.localStream,
            remoteStream: s.remoteStream,
          })),
        onMetaOpen: pushRecord,
        onRemoteVideo: (live) => setState((st) => ({ ...st, remoteVideo: live })),
        onPeerMessage: (msg) => {
          switch (msg.t) {
            case "state":
              setState((st) => ({ ...st, peerCamOn: msg.cam, peerSharing: msg.sharing }));
              break;
            case "record":
              // Whoever placed the call owns the row; adopt it unless we
              // somehow have one already.
              if (!recordRef.current) {
                recordRef.current = msg.callId;
                setState((st) => ({ ...st, recordId: msg.callId }));
              }
              break;
            case "room":
              enterRoom(msg.callId);
              break;
          }
        },
        onShareEnded: () => {
          setState((st) => ({ ...st, sharing: false, screenStream: undefined }));
          if (recordRef.current) void api.stopScreenShare(recordRef.current).catch(() => {});
        },
        onClosed: (reason) => {
          if (sessionRef.current === s) teardown("ended", reason);
        },
      });
      sessionRef.current = s;
      return s;
    },
    [api, enterRoom, rtc, teardown],
  );

  /**
   * Back this ring with a persistent call row.
   *
   * Add People and Share Screen are both requests against `/api/v1/calls/{id}`,
   * and a ring on its own has no id to put there — the callId in the signaling
   * frames is invented by the caller and known to nobody but the two ends. So
   * the caller creates the row, and tells the callee its id over the call's own
   * metadata channel (see pushRecord).
   *
   * Deliberately NOT awaited by invite(): the ring is the thing the user asked
   * for and it must not wait on an HTTP round trip, nor fail if this does. What
   * degrades without a row is those two controls, which say so.
   */
  const backWithRecord = useCallback(
    async (peerId: string, media: CallMedia, ringId: string) => {
      try {
        const row = await api.startDirectCall(peerId, media);
        if (stateRef.current.callId !== ringId) {
          // Declined, cancelled or rung out while we were creating it. Leaving
          // it LIVE would put a call nobody is on in the Meetings list.
          void api.endCall(row.id).catch(() => {});
          return;
        }
        recordRef.current = row.id;
        setState((s) => (s.callId === ringId ? { ...s, recordId: row.id } : s));
        sessionRef.current?.send({ t: "record", callId: row.id });
      } catch {
        /* the call still works; the two controls that need a row report it */
      }
    },
    [api],
  );

  const invite = useCallback(
    (peerId: string, peerName: string, media: CallMedia) => {
      if (!me || stateRef.current.status !== "idle") return;
      const callId = crypto.randomUUID();
      setState({ ...IDLE, status: "outgoing", callId, peerId, peerName, media, camOn: media === "video" });
      rtc.sendFrame({ type: "call.invite", toUserId: peerId, callId, media });
      recordRef.current = undefined;
      void backWithRecord(peerId, media, callId);
      clearRing();
      ringTimer.current = setTimeout(() => {
        rtc.sendFrame({ type: "call.cancel", toUserId: peerId, callId });
        recordMissedCall(peerId, media);
        teardown("ended", "No answer");
      }, RING_TIMEOUT_MS);
    },
    [me, rtc, teardown, recordMissedCall, backWithRecord],
  );

  const accept = useCallback(() => {
    const inc = incomingRef.current;
    if (!inc) return;
    clearRing();
    setState((s) => ({ ...s, status: "connecting" }));
    void (async () => {
      const cfg = await iceConfig();
      const s = newSession(inc.callId, inc.peerId, inc.media, cfg);
      try {
        await s.prepareCallee(); // mic/cam permission prompt happens here
      } catch {
        teardown("ended", "Camera/microphone blocked");
        return;
      }
      setState((st) => ({ ...st, localStream: s.localStream }));
      rtc.sendFrame({ type: "call.accept", toUserId: inc.peerId, callId: inc.callId });
    })();
  }, [iceConfig, newSession, rtc, teardown]);

  const decline = useCallback(() => {
    const inc = incomingRef.current;
    if (inc) rtc.sendFrame({ type: "call.decline", toUserId: inc.peerId, callId: inc.callId });
    teardown("idle");
  }, [rtc, teardown]);

  const hangup = useCallback(() => {
    const { callId, peerId, status, media } = stateRef.current;
    if (callId && peerId) {
      if (status === "outgoing") {
        // Given up on before the peer answered — from their side that is a
        // missed call, exactly as if it had rung out.
        rtc.sendFrame({ type: "call.cancel", toUserId: peerId, callId });
        recordMissedCall(peerId, media ?? "audio");
      } else rtc.sendFrame({ type: "call.end", toUserId: peerId, callId });
    }
    teardown("idle");
  }, [rtc, teardown, recordMissedCall]);

  const toggleMic = useCallback(() => {
    const on = sessionRef.current?.toggleMic();
    setState((s) => ({ ...s, micOn: on ?? s.micOn }));
  }, []);
  /** Camera on/off — including the first "on" of a call that started as voice,
   *  which has to acquire a track and can be refused at the permission prompt
   *  rather than just flipping `enabled` on one we already hold. */
  const toggleCam = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    void s
      .setCam()
      .then((on) => setState((st) => ({ ...st, camOn: on })))
      .catch(() =>
        toast("Camera unavailable", { description: "Check this app's camera permission." }),
      );
  }, []);

  const toggleShare = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    const record = recordRef.current;
    void (async () => {
      if (s.sharing) {
        await s.stopShare();
        setState((st) => ({ ...st, sharing: false, screenStream: undefined }));
        if (record) await api.stopScreenShare(record).catch(() => {});
        return;
      }
      let surface: string;
      try {
        surface = await s.startShare();
      } catch (e) {
        // Dismissing the picker is a normal thing to do, and not worth a toast.
        // Anything else is.
        if (!isGetUserMediaDenied(e)) {
          toast.error("Couldn't share your screen");
        }
        return;
      }
      setState((st) => ({ ...st, sharing: true, screenStream: s.screenStream }));
      // Tell the server what is on screen. The picture is already on its way
      // over the peer connection — this is the room's record of who is sharing
      // and what they picked, which is what someone arriving later reads.
      if (record) {
        await api.startScreenShare(record, surface as "monitor" | "window" | "browser").catch(() => {});
      }
    })();
  }, [api]);

  const addPeople = useCallback(
    async (userIds: string[]) => {
      const record = recordRef.current;
      const s = sessionRef.current;
      if (!record || !s) throw new Error("This call can't have people added to it.");
      if (userIds.length === 0) return;
      // Prove the room is reachable BEFORE adding anybody: peer-to-peer carries
      // two people, so on a deployment with no SFU the honest outcome is to add
      // nobody, rather than to add someone into a room the other two can never
      // move to.
      await api.callToken(record);
      for (const id of userIds) await api.addCallParticipant(record, id);
      // Take the peer across, then move ourselves. Whoever was added is rung by
      // the server and joins the same room from their side.
      s.send({ t: "room", callId: record });
      enterRoom(record);
      void qc.invalidateQueries({ queryKey: qk.calls });
    },
    [api, enterRoom, qc],
  );

  // Inbound call + media signaling. Stable subscription (reads live state via
  // stateRef), so it isn't torn down/re-created on every state transition.
  useEffect(() => {
    const off = rtc.onControl((f) => {
      const cur = stateRef.current;
      void (async () => {
        switch (f.type) {
          case "call.invite": {
            // Busy or mid-call → auto-decline the second caller.
            if (sessionRef.current || cur.status !== "idle") {
              rtc.sendFrame({ type: "call.decline", toUserId: f.fromUserId, callId: f.callId });
              return;
            }
            incomingRef.current = { callId: f.callId, peerId: f.fromUserId, media: f.media };
            setState({
              ...IDLE,
              status: "incoming",
              callId: f.callId,
              peerId: f.fromUserId,
              // Name the caller straight away from what the gateway stamped, so
              // the ring screen is never the anonymous "User" placeholder.
              peerName: cachedName(f.fromUserId) ?? f.fromName,
              media: f.media,
              camOn: f.media === "video",
            });
            clearRing();
            ringTimer.current = setTimeout(() => {
              notifyMissedCall(stateRef.current.peerName ?? "Someone");
              teardown("idle");
            }, RING_TIMEOUT_MS);
            // Upgrade to the directory display name if the cache was cold —
            // guarded on still ringing the same call when it lands.
            void resolveName(f.fromUserId, f.callId);
            break;
          }
          case "call.accept": {
            if (cur.status !== "outgoing" || f.callId !== cur.callId) return;
            clearRing();
            setState((s) => ({ ...s, status: "connecting" }));
            const cfg = await iceConfig();
            const s = newSession(f.callId, f.fromUserId, cur.media ?? "audio", cfg);
            try {
              await s.startCaller();
            } catch {
              teardown("ended", "Camera/microphone blocked");
              return;
            }
            setState((st) => ({ ...st, localStream: s.localStream }));
            break;
          }
          case "call.decline":
            if (f.callId === cur.callId) teardown("ended", "Call declined");
            break;
          case "call.cancel":
            if (f.callId === (cur.callId ?? incomingRef.current?.callId)) {
              // Caller hung up before we picked up — a missed call on this side.
              if (cur.status === "incoming") notifyMissedCall(cur.peerName ?? "Someone");
              teardown("idle");
            }
            break;
          case "call.end":
            if (f.callId === cur.callId) teardown("ended", "Call ended");
            break;
          case "rtc.offer":
            if (sessionRef.current && f.offerId === cur.callId) await sessionRef.current.onOffer(f.sdp);
            break;
          case "rtc.answer":
            if (sessionRef.current && f.offerId === cur.callId) await sessionRef.current.onAnswer(f.sdp);
            break;
          case "rtc.ice":
            if (sessionRef.current && f.offerId === cur.callId) await sessionRef.current.onIce(f.candidate);
            break;
          case "rtc.peer.unreachable":
            if (f.offerId === cur.callId) teardown("ended", "User unavailable");
            break;
        }
      })();
    });
    return off;
  }, [rtc, iceConfig, newSession, teardown, cachedName, resolveName]);

  // Ring + notify, driven by call STATUS rather than by the overlay's render so
  // every exit path (accept, decline, cancel, ring timeout, peer unreachable,
  // unmount) clears both through the effect cleanup — no extra call sites.
  useEffect(() => {
    if (state.status !== "incoming" && state.status !== "outgoing") return;
    const incoming = state.status === "incoming";
    const ring = createRingtone(incoming ? "incoming" : "outgoing", () => {
      // Every audio path refused — say so instead of ringing silently. The
      // click that dismisses this toast is itself the gesture that unblocks
      // sound for the rest of the session.
      if (incoming) toast("Ringtone is muted by your browser", { description: "Click anywhere to allow call sounds." });
    });
    ring.start();
    // Only the callee gets a banner; the caller is already looking at the app.
    const note = incoming ? notifyIncomingCall(state.peerName ?? "Someone", state.media ?? "audio") : undefined;
    return () => {
      ring.stop();
      note?.close();
    };
    // peerName is intentionally not a dependency: it can arrive a beat late from
    // the directory, and re-running would restart the ring from the top.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  // Unlock audio + ask for notification permission on the first interaction.
  // Both are refused without a user gesture, and a call arriving at an idle tab
  // is exactly the case with no recent gesture of its own.
  useEffect(() => primeRingtoneAudio(), []);
  useEffect(() => primeCallNotifications(), []);

  const value = useMemo<CallApi>(
    () => ({ ...state, invite, accept, decline, hangup, toggleMic, toggleCam, toggleShare, addPeople }),
    [state, invite, accept, decline, hangup, toggleMic, toggleCam, toggleShare, addPeople],
  );
  return <CallCtx.Provider value={value}>{children}</CallCtx.Provider>;
}

export function useCall(): CallApi {
  const c = useContext(CallCtx);
  if (!c) throw new Error("useCall outside CallProvider");
  return c;
}
