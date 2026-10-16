import { contextBridge, ipcRenderer } from "electron";
import { hasLocationSettingsPage } from "../shared/location-settings";
import { hasOsActivityTracking } from "../shared/os-activity";
import { hasMediaSettingsPage } from "../shared/media-settings";
import type { ServerEvent, ClientFrame, ControlFrame, PinResult, WsEventMeta } from "@taskboard/shared";

/**
 * Main-window preload. Exposes a fixed, typed surface on window.taskboard.
 * The renderer's event source is fed from the utilityProcess via "ws:event".
 */
/** Mirrors PlatformConfig's MeetingWindowStatus (packages/app/src/platform.ts)
 *  — duplicated rather than imported, same as every other inline shape in
 *  this file (see `checkForUpdates()`'s return type below), so this preload
 *  carries no build dependency on @taskboard/app. */
interface MeetingWindowStatus {
  callId: string;
  title: string;
  micOn: boolean;
  camOn: boolean;
  startedAt?: number;
  participantCount: number;
}

const api = {
  /** Whether THIS window is a meeting window (main/meeting-window-manager.ts),
   *  as opposed to the main window — read from the real (non-hash) query
   *  string the manager loads it with, the same way sticky.ts reads its own
   *  taskId/collapsed. Drives renderer/main.tsx's PlatformConfig branch:
   *  no `eventSource` (opens its own direct socket, like web) and
   *  `bootstrapFromPeerSession` (its credential IPC is gated out below, so it
   *  bootstraps from the main window's session instead — see
   *  lib/authChannel.ts's requestSession). */
  isMeetingWindow: new URLSearchParams(location.search).get("w") === "meeting",

  /** Open (or focus) a meeting in its own window. See
   *  PlatformConfig.openMeetingWindow / lib/MeetingSession.tsx's `enter()`. */
  openMeetingWindow: (callId: string) => ipcRenderer.send("meeting-window:open", { callId }),

  /** Called from the MEETING window: push this call's live status to the
   *  main window's status pill. See PlatformConfig.pushMeetingWindowStatus. */
  pushMeetingWindowStatus: (status: MeetingWindowStatus) =>
    ipcRenderer.send("meeting-window:status", status),

  /** Called from the MAIN window: subscribe to a meeting window's status. */
  onMeetingWindowStatus: (cb: (status: MeetingWindowStatus) => void) => {
    const handler = (_: unknown, status: MeetingWindowStatus) => cb(status);
    ipcRenderer.on("meeting-window:status", handler);
    return () => ipcRenderer.removeListener("meeting-window:status", handler);
  },

  /** Called from the MAIN window: a meeting window closed (gracefully or
   *  not) — the status pill's cue to clear itself. */
  onMeetingWindowClosed: (cb: (callId: string) => void) => {
    const handler = (_: unknown, callId: string) => cb(callId);
    ipcRenderer.on("meeting-window:closed", handler);
    return () => ipcRenderer.removeListener("meeting-window:closed", handler);
  },

  /** Called from the MAIN window: the status pill's hang-up button. */
  hangUpMeetingWindow: (callId: string) => ipcRenderer.send("meeting-window:hangup", callId),

  /** Forward the current access token to the utilityProcess (for WS + task REST). */
  setToken: (token: string | null) => ipcRenderer.send("auth:token", token),

  /** Pin an acknowledged task to the desktop as a locked sticky note. Resolves
   *  with the authoritative pinned set and any refusal reason so the renderer
   *  never optimistically lies about pin state. */
  pinTask: (taskId: string): Promise<PinResult> => ipcRenderer.invoke("task:pin", taskId),

  /** Task ids currently pinned to the desktop (source of truth = main process
   *  sticky-state.json). The renderer hydrates the Pin button from this. */
  listPinned: (): Promise<string[]> => ipcRenderer.invoke("task:list-pinned"),


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

  /** Emitted when the app is opened via a taskboard:// meeting join deep-link
   *  (the browser landing page at /join hands off to this when it can). */
  onMeetingDeepLink: (cb: (token: string) => void) => {
    const handler = (_: unknown, token: string) => cb(token);
    ipcRenderer.on("deeplink:meeting", handler);
    return () => ipcRenderer.removeListener("deeplink:meeting", handler);
  },

  /** Emitted when the user clicks an OS notification: which notification, and the
   *  in-app route it leads to (null when it leads nowhere). Same channel name as
   *  main/notification-open.ts's OPEN_ROUTE_CHANNEL (preload cannot import from
   *  main). The renderer re-validates both before acting. */
  onNotificationClick: (cb: (click: { notificationId: string; path: string | null }) => void) => {
    const handler = (_: unknown, click: { notificationId: string; path: string | null }) => cb(click);
    ipcRenderer.on("notification:open-route", handler);
    return () => ipcRenderer.removeListener("notification:open-route", handler);
  },

  /** Emitted when the sticky overlay's Chat button is clicked: the sticky
   *  window has no router of its own, so it asks main to forward this to the
   *  main window instead. Same channel name as main/task-chat-open.ts's
   *  TASK_CHAT_OPEN_CHANNEL (preload cannot import from main). */
  onTaskChatOpen: (cb: (open: { taskId: string }) => void) => {
    const handler = (_: unknown, open: { taskId: string }) => cb(open);
    ipcRenderer.on("task:open-chat", handler);
    return () => ipcRenderer.removeListener("task:open-chat", handler);
  },

  /** Which edge of the main window the native window controls sit on: the OS
   *  draws them over the app's top bar (see MAIN_TITLE_BAR_HEIGHT in main/windows.ts),
   *  at the right on Windows/Linux and the left (traffic lights) on macOS. */
  windowControlsSide: process.platform === "darwin" ? "left" : "right",
  /** Tell main the top bar's resolved colours so the native window-control
   *  overlay matches the active theme. Main ignores it from any window but the
   *  main one and on macOS. */
  setTitleBarTheme: (theme: { color: string; symbolColor: string }) =>
    ipcRenderer.send("window:title-bar-theme", theme),
  /** The page zoom changed: main re-fits the native window controls' height to
   *  the (zoom-scaled) top bar. Carries no value — main reads the factor itself. */
  syncTitleBarZoom: () => ipcRenderer.send("window:title-bar-zoom"),

  /** Open an https URL in the system browser. Used for OAuth: Google rejects
   *  embedded webviews, so the consent screen has to leave the app. Main
   *  re-validates the scheme — never trust the renderer with a shell call. */
  openExternal: (url: string) => ipcRenderer.send("shell:open-external", url),

  /** Fetch a signed attachment URL in MAIN and open the FILE with the OS's
   *  native default app (shell.openPath) — the desktop-native counterpart of
   *  a non-previewable mail attachment's `target="_blank"` "Download" link,
   *  which otherwise routes through openExternal into the system browser.
   *  Main re-validates the URL — never trust the renderer with a fetch + shell
   *  call. See main/attachment-open.ts. */
  openAttachment: (url: string, fileName: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("attachment:open", { url, fileName }),

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

  /** True where the main process tracks OS-level idle (see
   *  shared/os-activity.ts). The renderer then leaves idle/active accounting to
   *  it instead of accruing its own — see TelemetryBridge. */
  osActivityTracking: hasOsActivityTracking(),
  /** Collect the activity spans main has finished since the last call (an app
   *  span or an idle span, each with its start and duration — an executable
   *  name, never a path). Resolves to an empty array where main has no tracker.
   *  Untyped on purpose: the renderer validates what crosses this boundary. */
  drainActivitySpans: (): Promise<unknown> => ipcRenderer.invoke("activity:drain"),

  /** Open the OS page where camera/microphone access for desktop apps is
   *  granted, one per media kind. Same "absent, not a no-op" contract as
   *  openLocationSettings above — see shared/media-settings.ts. */
  openCameraSettings: hasMediaSettingsPage("camera")
    ? (): Promise<boolean> => ipcRenderer.invoke("media:open-camera-settings")
    : undefined,
  openMicrophoneSettings: hasMediaSettingsPage("microphone")
    ? (): Promise<boolean> => ipcRenderer.invoke("media:open-microphone-settings")
    : undefined,

  /** The app is about to quit. Main is PAUSING the quit briefly to give an
   *  active meeting a chance to leave the room and clear its resumable-
   *  meeting marker first — call notifyQuitReady() once that is done (or
   *  immediately if there is nothing to do), so the quit does not wait out
   *  the full safety timeout for no reason. */
  onBeforeQuit: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("app:before-quit", handler);
    return () => ipcRenderer.removeListener("app:before-quit", handler);
  },
  notifyQuitReady: () => ipcRenderer.send("app:quit-ready"),

  /** THIS window (a meeting window — see main/meeting-window-manager.ts) is
   *  about to close, app still running. Same pause-and-wait shape as
   *  onBeforeQuit/notifyQuitReady above, distinct channels because the two
   *  are genuinely different events even though CallRoom answers both the
   *  same way today. */
  onBeforeWindowClose: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("meeting-window:before-close", handler);
    return () => ipcRenderer.removeListener("meeting-window:before-close", handler);
  },
  notifyWindowCloseReady: () => ipcRenderer.send("meeting-window:close-ready"),

  /** Emitted when the app detects and refuses a screenshot attempt.
   *
   *  The message is fixed; the payload says WHAT was pressed. `recorded` is
   *  always false — main no longer records anything itself (see
   *  screenshot-guard.ts) — so the renderer reports every attempt itself
   *  through its own session beacon, which is what leaves the server-side
   *  trace of a refused capture. `route`, when present, comes from the window
   *  that actually received the capture attempt. */
  onScreenshotBlocked: (cb: (info: { chord: string; recorded: boolean; route?: string }) => void) => {
    const handler = (_: unknown, info: { chord: string; recorded: boolean; route?: string }) => cb(info);
    ipcRenderer.on("security:screenshot-blocked", handler);
    return () => ipcRenderer.removeListener("security:screenshot-blocked", handler);
  },

  /** Hand an incoming meeting invite off to the always-on-top popup window
   *  (main/meeting-invite-manager.ts) instead of an in-page card — see
   *  PlatformConfig.showMeetingInvitePopup and features/IncomingMeetingNotice,
   *  which calls this and renders nothing itself when it is present. */
  showMeetingInvitePopup: (callId: string, title: string, organizer: string, adhoc?: boolean) =>
    ipcRenderer.send("meeting-invite:show", { callId, title, organizer, adhoc: adhoc === true }),

  /** Close the popup window for `callId` with no user action — the call
   *  ended, or was answered elsewhere, while it was still showing. See
   *  PlatformConfig.dismissMeetingInvitePopup and
   *  IncomingMeetingNotice's onIncomingMeetingDismissed. */
  dismissMeetingInvitePopup: (callId: string) => ipcRenderer.send("meeting-invite:dismiss", callId),

  /** The invite popup's Video/Voice button was clicked — main already brought
   *  this window forward before sending this. */
  onMeetingInviteAction: (cb: (callId: string, media: "video" | "voice") => void) => {
    const handler = (_: unknown, p: { callId: string; media: "video" | "voice" }) =>
      cb(p.callId, p.media);
    ipcRenderer.on("meeting-invite:join", handler);
    return () => ipcRenderer.removeListener("meeting-invite:join", handler);
  },

  /** The invite popup's Decline button was clicked (ad-hoc rings only). */
  onMeetingInviteDeclined: (cb: (callId: string) => void) => {
    const handler = (_: unknown, p: { callId: string }) => cb(p.callId);
    ipcRenderer.on("meeting-invite:declined", handler);
    return () => ipcRenderer.removeListener("meeting-invite:declined", handler);
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

  /** Fires if a download an on-demand check kicked off later fails —
   *  checkForUpdates() already resolved "downloading" by then, so this is the
   *  only way that failure can still reach the UI. */
  onUpdateCheckFailed: (cb: (message: string) => void) => {
    const handler = (_: unknown, message: string) => cb(message);
    ipcRenderer.on("update:check-failed", handler);
    return () => ipcRenderer.removeListener("update:check-failed", handler);
  },

  /**
   * "Desktop notifications" preference, mirrored from the renderer's own
   * localStorage copy (packages/app/src/lib/notificationPrefs.ts). Main reads
   * this before raising an OS popup for a message/task/call — see
   * main/notifier.ts and main/notification-prefs.ts — since a popup can fire
   * while the window is minimised or in the tray, long after any renderer
   * code has run.
   */
  /** The effective UI language, mirrored to main so the application menu, tray
   *  and OS notifications follow it (main/locale-pref.ts, main/i18n.ts). */
  locale: {
    setLocale: (locale: string): Promise<void> => ipcRenderer.invoke("locale:set", locale),
  },

  notifications: {
    getDesktopEnabled: (): Promise<boolean> => ipcRenderer.invoke("notifications:get-desktop-enabled"),
    setDesktopEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("notifications:set-desktop-enabled", enabled),
    showIncomingCall: (caller: string, media: "audio" | "video"): void =>
      ipcRenderer.send("incoming-call:show", { caller, media }),
    closeIncomingCall: (): void => ipcRenderer.send("incoming-call:close"),
    onIncomingCallAction: (cb: (action: "accept" | "reject") => void): (() => void) => {
      const handler = (_event: unknown, action: "accept" | "reject") => cb(action);
      ipcRenderer.on("incoming-call:action", handler);
      return () => ipcRenderer.removeListener("incoming-call:action", handler);
    },
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
