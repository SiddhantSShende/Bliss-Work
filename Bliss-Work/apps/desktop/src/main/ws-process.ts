/**
 * utilityProcess: the SINGLE WebSocket + task REST client. Runs independently of
 * any window so realtime task updates keep flowing (and sticky widgets stay
 * live) even when the main window is closed or minimized.
 *
 * Protocol with the main process (via parentPort):
 *   in : {type:'config', ...baseUrls}, {type:'token', token}, {type:'intent', taskId, action}
 *   out: {type:'event', event}, {type:'sticky', tasks}, {type:'need-token'}
 */
import { WebSocket as NodeWebSocket } from "ws";
import { ApiClient, ApiError, WsClient, type ServerEvent, type StickyTaskDTO, type ClientFrame, type WsEventMeta } from "@taskboard/shared";
import type { Endpoints } from "../shared/endpoints";
import { buildApiConfig } from "./ws-api-config";
import {
  createRefreshGate,
  overlayPendingPins,
  shouldRefreshSticky,
  type PinStates,
} from "./sticky-refresh";
import { sendStickyChatReply, toStickyChatMessage } from "../shared/sticky-chat-messages";

const parent = (process as unknown as { parentPort: NodeJS.EventEmitter & { postMessage: (m: unknown) => void } }).parentPort;

let token: string | null = null;
let api: ApiClient | null = null;
let ws: WsClient | null = null;
const pendingToken: ((t: string) => void)[] = [];
// Phase 8: pinned-chat fan-out. Set of threadIds whose MessageCreated events
// should be forwarded to the main process so it can route them to the
// matching sticky-chat window. Main owns the window lifetime; ws-process
// owns the WS connection.
const pinnedThreads = new Set<string>();

function send(msg: unknown) {
  parent.postMessage(msg);
}

/** How long main gets to answer a token request, and how many times it is asked. */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REQUEST_ATTEMPTS = 3;

/**
 * Ask main (→ the hidden main renderer, the session's only refresher) for a
 * fresh access token. That renderer can be gone or still loading, so an
 * unanswered request is re-sent a few times and then resolves "" — which every
 * caller already treats as "no token" — instead of hanging the socket's
 * reconnect (or a task action's 401 retry) forever.
 */
function requestToken(): Promise<string> {
  return new Promise<string>((resolve) => {
    let attempts = 0;
    const ask = () => {
      const settle = (t: string) => {
        clearTimeout(timer);
        resolve(t);
      };
      const timer = setTimeout(() => {
        pendingToken.splice(pendingToken.indexOf(settle), 1);
        if (++attempts < TOKEN_REQUEST_ATTEMPTS) ask();
        else resolve("");
      }, TOKEN_REQUEST_TIMEOUT_MS);
      pendingToken.push(settle);
      send({ type: "need-token" });
    };
    ask();
  });
}

function build(cfg: Endpoints) {
  api = new ApiClient(
    buildApiConfig(cfg, {
      getToken: () => token,
      // On a 401 (expired token), ask main for a fresh one — same path the WS uses
      // (need-token → renderer refreshes via single-flight refreshSession → forwards
      // the new token back here). Lets sticky-button actions self-heal instead of
      // silently failing once the token ages out.
      refreshToken: async () => (await requestToken()) || null,
      // TEMPORARY, see ApiConfig.clientId / authDiagLog in client.ts — this
      // process's requests (sticky-chat reply, sticky pin/unpin, task actions)
      // are the ones suspected of racing `token` before main's first push; this
      // tag is how the "missing bearer token" investigation's logs tell them
      // apart from the renderer's own, separately-authed ApiClient.
      clientId: "desktop-utility-process",
    }),
  );
  ws = new WsClient({
    url: cfg.wsUrl,
    getToken: () => token ?? "",
    refreshToken: requestToken,
    WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket,
  });
  ws.on(onEvent);
  // Sole observability into this process's independent WS connection — without
  // it, a connection stuck in "connecting" (see WsClient's CONNECT_TIMEOUT_MS)
  // or repeatedly bouncing looks identical to "nothing has happened yet," both
  // on screen and in this log. No payload/token here — status only.
  ws.onStatus((s) => console.log("[ws] status:", s));
  // Phase 10: relay inbound rtc.* signaling to main → renderer's WebRTC layer.
  ws.onControl((f) => send({ type: "rtc-frame", frame: f }));
}

/** Delays (ms) between refreshSticky's own retry attempts, on top of whatever
 *  retry api.tasksSticky() already does internally for an expired token. A
 *  task.* event fires this exactly once per change, so a single transient
 *  failure here — not "offline", just one dropped request — used to mean the
 *  ONE fetch that would have auto-pinned a freshly assigned task silently
 *  never happened, with nothing to trigger it again until some unrelated
 *  task.* event came in (or the next launch). Short and few: this gates how
 *  fast a legitimate new allocation appears, so it must not turn a real
 *  assignment into a multi-minute wait. */
const STICKY_REFRESH_RETRY_DELAYS_MS = [500, 1500];

/** What one successful /tasks/sticky + /sticky/pins read produced. */
interface StickyRead {
  tasks: StickyTaskDTO[];
  /** The user's pinned / explicitly-unpinned task ids as sticky-svc holds them.
   *  null when sticky-svc is unconfigured or was unreachable. */
  pins: PinStates | null;
}

/**
 * Pin/unpin requests this process has sent and not yet seen settle, by task.
 * Only ever overlaid on a read (see overlayPendingPins); never persisted.
 */
const pendingPinWrites = new Map<string, "PINNED" | "UNPINNED">();

/** Only the newest refresh may publish — see createRefreshGate. */
const stickyRefreshGate = createRefreshGate<StickyRead>();

/** Hand a read to main, and tell sticky-svc these reached a screen. */
function publishSticky({ tasks, pins }: StickyRead) {
  send({ type: "sticky", tasks, pins: pins ?? undefined });

  // Tell sticky-svc these reached a screen, so the delivery watchdog stops
  // nudging about them. Fire-and-forget: a failure costs one redundant
  // nudge, which is far cheaper than letting it break the notes.
  if (pins) {
    const actionable = new Set(tasks.map((t) => t.taskId));
    for (const taskId of pins.pinned) {
      if (actionable.has(taskId)) void api?.stickyAckDelivery(taskId).catch(() => {});
    }
  }
}

/**
 * Re-read which task notes belong on this desktop, and tell main.
 *
 * ── Two sources, with two different jobs ────────────────────────────────────
 * task-svc's /tasks/sticky is the content source and the authority on what is
 * actionable: only it can take a note away for good (completed / ignored /
 * left), via `prunePinned` in the main process.
 *
 * sticky-svc's /sticky/pins is the authority on what the USER chose — pinned or
 * explicitly unpinned — because it is the one record every device of theirs
 * shares. Main mirrors it onto this machine (StickyManager.applyServerPinState)
 * and it overrules the local files, which are only an offline cache.
 *
 * The pin read is advisory in one direction only: a sticky-svc outage, an
 * unconfigured build or a failed read yields `pins: null`, and main then keeps
 * whatever it has — it never wipes a desktop off an absent answer.
 */
async function refreshSticky() {
  if (!api || !token) return;
  const ticket = stickyRefreshGate.begin();
  for (let attempt = 0; ; attempt++) {
    try {
      const [tasksResult, pinsResult] = await Promise.allSettled([
        api.tasksSticky(),
        api.stickyPinStates(),
      ]);
      // The task list is load-bearing; a failure here is a real failure and
      // takes the retry path below.
      if (tasksResult.status === "rejected") throw tasksResult.reason;

      // The pin set is advisory. A rejection is logged once and otherwise
      // ignored — it must not stop the notes appearing.
      if (pinsResult.status === "rejected") {
        console.warn(
          "[sticky] pin authority unavailable, using task list alone:",
          pinsResult.reason instanceof Error ? pinsResult.reason.message : pinsResult.reason,
        );
      }
      const read: StickyRead = {
        tasks: tasksResult.value,
        pins:
          pinsResult.status === "fulfilled" && pinsResult.value
            ? overlayPendingPins(pinsResult.value, pendingPinWrites)
            : null,
      };

      // Only the newest refresh publishes: a slower older one landing after it
      // would re-pin a task the newer list had just dropped as completed or
      // ignored. An older one is kept as a spare instead, for the case below.
      if (stickyRefreshGate.succeeded(ticket, read)) publishSticky(read);
      return;
    } catch (e) {
      // A newer refresh (or a sign-out) owns the outcome now; retrying this one
      // would only add load.
      if (!stickyRefreshGate.isCurrent(ticket)) return;
      const delay = STICKY_REFRESH_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        // Genuinely offline, or the server is down — keep the last known list
        // rather than wiping pinned notes off a transient failure. The next
        // task.* event (or app launch) tries again.
        console.error("[sticky] refresh failed after retries:", e instanceof Error ? e.message : e);
        // The newest refresh has nothing to publish, but an older one that did
        // succeed may: better than leaving the notes stale until that next event.
        const spare = stickyRefreshGate.gaveUp(ticket);
        if (spare) publishSticky(spare);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Retry delays for the user's own pin/unpin write. Short and few, like the
 *  refresh retries: the note is already gone locally, this makes it durable. */
const PIN_WRITE_RETRY_DELAYS_MS = [500, 1500];

/**
 * Send the user's explicit pin/unpin to sticky-svc — what makes it durable and
 * shared — then re-read.
 *
 * If every attempt fails (offline, service down) nothing is queued: the next
 * read is server truth and puts the note back. That is the honest outcome, since
 * the other devices never heard about the Unpin, and the alternative — a
 * device-local choice nothing else knows about — is the bug this replaces.
 */
async function writePin(taskId: string, pinned: boolean) {
  if (!api) return;
  pendingPinWrites.set(taskId, pinned ? "PINNED" : "UNPINNED");
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await (pinned ? api.stickyPin(taskId) : api.stickyUnpin(taskId));
        return;
      } catch (e) {
        // A 4xx is an answer (not assigned to me / already finished), not a
        // blip: retrying cannot change it.
        const definitive = e instanceof ApiError && e.status >= 400 && e.status < 500;
        const delay = definitive ? undefined : PIN_WRITE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          console.error("[sticky] pin write failed after retries:", e instanceof Error ? e.message : e);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } finally {
    pendingPinWrites.delete(taskId);
    await refreshSticky();
  }
}

function onEvent(e: ServerEvent, meta: WsEventMeta) {
  // `replayed` rides along to the renderer, which is where the toasts and the
  // sticky auto-pin live. Without it every launch re-announces the connect-time
  // catch-up burst — up to 200 events — as if it had all just happened.
  send({ type: "event", event: e, replayed: meta.replayed });
  if (shouldRefreshSticky(e.type)) void refreshSticky();

  // Phase 8: forward MessageCreated events for pinned threads to the main
  // process so each one lands inside the corresponding chat-sticky window.
  // Default threadId ← conversationId for legacy producers.
  if (e.type === "message.created") {
    const bucket = e.threadId ?? e.conversationId;
    if (pinnedThreads.has(bucket)) {
      send({
        type: "sticky-chat-message",
        threadId: bucket,
        // clientMsgId rides along so the window can match this echo to the
        // optimistic bubble of a reply it sent itself.
        payload: toStickyChatMessage(e),
      });
    }
  }
}

parent.on("message", async (raw: unknown) => {
  const m = ((raw as { data?: Record<string, unknown> }).data ?? raw) as Record<string, unknown>;
  switch (m.type) {
    case "config":
      build(m as never);
      break;
    case "rtc-send":
      // Phase 10: outbound WebRTC signaling frame from the renderer.
      ws?.sendFrame(m.frame as ClientFrame);
      break;
    case "token": {
      token = (m.token as string) ?? null;
      while (pendingToken.length) pendingToken.shift()!(token ?? "");
      if (token) {
        await ws?.connect();
        await refreshSticky();
        break;
      }
      // No token means SIGNED OUT, and this socket is what the gateway counts
      // as presence. Leaving it open — which is what happened before, because
      // this process is deliberately independent of the window — kept the
      // person online to their whole organisation with the app signed out in
      // front of them. close() also parks the reconnect loop, so nothing
      // re-dials with an empty token; the next `token` message reopens it.
      ws?.close();
      // Drop any refresh still in flight for the user who just left.
      stickyRefreshGate.cancel();
      pendingPinWrites.clear();
      break;
    }
    case "intent": {
      if (api) {
        try {
          await api.taskAction(m.taskId as string, m.action as never);
        } catch {
          /* surfaced via event refetch */
        }
        await refreshSticky();
      }
      break;
    }
    case "pin-write": {
      if (typeof m.taskId === "string" && m.taskId && typeof m.pinned === "boolean") {
        await writePin(m.taskId, m.pinned);
      }
      break;
    }
    case "sticky-chat-subscribe": {
      if (typeof m.threadId === "string") pinnedThreads.add(m.threadId);
      break;
    }
    case "sticky-chat-unsubscribe": {
      if (typeof m.threadId === "string") pinnedThreads.delete(m.threadId);
      break;
    }
    case "send-dm": {
      // Reply from a chat-sticky window. Use the post-Phase-0 caller-supplied
      // clientMsgId so the sticky's optimistic bubble dedupes cleanly with
      // the server echo (the WS MessageCreated handler in the bridge will
      // see the same clientMsgId).
      // A failure is reported back so the window can show the bubble as unsent.
      await sendStickyChatReply(
        api ? api.replyToThread.bind(api) : undefined,
        { threadId: m.threadId as string, body: m.body as string, clientMsgId: m.clientMsgId as string },
        (threadId, clientMsgId) => send({ type: "sticky-chat-send-failed", threadId, clientMsgId }),
      );
      break;
    }
  }
});
