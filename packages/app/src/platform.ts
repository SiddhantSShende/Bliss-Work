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

export interface PlatformConfig {
  kind: "web" | "electron";
  authBase: string;
  taskBase: string;
  notificationBase: string;
  messagingBase: string;
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
}

/** Retained for the index re-export; Electron sticky widgets are owned by main. */
export type StickyBridge = EventSource;
