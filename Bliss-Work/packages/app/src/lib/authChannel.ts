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
  | { type: "logout" };

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
    } else if (msg.type === "logout") {
      siblingSession = null;
      useSession.getState().clear();
    }
  };
}
