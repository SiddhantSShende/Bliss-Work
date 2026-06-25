import { contextBridge, ipcRenderer } from "electron";

/**
 * Sticky-chat preload. The window receives a one-shot bootstrap describing
 * the thread + my identity + the peer, then a live stream of new messages
 * via "sticky-chat:message". Sends compose intent back via IPC; the
 * ws-process (utility process) actually owns the WS + REST clients so this
 * window stays display-only.
 */
export interface ChatStickyBootstrapPayload {
  threadId: string;
  conversationId: string;
  myUserId: string;
  peerUserId: string;
  peerUsername: string;
}

export interface ChatStickyMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
}

const api = {
  threadId: new URLSearchParams(location.search).get("threadId") ?? "",

  onBootstrap: (cb: (b: ChatStickyBootstrapPayload) => void) => {
    const handler = (_: unknown, b: ChatStickyBootstrapPayload) => cb(b);
    ipcRenderer.on("sticky-chat:bootstrap", handler);
    return () => ipcRenderer.removeListener("sticky-chat:bootstrap", handler);
  },

  /** Tell main this window has registered its bootstrap/message listeners and
   *  is ready. Main responds by (re)pushing the bootstrap. Guards against the
   *  did-finish-load push firing before this React effect subscribes, which
   *  would otherwise strand the window on "Loading thread…". */
  ready: () => ipcRenderer.send("sticky-chat:ready", api.threadId),

  onMessage: (cb: (m: ChatStickyMessage) => void) => {
    const handler = (_: unknown, m: ChatStickyMessage) => cb(m);
    ipcRenderer.on("sticky-chat:message", handler);
    return () => ipcRenderer.removeListener("sticky-chat:message", handler);
  },

  /** Forward a reply intent to the utility process. clientMsgId is
   *  generated here so optimistic-rendering in this window can dedupe
   *  against the server echo. */
  send: (payload: { threadId: string; body: string; clientMsgId: string }) =>
    ipcRenderer.send("sticky-chat:send", payload),

  /** Unpin this thread (closes the window via main-process side effect). */
  unpin: (threadId: string) => ipcRenderer.send("sticky-chat:unpin", threadId),
};

contextBridge.exposeInMainWorld("stickyChat", api);
export type StickyChatPreload = typeof api;
