import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UserDTO } from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { useSession } from "../store/session";
import { CallSession, type CallMedia } from "./callManager";
import { toast } from "sonner";
import { createRingtone, primeRingtoneAudio } from "./ringtone";
import { notifyIncomingCall, notifyMissedCall, primeCallNotifications } from "./callNotify";
import { qk } from "./queryBridge";

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
}

const CallCtx = createContext<CallApi | null>(null);

const RING_TIMEOUT_MS = 30_000;
// Last-resort ICE if /turn-credentials is unreachable — same-network calls still
// work; cross-NAT needs the real TURN creds the endpoint returns.
const STUN_FALLBACK: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  bundlePolicy: "max-bundle",
};

const IDLE: CallState = { status: "idle", micOn: true, camOn: true };

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { rtc, api } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user);
  const [state, setState] = useState<CallState>(IDLE);
  const sessionRef = useRef<CallSession | null>(null);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const incomingRef = useRef<{ callId: string; peerId: string; media: CallMedia } | null>(null);
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

  const teardown = useCallback((status: CallStatus, reason?: string) => {
    clearRing();
    sessionRef.current?.close(reason ?? "ended");
    sessionRef.current = null;
    incomingRef.current = null;
    setState((s) => ({ ...IDLE, status, endedReason: reason, peerName: s.peerName }));
    if (status === "ended") {
      setTimeout(() => setState((s) => (s.status === "ended" ? IDLE : s)), 2500);
    }
  }, []);

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

  /** Fetch the directory when the cache is cold so an incoming call can still
   *  show a display name. Best-effort: the gateway-stamped username is already
   *  on screen, so a failure here just leaves that in place. */
  const resolveName = useCallback(
    async (userId: string, callId: string) => {
      if (cachedName(userId)) return;
      try {
        const dir = await qc.fetchQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
        const name = dir.find((u) => u.id === userId)?.displayName;
        if (!name) return;
        setState((s) => (s.callId === callId ? { ...s, peerName: name } : s));
      } catch {
        /* keep whatever the invite frame carried */
      }
    },
    [api, cachedName, qc],
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

  const newSession = useCallback(
    (callId: string, peerId: string, media: CallMedia, cfg: RTCConfiguration) => {
      const s: CallSession = new CallSession({
        callId,
        peerId,
        media,
        iceConfig: cfg,
        sendFrame: (f) => rtc.sendFrame(f),
        onRemoteStream: (stream) => setState((st) => ({ ...st, remoteStream: stream })),
        onConnected: () =>
          setState((st) => ({ ...st, status: "in-call", localStream: s.localStream, remoteStream: s.remoteStream })),
        onClosed: (reason) => {
          if (sessionRef.current === s) teardown("ended", reason);
        },
      });
      sessionRef.current = s;
      return s;
    },
    [rtc, teardown],
  );

  const invite = useCallback(
    (peerId: string, peerName: string, media: CallMedia) => {
      if (!me || stateRef.current.status !== "idle") return;
      const callId = crypto.randomUUID();
      setState({ ...IDLE, status: "outgoing", callId, peerId, peerName, media, camOn: media === "video" });
      rtc.sendFrame({ type: "call.invite", toUserId: peerId, callId, media });
      clearRing();
      ringTimer.current = setTimeout(() => {
        rtc.sendFrame({ type: "call.cancel", toUserId: peerId, callId });
        recordMissedCall(peerId, media);
        teardown("ended", "No answer");
      }, RING_TIMEOUT_MS);
    },
    [me, rtc, teardown, recordMissedCall],
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
  const toggleCam = useCallback(() => {
    const on = sessionRef.current?.toggleCam();
    setState((s) => ({ ...s, camOn: on ?? s.camOn }));
  }, []);

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
    () => ({ ...state, invite, accept, decline, hangup, toggleMic, toggleCam }),
    [state, invite, accept, decline, hangup, toggleMic, toggleCam],
  );
  return <CallCtx.Provider value={value}>{children}</CallCtx.Provider>;
}

export function useCall(): CallApi {
  const c = useContext(CallCtx);
  if (!c) throw new Error("useCall outside CallProvider");
  return c;
}
