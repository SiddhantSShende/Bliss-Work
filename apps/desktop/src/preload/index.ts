import { contextBridge, ipcRenderer } from "electron";
import type { ServerEvent, ClientFrame, ControlFrame, PinResult } from "@taskboard/shared";

/**
 * Main-window preload. Exposes a fixed, typed surface on window.taskboard.
 * The renderer's event source is fed from the utilityProcess via "ws:event".
 */
const api = {
  /** Forward the current access token to the utilityProcess (for WS + task REST). */
  setToken: (token: string | null) => ipcRenderer.send("auth:token", token),

  /** Pin an acknowledged task to the desktop as a locked sticky note. Resolves
   *  with the authoritative pinned set (+ refusal reason, e.g. the on-screen
   *  cap was hit) so the renderer never optimistically lies about pin state. */
  pinTask: (taskId: string): Promise<PinResult> => ipcRenderer.invoke("task:pin", taskId),

  /** Task ids currently pinned to the desktop (source of truth = main process
   *  sticky-state.json). The renderer hydrates the Pin button from this. */
  listPinned: (): Promise<string[]> => ipcRenderer.invoke("task:list-pinned"),

  /** Subscribe to realtime ServerEvents relayed from the utilityProcess. */
  onWsEvent: (cb: (e: ServerEvent) => void) => {
    const handler = (_: unknown, e: ServerEvent) => cb(e);
    ipcRenderer.on("ws:event", handler);
    return () => ipcRenderer.removeListener("ws:event", handler);
  },

  /** Host asks the renderer for a fresh token (it holds the refresh cookie). */
  onTokenRequest: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("token:request", handler);
    return () => ipcRenderer.removeListener("token:request", handler);
  },

  /** Emitted when the app is opened via a taskboard:// invite deep-link. */
  onInviteDeepLink: (cb: (token: string) => void) => {
    const handler = (_: unknown, token: string) => cb(token);
    ipcRenderer.on("deeplink:invite", handler);
    return () => ipcRenderer.removeListener("deeplink:invite", handler);
  },

  /** Phase 10 WebRTC signaling, bridged to the ws-process socket: outbound
   *  frames go to main → ws-process; inbound rtc.* frames arrive on "rtc:frame". */
  rtc: {
    sendFrame: (frame: ClientFrame) => ipcRenderer.send("rtc:send", frame),
    onControl: (cb: (f: ControlFrame) => void) => {
      const handler = (_: unknown, f: ControlFrame) => cb(f);
      ipcRenderer.on("rtc:frame", handler);
      return () => ipcRenderer.removeListener("rtc:frame", handler);
    },
  },

  /** Phase 10 disk-backed receiver sink — streams WebRTC chunks to a file in
   *  main (Downloads) instead of buffering a Blob in renderer memory. */
  fileSink: {
    open: (transferId: string, fileName: string, size: number): Promise<void> =>
      ipcRenderer.invoke("filesink:open", { id: transferId, fileName, size }),
    write: (transferId: string, data: ArrayBuffer): Promise<void> =>
      ipcRenderer.invoke("filesink:write", { id: transferId, data }),
    finish: (transferId: string, expectedSha256: string): Promise<boolean> =>
      ipcRenderer.invoke("filesink:finish", { id: transferId, expectedSha256 }),
    abort: (transferId: string) => ipcRenderer.send("filesink:abort", { id: transferId }),
  },

  /** Phase 10 sender-side streaming sha256 — the renderer feeds file slices and
   *  main hashes them incrementally so a huge file isn't loaded into memory. */
  hash: {
    update: (id: string, data: ArrayBuffer): Promise<void> =>
      ipcRenderer.invoke("hash:update", { id, data }),
    digest: (id: string): Promise<string> => ipcRenderer.invoke("hash:digest", { id }),
  },
};

contextBridge.exposeInMainWorld("taskboard", api);
export type TaskboardBridge = typeof api;

/**
 * Phase 8 — chat-sticky bridge. Exposed under window.chatSticky so the
 * PinButton component can detect Electron and call into the main process.
 * On the web app this object simply isn't present and PinButton renders null.
 */
export interface ChatStickyPinBoot {
  threadId: string;
  conversationId: string;
  myUserId: string;
  peerUserId: string;
  peerUsername: string;
}

const chatStickyApi = {
  pin: (boot: ChatStickyPinBoot) => ipcRenderer.send("sticky:pin-chat", boot),
  unpin: (threadId: string) => ipcRenderer.send("sticky:unpin-chat", threadId),
  list: (): Promise<string[]> => ipcRenderer.invoke("sticky:list-pinned-chats"),
};

contextBridge.exposeInMainWorld("chatSticky", chatStickyApi);
export type ChatStickyBridge = typeof chatStickyApi;
