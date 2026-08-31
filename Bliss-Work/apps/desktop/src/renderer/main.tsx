import React from "react";
import { createRoot } from "react-dom/client";
import { App, useSession, refreshSession, type PlatformConfig, type ServerEvent, type RtcTransport, type FileSink, type ChatStickyHost, installChunkReloadRecovery } from "@taskboard/app";
import type { PinResult, WsEventMeta } from "@taskboard/shared";
import { resolveEndpointsFromEnv } from "../shared/endpoints";
import "@taskboard/ui/styles.css";
import "./index.css";

declare global {
  interface Window {
    taskboard: {
      setToken: (t: string | null) => void;
      getRefreshToken: () => Promise<string | null>;
      setRefreshToken: (t: string | null) => void;
      pinTask: (taskId: string) => Promise<PinResult>;
      listPinned: () => Promise<string[]>;
      dismissSticky: (taskId: string) => void;
      onWsEvent: (cb: (e: ServerEvent, meta?: WsEventMeta) => void) => () => void;
      onTokenRequest: (cb: () => void) => () => void;
      onInviteDeepLink: (cb: (token: string) => void) => () => void;
      onMeetingDeepLink: (cb: (token: string) => void) => () => void;
      openExternal: (url: string) => void;
      hasPreciseLocation: () => Promise<boolean>;
      /** Absent on platforms with no OS location-privacy page (Linux). */
      openLocationSettings?: () => Promise<boolean>;
      /** Absent on platforms with no OS camera/microphone-privacy page (Linux). */
      openCameraSettings?: () => Promise<boolean>;
      openMicrophoneSettings?: () => Promise<boolean>;
      /** Main is about to quit; call the returned unsubscribe or notifyQuitReady
       *  once cleanup is done. See PlatformConfig.onBeforeQuit. */
      onBeforeQuit: (cb: () => void) => () => void;
      notifyQuitReady: () => void;
      onScreenshotBlocked: (
        cb: (info: { chord: string; recorded: boolean }) => void,
      ) => () => void;
      appVersion: () => Promise<string>;
      checkForUpdates: () => Promise<{
        status: "checking" | "available" | "up-to-date" | "downloading" | "unsupported" | "error";
        version?: string;
        message?: string;
      }>;
      activity: {
        state: () => Promise<{
          enabled: boolean;
          paired: boolean;
          deviceKey: string;
          appTracking: boolean;
          reason: string | null;
          titleTracking: boolean;
          titleTrackingReason: string | null;
        } | null>;
        setEnabled: (enabled: boolean) => Promise<{ enabled: boolean; paired: boolean } | null>;
        pair: (token: string | null) => Promise<{ enabled: boolean; paired: boolean } | null>;
        openScreenRecordingSettings: () => Promise<boolean>;
        signedOut: () => Promise<null>;
      };
      browsers: {
        list: () => Promise<
          Array<{ family: string; label: string; path: string | null; installed: boolean }>
        >;
        launch: (path: string) => Promise<boolean>;
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
  wsUrl: env.VITE_WS_URL,
});

const config: PlatformConfig = {
  kind: "electron",
  ...ENDPOINTS,
  router: "hash",
  pinTask: (taskId) => bridge.pinTask(taskId),
  listPinned: () => bridge.listPinned(),
  dismissSticky: (taskId) => bridge.dismissSticky(taskId),
  persistToken: (t) => bridge.setToken(t),
  // file:// makes every API request cross-site, so the SameSite=lax refresh
  // cookie never travels — the token comes from the host and goes in the body.
  // See apps/desktop/src/main/session-token.ts.
  getRefreshToken: () => bridge.getRefreshToken(),
  persistRefreshToken: (t) => bridge.setRefreshToken(t),
  chatSticky: window.chatSticky,
  // Handoffs like the WhatsApp forward link have no business opening inside
  // the app's own renderer, so they go to the system browser instead.
  openExternal: (url) => bridge.openExternal(url),
  hasPreciseLocation: () => bridge.hasPreciseLocation(),
  // Forwarded only when the host actually has one, so `config.openLocationSettings`
  // stays a truthful capability check in the shared app code.
  openLocationSettings: bridge.openLocationSettings
    ? () => bridge.openLocationSettings!()
    : undefined,
  openCameraSettings: bridge.openCameraSettings ? () => bridge.openCameraSettings!() : undefined,
  openMicrophoneSettings: bridge.openMicrophoneSettings
    ? () => bridge.openMicrophoneSettings!()
    : undefined,
  onBeforeQuit: (cb) => bridge.onBeforeQuit(cb),
  notifyQuitReady: () => bridge.notifyQuitReady(),
  onScreenshotBlocked: (cb) => bridge.onScreenshotBlocked(cb),
  appVersion: () => bridge.appVersion(),
  checkForUpdates: () => bridge.checkForUpdates(),
  activityAgent: bridge.activity,
  browserAgent: bridge.browsers,
  eventSource: {
    connect: () => bridge.setToken(useSession.getState().accessToken),
    // Sign-out. Clearing the token in the ws-process is what closes its socket,
    // and the socket is what the gateway counts as presence — the renderer
    // unmounting does not reach it, because that process outlives the window on
    // purpose.
    disconnect: () => bridge.setToken(null),
    subscribe: (cb) => bridge.onWsEvent(cb),
  },
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App config={config} />
  </React.StrictMode>,
);
