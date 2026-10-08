import type { QueryClient } from "@tanstack/react-query";
import type { WsStatus } from "@taskboard/shared";

/**
 * Cache resync after the WebSocket comes back.
 *
 * The gateway replays at most the last 200 events on reconnect. A laptop that
 * slept overnight, a long network loss or a gateway deploy can miss more than
 * that (or events older than the outbox), and `refetchOnWindowFocus` is off, so
 * without this the open screens would keep showing stale messages, inbox and
 * tasks until something else happened to refetch them.
 *
 * Only roots whose contents are PUSHED over the socket are listed. Everything
 * else is left alone on purpose — e.g. `["mail", id]` is a composer's resumed
 * draft (staleTime Infinity precisely so a refetch cannot land mid-sentence) and
 * `["staticMap", …]` is an immutable image.
 */
const RESYNC_ROOTS: ReadonlySet<string> = new Set([
  "conversations",
  "messages",
  "reactions",
  "tasks",
  "calls",
  "callHistory",
  "channelCalls",
  "onCall",
  "notifications",
  "unreadCounts",
  "channels",
  "channelMessages",
  "channelReadReceipts",
  "channelReactions",
  "channelRoster",
  "unifiedInbox",
  "inboxPeers",
  "inboxPeerFeed",
  "thread",
  "threadMessages",
  "stickyPinStates",
]);

/** Wait for the gateway's replay burst to land (and for a flapping connection
 *  to settle) before refetching, so a flaky link costs one resync, not many. */
export const RESYNC_DELAY_MS = 1_000;

export interface StatusSource {
  onStatus(handler: (s: WsStatus) => void): () => void;
}

/**
 * Invalidates the pushed-data queries when `ws` reaches "open" after having
 * been down — NOT on the first connect, where nothing has been loaded yet that
 * the socket could have missed. `invalidateQueries` refetches only the ACTIVE
 * matches; inactive ones are marked stale and refetch when next mounted.
 *
 * Returns the unsubscribe/cancel function.
 */
export function watchReconnectResync(
  ws: StatusSource,
  qc: Pick<QueryClient, "invalidateQueries">,
  delayMs: number = RESYNC_DELAY_MS,
): () => void {
  let everOpen = false;
  let wasDown = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const off = ws.onStatus((s) => {
    if (s === "closed") {
      wasDown = true;
      return;
    }
    if (s !== "open") return;
    // A connect that only succeeded after earlier failed attempts is still the
    // first connect: nothing was loaded through an earlier open socket.
    const reconnected = everOpen && wasDown;
    everOpen = true;
    wasDown = false;
    if (!reconnected) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void qc.invalidateQueries({
        predicate: (q) => RESYNC_ROOTS.has(String(q.queryKey[0])),
      });
    }, delayMs);
  });

  return () => {
    off();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
