import type { ServerEvent, ClientFrame, ControlFrame, PinResult } from "@taskboard/shared";

/**
 * Platform abstraction — the one seam between the web shell and the Electron
 * renderer.
 *
 * Web: `eventSource` is undefined, so the app opens its own WebSocket.
 * Electron: a single WS lives in the main process `utilityProcess` (so it
 * survives the main window being minimized/closed). The renderer receives every
 * ServerEvent through `eventSource` instead of opening a second socket, and
 * forwards the access token via `persistToken` so the utilityProcess can auth.
 */
export interface EventSource {
  /** Ask the host (utilityProcess) to (re)connect its socket. */
  connect: () => void;
  /** Subscribe to forwarded ServerEvents; returns an unsubscribe fn. */
  subscribe: (cb: (e: ServerEvent) => void) => () => void;
}

/**
 * WebRTC signaling transport (Phase 10). Web backs this with the renderer's
 * own WsClient; Electron backs it with an IPC bridge to the ws-process socket.
 */
export interface RtcTransport {
  sendFrame: (frame: ClientFrame) => void;
  onControl: (cb: (f: ControlFrame) => void) => () => void;
}

/**
 * Receiver-side file sink (Phase 10). Web buffers chunks in memory and triggers
 * a browser download on finish; Electron streams each chunk straight to disk via
 * an IPC bridge to the main process, so a multi-GB transfer never has to fit in
 * renderer memory. One logical file per transferId.
 */
export interface FileSink {
  open: (transferId: string, fileName: string, size: number) => Promise<void>;
  write: (transferId: string, data: ArrayBuffer) => Promise<void>;
  /** Finalize + integrity-check: returns true if the received bytes' sha256
   *  matched `expectedSha256` (file kept), false on mismatch (file discarded). */
  finish: (transferId: string, expectedSha256: string) => Promise<boolean>;
  abort: (transferId: string) => void;
}

/** Host side of the desktop pinned-chat windows (Electron main process). */
export interface ChatStickyHost {
  pin: (boot: {
    threadId: string;
    conversationId: string;
    myUserId: string;
    peerUserId: string;
    peerUsername: string;
  }) => void;
  unpin: (threadId: string) => void;
  list: () => Promise<string[]>;
}

export interface PlatformConfig {
  kind: "web" | "electron";
  authBase: string;
  taskBase: string;
  notificationBase: string;
  messagingBase: string;
  /** External Integrations service (OAuth/webhooks/provider connections). */
  integrationsBase: string;
  wsUrl: string;
  /** "browser" for web, "hash" for the Electron file:// renderer. */
  router: "browser" | "hash";
  /** Present only in Electron: realtime events relayed from the utilityProcess. */
  eventSource?: EventSource;
  /** Present only in Electron: rtc.* signaling bridged from the ws-process. */
  rtc?: RtcTransport;
  /** Present only in Electron: disk-backed receiver sink (defaults to an
   *  in-memory blob + browser download on web). */
  fileSink?: FileSink;
  /** Present only in Electron: streaming sha256 of a (possibly huge) file,
   *  computed Node-side so the sender renderer never loads the whole file.
   *  Web falls back to an in-memory hash (its files are small). */
  hashFile?: (file: File) => Promise<string>;
  /** Present only in Electron: pin an acknowledged task to the desktop as a
   *  locked, always-on-top sticky note. Resolves with the authoritative pinned
   *  set (+ refusal reason). Absent on web (no persistent desktop window
   *  exists), so the "Pin to desktop" button hides itself there. */
  pinTask?: (taskId: string) => Promise<PinResult>;
  /** Present only in Electron: the task ids currently pinned to the desktop
   *  (source of truth = main process). Drives the Pin button's pinned state. */
  listPinned?: () => Promise<string[]>;
  /** Forward the current access token to the host (Electron → utilityProcess). */
  persistToken?: (token: string | null) => void;
  /** Present only in Electron: pin a DM thread to the desktop as a standalone
   *  always-available chat window. Absent on web, where PinButton renders null.
   *  Lives here rather than on `window` so the renderer and the desktop preload
   *  are typechecked against ONE definition. */
  chatSticky?: ChatStickyHost;
  /** Present only in Electron: the refresh token, read from the host's cookie
   *  jar / OS-encrypted store.
   *
   *  The packaged renderer loads from file://, so requests to the API origin are
   *  cross-site and Chromium will not attach the SameSite=lax refresh cookie —
   *  the token has to travel in the /auth/refresh body instead. Web leaves this
   *  undefined and keeps using the cookie, which is strictly safer. */
  getRefreshToken?: () => Promise<string | null>;
  /** Present only in Electron: mirror the refresh token to the host's encrypted
   *  store, or clear it (null) on logout so the session can't be resurrected. */
  persistRefreshToken?: (token: string | null) => void;
  /** Present only in Electron: the installed app's version (e.g. "0.1.42").
   *  Shown in Settings → About. A desktop build can sit far behind the web app
   *  with nothing on screen to say so — which is how "the desktop app is
   *  missing features" happens — so the running version has to be visible. */
  appVersion?: () => Promise<string>;
  /** Present only in Electron: check the update feed on demand. The automatic
   *  launch check stays silent when it finds nothing, which is right for a
   *  background task and useless for a user asking "am I up to date?". */
  checkForUpdates?: () => Promise<{
    status: "checking" | "available" | "up-to-date" | "downloading" | "unsupported" | "error";
    version?: string;
    message?: string;
  }>;
  /** Present only in Electron: open a URL in the user's DEFAULT browser.
   *  Google refuses OAuth inside an embedded webview (`disallowed_useragent`),
   *  so the authorize URL must leave the app entirely. Absent on web, where a
   *  same-tab redirect works and is what users expect. */
  openExternal?: (url: string) => void;
  /** Present only in Electron: the OAuth flow returning through the
   *  `taskboard://oauth` deep link. Mirrors the ?connected=/?error= query the
   *  web build reads off its own URL. Returns an unsubscribe fn. */
  onOAuthReturn?: (
    cb: (r: { connected?: string; error?: string }) => void,
  ) => () => void;
}

/** Retained for the index re-export; Electron sticky widgets are owned by main. */
export type StickyBridge = EventSource;
