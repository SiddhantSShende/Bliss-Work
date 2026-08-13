/**
 * One session id per CLIENT INSTANCE, shared across that browser's tabs.
 *
 * Without this, five open tabs are five sessions: "Alice signed in 5 times
 * today, was online 5x8 hours" — a number that is not merely imprecise but
 * wrong, and wrong in the direction that makes someone look busier than they
 * are. The id is negotiated over BroadcastChannel (same-origin, already used for
 * auth in authChannel.ts) so whichever tab opens first defines the session and
 * later tabs adopt it.
 *
 * The id lives in MEMORY ONLY, never localStorage — matching the deliberate
 * posture that this app persists no session material to disk. The cost is that
 * closing every tab ends the session, which is exactly the behaviour we want:
 * the browser is closed, so the person is gone.
 */
const CHANNEL_NAME = "tb-telemetry";

type Message =
  | { type: "claim"; sessionId: string }   // "I have a session, here it is"
  | { type: "ask" }                        // "does anyone have one?"
  | { type: "end" };                       // signed out — drop it everywhere

let channel: BroadcastChannel | null = null;
let sessionId: string | null = null;
let listeners: ((id: string | null) => void)[] = [];

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null; // unsupported / SSR
  if (!channel) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      channel = null;
    }
  }
  return channel;
}

function post(msg: Message): void {
  try {
    getChannel()?.postMessage(msg);
  } catch {
    /* a broadcast failure must never break the caller */
  }
}

/** Start listening for sibling tabs. Idempotent; returns a teardown function. */
export function installTelemetrySession(): () => void {
  const ch = getChannel();
  if (!ch) return () => {};

  const onMessage = (ev: MessageEvent<Message>) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ask") {
      // Only answer if we actually have one, so the newest tab does not adopt
      // a null and then think it is the originator.
      if (sessionId) post({ type: "claim", sessionId });
    } else if (msg.type === "claim") {
      // Last write wins, deliberately: the server is the authority on session
      // identity (it can hand back a NEW id when the old one was swept), and a
      // tab that just learned a fresh id from an ack should win over a stale one.
      if (msg.sessionId !== sessionId) {
        sessionId = msg.sessionId;
        listeners.forEach((fn) => fn(sessionId));
      }
    } else if (msg.type === "end") {
      sessionId = null;
      listeners.forEach((fn) => fn(null));
    }
  };

  ch.addEventListener("message", onMessage);
  post({ type: "ask" });
  return () => {
    ch.removeEventListener("message", onMessage);
  };
}

export function getSessionId(): string | null {
  return sessionId;
}

/** Adopt an id (from a server ack) and tell every sibling tab. */
export function setSessionId(id: string | null): void {
  if (id === sessionId) return;
  sessionId = id;
  if (id) post({ type: "claim", sessionId: id });
  listeners.forEach((fn) => fn(sessionId));
}

/** Sign-out: the session is over for every tab, not just this one. */
export function endSession(): void {
  sessionId = null;
  post({ type: "end" });
  listeners.forEach((fn) => fn(null));
}

export function onSessionIdChange(fn: (id: string | null) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}
