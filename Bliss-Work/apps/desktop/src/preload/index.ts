import { contextBridge, ipcRenderer } from "electron";
import { hasLocationSettingsPage } from "../shared/location-settings";
import type { ServerEvent, ClientFrame, ControlFrame, PinResult, WsEventMeta } from "@taskboard/shared";

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

  /** Clear a task's desktop note and remember that it was cleared, so the
   *  auto-pin does not re-float it on the next launch. Called when the task is
   *  opened — opening it is what "reading the notification" means. */
  dismissSticky: (taskId: string) => ipcRenderer.send("sticky:dismiss", taskId),

  /** Subscribe to realtime ServerEvents relayed from the utilityProcess. */
  onWsEvent: (cb: (e: ServerEvent, meta?: WsEventMeta) => void) => {
    // `meta.replayed` distinguishes the connect-time catch-up burst from live
    // traffic. The socket lives in the utilityProcess and the toasts fire here,
    // so the flag has to make the trip.
    const handler = (_: unknown, e: ServerEvent, meta?: WsEventMeta) => cb(e, meta);
    ipcRenderer.on("ws:event", handler);
    return () => ipcRenderer.removeListener("ws:event", handler);
  },

  /** The refresh token, read from the Electron cookie jar / OS-encrypted store.
   *
   *  The packaged renderer runs on file://, which makes every request to the API
   *  origin cross-site, so Chromium will not attach the SameSite=lax refresh
   *  cookie. /auth/refresh also accepts the token in the request body, so the
   *  renderer fetches it from here and sends it explicitly. See
   *  src/main/session-token.ts for the full reasoning. */
  getRefreshToken: (): Promise<string | null> => ipcRenderer.invoke("auth:refresh-token"),

  /** Mirror a refresh token to the encrypted store, or clear it (null) on logout. */
  setRefreshToken: (token: string | null) => ipcRenderer.send("auth:set-refresh-token", token),

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

  /** Open an https URL in the system browser. Used for OAuth: Google rejects
   *  embedded webviews, so the consent screen has to leave the app. Main
   *  re-validates the scheme — never trust the renderer with a shell call. */
  openExternal: (url: string) => ipcRenderer.send("shell:open-external", url),

  /** Whether this build can resolve a PRECISE location. False means location
   *  sharing still works but resolves to a city-level IP fix. */
  hasPreciseLocation: (): Promise<boolean> => ipcRenderer.invoke("geo:precise"),

  /** Open the OS page where location access for desktop apps is granted.
   *
   *  UNDEFINED on platforms that have no such page (Linux). Absent rather than
   *  a no-op on purpose: the renderer treats this as a capability check and
   *  renders no button at all, which is honest — a Linux desktop has no OS
   *  location provider whose permission could be changed. Takes no argument;
   *  main owns the URL (see shared/location-settings.ts). */
  openLocationSettings: hasLocationSettingsPage()
    ? (): Promise<boolean> => ipcRenderer.invoke("geo:open-settings")
    : undefined,

  /** Emitted when the app detects and refuses a screenshot attempt.
   *
   *  The message is fixed; the payload says WHAT was pressed and whether main
   *  already wrote the attempt to the activity record. The renderer reports it
   *  itself when main did not, so a user who declined the activity agent still
   *  leaves a server-side trace of a refused capture. */
  onScreenshotBlocked: (cb: (info: { chord: string; recorded: boolean }) => void) => {
    const handler = (_: unknown, info: { chord: string; recorded: boolean }) => cb(info);
    ipcRenderer.on("security:screenshot-blocked", handler);
    return () => ipcRenderer.removeListener("security:screenshot-blocked", handler);
  },

  /** Emitted when an OAuth flow returns via taskboard://oauth?connected=… */
  onOAuthReturn: (cb: (r: { connected?: string; error?: string }) => void) => {
    const handler = (_: unknown, r: { connected?: string; error?: string }) => cb(r);
    ipcRenderer.on("deeplink:oauth", handler);
    return () => ipcRenderer.removeListener("deeplink:oauth", handler);
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

  /** Which build am I running?
   *
   *  Surfaced in Settings → About. This matters more than it looks: a desktop
   *  app can sit months behind the web app with nothing on screen to say so —
   *  which is exactly how "the desktop app is missing features" happens — and
   *  a support conversation has no way to establish which build a user is on. */
  appVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),

  /** Ask the updater to check now, rather than waiting for the next launch.
   *  Resolves with what happened so the UI can say something specific. */
  checkForUpdates: (): Promise<{
    status: "checking" | "available" | "up-to-date" | "downloading" | "unsupported" | "error";
    version?: string;
    message?: string;
  }> => ipcRenderer.invoke("app:check-updates"),

  /**
   * Desktop activity agent — CONSENT AND PAIRING ONLY.
   *
   * Note what is absent: there is no way to read a sample, no way to read the
   * pairing secret back, and no way to start the sampler with a token the
   * renderer supplies out of nowhere. Sampled data never enters the renderer at
   * all; main posts it directly. This surface exists so a person can see and
   * change what their own machine is doing, and for nothing else.
   */
  activity: {
    state: (): Promise<{
      enabled: boolean;
      paired: boolean;
      appTracking: boolean;
      reason: string | null;
    } | null> => ipcRenderer.invoke("activity:state"),
    setEnabled: (enabled: boolean): Promise<{ enabled: boolean; paired: boolean } | null> =>
      ipcRenderer.invoke("activity:set-enabled", enabled),
    /** Pass the one-time secret from Settings → Connect this device. `null`
     *  unpairs, which also withdraws consent. */
    pair: (token: string | null): Promise<{ enabled: boolean; paired: boolean } | null> =>
      ipcRenderer.invoke("activity:pair", token),
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
