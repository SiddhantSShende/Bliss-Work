/**
 * Cross-tab auth coordination via BroadcastChannel.
 *
 * Why this exists
 * ---------------
 * The refresh token ROTATES on every /auth/refresh and the backend revokes the
 * whole token family if it ever sees a rotated (reused) token — a deliberate
 * theft-detection measure. Two tabs of the same origin share ONE refresh cookie,
 * so if they refresh concurrently (e.g. both bootstrapping on load, or both
 * hitting an expired access token) one presents the just-rotated token → reuse
 * detected → BOTH tabs get logged out.
 *
 * The fix has two halves:
 *   1. refresh.ts serializes refreshes across tabs with the Web Locks API, so two
 *      tabs never present the same cookie value concurrently.
 *   2. This module mirrors a successful refresh / login / logout to sibling tabs
 *      so they adopt the fresh session instead of each rotating the token again,
 *      and so signing out (or being signed out) in one tab propagates to all.
 *
 * Security note: BroadcastChannel is same-origin only and the access token is
 * already in each tab's JS memory, so sharing it here does not widen the XSS
 * threat model (and the token is never written to localStorage/sessionStorage).
 */
import type { SessionDTO } from "@taskboard/shared";
import { useSession } from "../store/session";

const CHANNEL_NAME = "tb-auth";

type AuthMessage =
  | { type: "session"; session: SessionDTO }
  | { type: "logout" }
  | { type: "request-session" };

let channel: BroadcastChannel | null = null;

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

// The last session RECEIVED FROM A SIBLING tab, plus when. refresh.ts reads this
// to skip a redundant token rotation when another tab refreshed moments ago (the
// concurrent-bootstrap case). Deliberately NOT populated by this tab's own
// refresh: a tab must never short-circuit on its own just-fetched token (that
// would defeat the API 401-retry, which needs a genuinely new token). Only a
// peer's freshly-broadcast session is adopted here.
let siblingSession: SessionDTO | null = null;
let siblingSessionAt = 0;

/** A sibling tab's session if it was broadcast within `windowMs`, else null. */
export function getRecentSession(windowMs = 3000): SessionDTO | null {
  return siblingSession && Date.now() - siblingSessionAt < windowMs ? siblingSession : null;
}

/** Broadcast a freshly-obtained session to sibling tabs. */
export function broadcastSession(session: SessionDTO): void {
  getChannel()?.postMessage({ type: "session", session } satisfies AuthMessage);
}

/** Broadcast an explicit sign-out so sibling tabs clear too. */
export function broadcastLogout(): void {
  getChannel()?.postMessage({ type: "logout" } satisfies AuthMessage);
}

/** Resolved (by the "session" branch below) whenever a "request-session"
 *  round trip is pending — see requestSession(). Keyed by nothing; every
 *  pending requester wants the same answer, whichever tab it comes from. */
const pendingSessionRequests = new Set<(s: SessionDTO | null) => void>();

/**
 * Ask sibling tabs/windows for the current session and wait for one to
 * answer, rather than assuming a broadcast that already happened to arrive
 * in time. Built for the Electron meeting window (see PlatformConfig's
 * `bootstrapFromPeerSession`): its own credential IPC is deliberately gated
 * to the main window only, so this BroadcastChannel round trip — not a
 * widened IPC boundary — is how it learns the session the main window
 * already holds. Resolves null (never rejects) if nothing answers within
 * `timeoutMs`, or if BroadcastChannel itself is unavailable.
 */
export function requestSession(timeoutMs = 1500): Promise<SessionDTO | null> {
  const ch = getChannel();
  if (!ch) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (s: SessionDTO | null) => {
      if (settled) return;
      settled = true;
      pendingSessionRequests.delete(settle);
      resolve(s);
    };
    pendingSessionRequests.add(settle);
    setTimeout(() => settle(null), timeoutMs);
    ch.postMessage({ type: "request-session" } satisfies AuthMessage);
  });
}

let installed = false;

/** Install the listener once at app start. Idempotent. */
export function installAuthChannel(): void {
  if (installed) return;
  const ch = getChannel();
  if (!ch) return;
  installed = true;
  ch.onmessage = (ev: MessageEvent<AuthMessage>) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === "session") {
      // Adopt the sibling's fresh session (in-memory only) and cache it so this
      // tab's own queued refresh can short-circuit instead of rotating again.
      siblingSession = msg.session;
      siblingSessionAt = Date.now();
      useSession.getState().setSession({
        user: msg.session.user,
        accessToken: msg.session.accessToken,
        expiresIn: msg.session.expiresIn,
      });
      for (const settle of pendingSessionRequests) settle(msg.session);
      pendingSessionRequests.clear();
    } else if (msg.type === "logout") {
      siblingSession = null;
      useSession.getState().clear();
    } else if (msg.type === "request-session") {
      // Answer only if THIS tab actually holds a session — an anonymous or
      // still-loading tab has nothing to offer, and broadcasting a null/empty
      // session here would incorrectly settle a peer's request with "no one
      // is signed in" while this same tab is still resolving its own.
      const s = useSession.getState();
      if (s.status === "authed" && s.user && s.accessToken) {
        broadcastSession({
          user: s.user,
          accessToken: s.accessToken,
          expiresIn: Math.max(0, Math.round(((s.expiresAt ?? Date.now()) - Date.now()) / 1000)),
        });
      }
    }
  };
}
