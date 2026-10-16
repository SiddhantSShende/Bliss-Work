import React from "react";
import { createRoot } from "react-dom/client";
import { App, useSession, refreshSession, type PlatformConfig, type ServerEvent, type RtcTransport, type FileSink, type ChatStickyHost, type MeetingWindowStatus, installChunkReloadRecovery } from "@taskboard/app";
import type { PinResult, WsEventMeta } from "@taskboard/shared";
import { resolveEndpointsFromEnv } from "../shared/endpoints";
import { createClickQueue } from "../shared/notification-click-queue";
import "@taskboard/ui/styles.css";
import "./index.css";

declare global {
  interface Window {
    taskboard: {
      isMeetingWindow: boolean;
      openMeetingWindow: (callId: string) => void;
      pushMeetingWindowStatus: (status: MeetingWindowStatus) => void;
      onMeetingWindowStatus: (cb: (status: MeetingWindowStatus) => void) => () => void;
      onMeetingWindowClosed: (cb: (callId: string) => void) => () => void;
      hangUpMeetingWindow: (callId: string) => void;
      setToken: (t: string | null) => void;
      getRefreshToken: () => Promise<string | null>;
      setRefreshToken: (t: string | null) => void;
      pinTask: (taskId: string) => Promise<PinResult>;
      listPinned: () => Promise<string[]>;
      onWsEvent: (cb: (e: ServerEvent, meta?: WsEventMeta) => void) => () => void;
      onTokenRequest: (cb: () => void) => () => void;
      onInviteDeepLink: (cb: (token: string) => void) => () => void;
      onMeetingDeepLink: (cb: (token: string) => void) => () => void;
      onNotificationClick: (cb: (click: { notificationId: string; path: string | null }) => void) => () => void;
      onTaskChatOpen: (cb: (open: { taskId: string }) => void) => () => void;
      showMeetingInvitePopup: (
        callId: string,
        title: string,
        organizer: string,
        adhoc?: boolean,
        media?: "video" | "voice",
        ringing?: boolean,
      ) => void;
      dismissMeetingInvitePopup: (callId: string) => void;
      onMeetingInviteAction: (cb: (callId: string, media: "video" | "voice") => void) => () => void;
      windowControlsSide: "left" | "right";
      setTitleBarTheme: (theme: { color: string; symbolColor: string }) => void;
      syncTitleBarZoom: () => void;
      openExternal: (url: string) => void;
      openAttachment: (url: string, fileName: string) => Promise<{ ok: boolean; error?: string }>;
      hasPreciseLocation: () => Promise<boolean>;
      /** The main process owns idle/active accounting on this platform. */
      osActivityTracking: boolean;
      drainActivitySpans: () => Promise<unknown>;
      /** Absent on platforms with no OS location-privacy page (Linux). */
      openLocationSettings?: () => Promise<boolean>;
      /** Absent on platforms with no OS camera/microphone-privacy page (Linux). */
      openCameraSettings?: () => Promise<boolean>;
      openMicrophoneSettings?: () => Promise<boolean>;
      /** Main is about to quit; call the returned unsubscribe or notifyQuitReady
       *  once cleanup is done. See PlatformConfig.onBeforeQuit. */
      onBeforeQuit: (cb: () => void) => () => void;
      notifyQuitReady: () => void;
      onBeforeWindowClose: (cb: () => void) => () => void;
      notifyWindowCloseReady: () => void;
      onScreenshotBlocked: (
        cb: (info: { chord: string; recorded: boolean }) => void,
      ) => () => void;
      appVersion: () => Promise<string>;
      checkForUpdates: () => Promise<{
        status: "checking" | "available" | "up-to-date" | "downloading" | "unsupported" | "error";
        version?: string;
        message?: string;
      }>;
      onUpdateCheckFailed: (cb: (message: string) => void) => () => void;
      locale: {
        setLocale: (locale: string) => Promise<void>;
      };
      notifications: {
        getDesktopEnabled: () => Promise<boolean>;
        setDesktopEnabled: (enabled: boolean) => Promise<void>;
        showIncomingCall: (caller: string, media: "audio" | "video") => void;
        closeIncomingCall: () => void;
        onIncomingCallAction: (cb: (action: "accept" | "reject") => void) => () => void;
      };
      rtc: RtcTransport;
      fileSink: FileSink;
      hash: {
        update: (id: string, data: ArrayBuffer) => Promise<void>;
        digest: (id: string) => Promise<string>;
      };
    };
    /** Pinned-chat bridge, exposed by the same preload. Surfaced to the shared
     *  app through PlatformConfig.chatSticky rather than read off window there. */
    chatSticky?: ChatStickyHost;
  }
}

// Recover from a stale lazy chunk (Export Tasks pulls exceljs dynamically).
// Shared with the web entry so both platforms behave the same.
installChunkReloadRecovery();

const bridge = window.taskboard;

// The main window has no OS title bar (the app's own top bar replaces it); the
// meeting window keeps its frame. Lets the shared stylesheet inset full-height
// overlays below the bar — see --titlebar-inset in @taskboard/ui/styles.css.
if (!bridge.isMeetingWindow) {
  document.documentElement.dataset.titlebar = "";
  // Page zoom (View > Zoom) scales the bar but not the native window controls
  // drawn over it, so tell main whenever it changes — and once at start, since
  // the last session's zoom is restored before this runs. devicePixelRatio is
  // what zoom moves; plain window resizes leave it alone and are not forwarded.
  let lastDpr = 0;
  const syncZoom = () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    bridge.syncTitleBarZoom();
  };
  window.addEventListener("resize", syncZoom);
  syncZoom();
}

// The meeting window is loaded with ?w=meeting&callId=… (a real query string,
// not a hash) rather than a pre-built hash: composing loadFile's `search` and
// `hash` options together is unproven in this codebase (every existing window
// uses one or the other, never both — see main/meeting-window-manager.ts), so
// the route is seeded here instead, imperatively, before the app ever
// renders — the same technique bridge.onMeetingDeepLink already uses below
// for an inbound deep link, just run synchronously up front instead of on an
// event.
if (bridge.isMeetingWindow) {
  const callId = new URLSearchParams(location.search).get("callId");
  if (callId) location.hash = `#/call/${encodeURIComponent(callId)}?opened=1`;
}

// Service endpoints come from src/shared/endpoints.ts, which the MAIN process
// imports too — so the renderer and the ws-process socket can never disagree
// about which backend this build talks to. Any VITE_* override wins, so a
// custom deployment needs no code edit.
const env = import.meta.env;
const ENDPOINTS = resolveEndpointsFromEnv(!env.DEV, {
  authBase: env.VITE_AUTH_BASE,
  taskBase: env.VITE_TASK_BASE,
  notificationBase: env.VITE_NOTIFICATION_BASE,
  messagingBase: env.VITE_MESSAGING_BASE,
  // Was MISSING here and in the main process, which made VITE_TELEMETRY_BASE a
  // web-only override: the desktop silently used the baked default, so a
  // deployment that moved telemetry broke member activity on desktop alone.
  telemetryBase: env.VITE_TELEMETRY_BASE,
  stickyBase: env.VITE_STICKY_BASE,
  integrationsBase: env.VITE_INTEGRATIONS_BASE,
  wsUrl: env.VITE_WS_URL,
});

const config: PlatformConfig = {
  kind: "electron",
  // NOT window.location.origin — the packaged renderer loads from file://,
  // which would make every meeting-join link unopenable (see PlatformConfig's
  // own doc comment on webBaseUrl). authBase always shares an origin with the
  // public web app (see apps/desktop/src/shared/endpoints.ts's PROD_ORIGIN),
  // the same derivation apps/desktop/src/main/index.ts and session-token.ts
  // already use for the identical problem.
  webBaseUrl: new URL(ENDPOINTS.authBase).origin,
  ...ENDPOINTS,
  router: "hash",
  // Absent (not merely false) on the meeting window's OWN config would be
  // pointless caution — nothing in that window's UI can call enter() a
  // second time (CallWindow.tsx shadows MeetingSessionContext with null) —
  // so this is wired the same way for both windows.
  openMeetingWindow: (callId) => bridge.openMeetingWindow(callId),
  // Only true for the meeting window itself — see PlatformConfig's own doc
  // comment on why its SessionBootstrap needs this.
  bootstrapFromPeerSession: bridge.isMeetingWindow,
  // Wired identically on both windows, same reasoning as openMeetingWindow
  // above: the meeting window is the only one that ever calls push, the
  // main window is the only one that ever calls hangUp/subscribes to
  // status/closed, and each side's own unused half is simply never invoked.
  pushMeetingWindowStatus: (status) => bridge.pushMeetingWindowStatus(status),
  onMeetingWindowStatus: (cb) => bridge.onMeetingWindowStatus(cb),
  onMeetingWindowClosed: (cb) => bridge.onMeetingWindowClosed(cb),
  hangUpMeetingWindow: (callId) => bridge.hangUpMeetingWindow(callId),
  pinTask: (taskId) => bridge.pinTask(taskId),
  listPinned: () => bridge.listPinned(),
  persistToken: (t) => bridge.setToken(t),
  // file:// makes every API request cross-site, so the SameSite=lax refresh
  // cookie never travels — the token comes from the host and goes in the body.
  // See apps/desktop/src/main/session-token.ts.
  getRefreshToken: () => bridge.getRefreshToken(),
  persistRefreshToken: (t) => bridge.setRefreshToken(t),
  chatSticky: window.chatSticky,
  // Handoffs like the WhatsApp forward link have no business opening inside
  // the app's own renderer, so they go to the system browser instead.
  // The meeting window keeps its OS frame (no overlay), so it gets neither.
  windowControls: bridge.isMeetingWindow
    ? undefined
    : { side: bridge.windowControlsSide, setTheme: (theme) => bridge.setTitleBarTheme(theme) },
  openExternal: (url) => bridge.openExternal(url),
  // Non-previewable mail attachment: fetch it in main and hand the FILE to
  // the OS's native default app, instead of routing a target="_blank" click
  // through the system browser. See main/attachment-open.ts.
  openAttachment: (url, fileName) => bridge.openAttachment(url, fileName),
  hasPreciseLocation: () => bridge.hasPreciseLocation(),
  osActivityTracking: bridge.osActivityTracking,
  drainActivitySpans: bridge.osActivityTracking ? () => bridge.drainActivitySpans() : undefined,
  // Forwarded only when the host actually has one, so `config.openLocationSettings`
  // stays a truthful capability check in the shared app code.
  openLocationSettings: bridge.openLocationSettings
    ? () => bridge.openLocationSettings!()
    : undefined,
  openCameraSettings: bridge.openCameraSettings ? () => bridge.openCameraSettings!() : undefined,
  openMicrophoneSettings: bridge.openMicrophoneSettings
    ? () => bridge.openMicrophoneSettings!()
    : undefined,
  showMeetingInvitePopup: (callId, title, organizer, adhoc, media, ringing) =>
    bridge.showMeetingInvitePopup(callId, title, organizer, adhoc, media, ringing),
  dismissMeetingInvitePopup: (callId) => bridge.dismissMeetingInvitePopup(callId),
  onMeetingInviteAction: (cb) => bridge.onMeetingInviteAction(cb),
  onNotificationClick: (cb) => notificationClicks.subscribe(cb),
  onTaskChatOpen: (cb) => taskChatOpens.subscribe(cb),
  onBeforeQuit: (cb) => bridge.onBeforeQuit(cb),
  notifyQuitReady: () => bridge.notifyQuitReady(),
  onBeforeWindowClose: (cb) => bridge.onBeforeWindowClose(cb),
  notifyWindowCloseReady: () => bridge.notifyWindowCloseReady(),
  onScreenshotBlocked: (cb) => bridge.onScreenshotBlocked(cb),
  appVersion: () => bridge.appVersion(),
  checkForUpdates: () => bridge.checkForUpdates(),
  onUpdateCheckFailed: (cb) => bridge.onUpdateCheckFailed(cb),
  notificationPrefs: bridge.notifications,
  localePrefs: bridge.locale,
  // Omitted entirely for the meeting window: its events do not need to ride
  // the shared utilityProcess socket (there is nothing there for it — no
  // sticky notes, no tray) and useCallRoom's own subscribeToEvents already
  // falls back to opening a direct WsClient socket whenever eventSource is
  // absent, exactly like web. Present only on the main window, unchanged.
  ...(bridge.isMeetingWindow
    ? {}
    : {
        eventSource: {
          connect: () => bridge.setToken(useSession.getState().accessToken),
          // Sign-out. Clearing the token in the ws-process is what closes its
          // socket, and the socket is what the gateway counts as presence —
          // the renderer unmounting does not reach it, because that process
          // outlives the window on purpose.
          disconnect: () => bridge.setToken(null),
          subscribe: (cb) => bridge.onWsEvent(cb),
        },
      }),
  rtc: bridge.rtc,
  fileSink: bridge.fileSink,
  // Stream the file to main in 8 MB slices (constant renderer memory) and hash
  // it there incrementally, so the sender never loads a multi-GB file at once.
  hashFile: async (file) => {
    const id = crypto.randomUUID();
    const SLICE = 8 * 1024 * 1024;
    for (let off = 0; off < file.size; off += SLICE) {
      await bridge.hash.update(id, await file.slice(off, off + SLICE).arrayBuffer());
    }
    return bridge.hash.digest(id);
  },
};

// Keep the utilityProcess token in sync with every session change.
useSession.subscribe((s) => bridge.setToken(s.accessToken));

// Host (ws-process) requests a fresh token → refresh + forward. Route through
// the SHARED single-flight refreshSession (not a raw fetch) so this can't race
// the renderer's own ApiClient/WS refresh and double-spend the rotating refresh
// token (which would revoke the session). refreshSession updates the session
// store + forwards via config.persistToken on success; on failure we forward
// null so ws-process's pending token request unblocks instead of hanging.
bridge.onTokenRequest(async () => {
  const s = await refreshSession(config.authBase, config.persistToken, config.getRefreshToken);
  if (!s) bridge.setToken(null);
});

// Invite deep-link → route into the hash router.
bridge.onInviteDeepLink((token) => {
  location.hash = `#/invite?token=${encodeURIComponent(token)}`;
});

// Meeting deep-link → the same /join route the web app's own links use.
bridge.onMeetingDeepLink((token) => {
  location.hash = `#/join?t=${encodeURIComponent(token)}`;
});

// OS-notification click → handed to the signed-in shell (config.onNotificationClick
// below), which runs the same mark-read-and-open code as the bell and the in-app
// toast. The listener is registered here, at load, because main sends the click as
// the page finishes loading — before the shell has mounted — so it waits in the queue.
const notificationClicks = createClickQueue<{ notificationId: string; path: string | null }>();
bridge.onNotificationClick((click) => notificationClicks.push(click));

// Sticky overlay's Chat button → handed to the signed-in shell
// (config.onTaskChatOpen below, consumed by TaskChatOpenBridge), same
// early-click queueing as the notification click above.
const taskChatOpens = createClickQueue<{ taskId: string }>();
bridge.onTaskChatOpen((open) => taskChatOpens.push(open));

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App config={config} />
  </React.StrictMode>,
);
