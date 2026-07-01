import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRuntime } from "./runtime";
import { useSession } from "../store/session";
import { CallSession, type CallMedia } from "./callManager";

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
        teardown("ended", "No answer");
      }, RING_TIMEOUT_MS);
    },
    [me, rtc, teardown],
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
    const { callId, peerId, status } = stateRef.current;
    if (callId && peerId) {
      if (status === "outgoing") rtc.sendFrame({ type: "call.cancel", toUserId: peerId, callId });
      else rtc.sendFrame({ type: "call.end", toUserId: peerId, callId });
    }
    teardown("idle");
  }, [rtc, teardown]);

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
            setState({ ...IDLE, status: "incoming", callId: f.callId, peerId: f.fromUserId, media: f.media, camOn: f.media === "video" });
            clearRing();
            ringTimer.current = setTimeout(() => teardown("idle"), RING_TIMEOUT_MS);
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
            if (f.callId === (cur.callId ?? incomingRef.current?.callId)) teardown("idle");
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
  }, [rtc, iceConfig, newSession, teardown]);

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
