import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntime } from "./runtime";

// Tuned to feel instant without spamming the gateway: re-emit "start" at most
// once per START_THROTTLE_MS while actively typing, emit "stop" after
// IDLE_STOP_MS of keyboard silence, and clear the peer's indicator if no frame
// arrives within PEER_EXPIRE_MS (covers a dropped "stop").
const START_THROTTLE_MS = 3000;
const IDLE_STOP_MS = 4000;
const PEER_EXPIRE_MS = 6000;

/**
 * 1:1 typing indicators over the rtc.* signaling transport (ephemeral — never
 * persisted or replayed). Returns whether the peer is currently typing, plus an
 * `onType` to call on every local keystroke and a `stop` to call when a message
 * is sent. No-ops safely when conversationId/peerId are absent (works on web and
 * Electron, since the transport relays control frames generically).
 */
export function useChatTyping(conversationId: string, peerId: string | undefined) {
  const { rtc } = useRuntime();
  const [peerTyping, setPeerTyping] = useState(false);

  // ── receive: the peer's typing state for THIS conversation ──────────────────
  useEffect(() => {
    setPeerTyping(false);
    if (!conversationId || !peerId) return;
    let expire: ReturnType<typeof setTimeout> | undefined;
    const off = rtc.onControl((f) => {
      if (f.type !== "typing" || f.conversationId !== conversationId || f.fromUserId !== peerId) return;
      if (expire) clearTimeout(expire);
      if (f.state === "stop") {
        setPeerTyping(false);
        return;
      }
      setPeerTyping(true);
      expire = setTimeout(() => setPeerTyping(false), PEER_EXPIRE_MS);
    });
    return () => {
      off();
      if (expire) clearTimeout(expire);
    };
  }, [rtc, conversationId, peerId]);

  // ── send: throttled "start" while typing, "stop" on idle / send / unmount ───
  const lastStart = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stop = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = undefined;
    }
    if (!conversationId || !peerId || lastStart.current === 0) return;
    lastStart.current = 0;
    rtc.sendFrame({ type: "typing", toUserId: peerId, conversationId, state: "stop" });
  }, [rtc, conversationId, peerId]);

  const onType = useCallback(() => {
    if (!conversationId || !peerId) return;
    const now = Date.now();
    if (now - lastStart.current > START_THROTTLE_MS) {
      lastStart.current = now;
      rtc.sendFrame({ type: "typing", toUserId: peerId, conversationId, state: "start" });
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(stop, IDLE_STOP_MS);
  }, [rtc, conversationId, peerId, stop]);

  // Stop on unmount / conversation switch so the peer's indicator can't stick on.
  useEffect(() => stop, [stop]);

  return { peerTyping, onType, stop };
}
