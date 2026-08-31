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
import { ApiClient, WsClient, type ServerEvent, type StickyTaskDTO, type ClientFrame, type WsEventMeta } from "@taskboard/shared";

const parent = (process as unknown as { parentPort: NodeJS.EventEmitter & { postMessage: (m: unknown) => void } }).parentPort;

let token: string | null = null;
let api: ApiClient | null = null;
let ws: WsClient | null = null;
let stickyTasks: StickyTaskDTO[] = [];
const pendingToken: ((t: string) => void)[] = [];
// Phase 8: pinned-chat fan-out. Set of threadIds whose MessageCreated events
// should be forwarded to the main process so it can route them to the
// matching sticky-chat window. Main owns the window lifetime; ws-process
// owns the WS connection.
const pinnedThreads = new Set<string>();

function send(msg: unknown) {
  parent.postMessage(msg);
}

function requestToken(): Promise<string> {
  send({ type: "need-token" });
  return new Promise<string>((resolve) => pendingToken.push(resolve));
}

function build(cfg: {
  authBase: string;
  taskBase: string;
  messagingBase: string;
  telemetryBase: string;
  notificationBase: string;
  wsUrl: string;
}) {
  api = new ApiClient({
    authBase: cfg.authBase,
    taskBase: cfg.taskBase,
    messagingBase: cfg.messagingBase,
    telemetryBase: cfg.telemetryBase,
    notificationBase: cfg.notificationBase,
    presenceBase: cfg.wsUrl.replace(/^ws/, "http").replace(/\/ws\/?$/, ""),
    getToken: () => token,
    // On a 401 (expired token), ask main for a fresh one — same path the WS uses
    // (need-token → renderer refreshes via single-flight refreshSession → forwards
    // the new token back here). Lets sticky-button actions self-heal instead of
    // silently failing once the token ages out.
    refreshToken: async () => (await requestToken()) || null,
  });
  ws = new WsClient({
    url: cfg.wsUrl,
    getToken: () => token ?? "",
    refreshToken: requestToken,
    WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket,
  });
  ws.on(onEvent);
  // Phase 10: relay inbound rtc.* signaling to main → renderer's WebRTC layer.
  ws.onControl((f) => send({ type: "rtc-frame", frame: f }));
}

async function refreshSticky() {
  if (!api || !token) return;
  try {
    stickyTasks = await api.tasksSticky();
    send({ type: "sticky", tasks: stickyTasks });
  } catch {
    /* offline; keep last known */
  }
}

function onEvent(e: ServerEvent, meta: WsEventMeta) {
  // `replayed` rides along to the renderer, which is where the toasts and the
  // sticky auto-pin live. Without it every launch re-announces the connect-time
  // catch-up burst — up to 200 events — as if it had all just happened.
  send({ type: "event", event: e, replayed: meta.replayed });
  if (e.type.startsWith("task.")) void refreshSticky();

  // Phase 8: forward MessageCreated events for pinned threads to the main
  // process so each one lands inside the corresponding chat-sticky window.
  // Default threadId ← conversationId for legacy producers.
  if (e.type === "message.created") {
    const bucket = e.threadId ?? e.conversationId;
    if (pinnedThreads.has(bucket)) {
      send({
        type: "sticky-chat-message",
        threadId: bucket,
        payload: {
          id: e.messageId,
          senderId: e.senderId,
          body: e.body,
          createdAt: e.occurredAt,
        },
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
      if (!api) break;
      try {
        await api.replyToThread(m.threadId as string, m.body as string, {
          clientMsgId: m.clientMsgId as string,
        });
      } catch {
        /* swallow; user can retry */
      }
      break;
    }
  }
});
