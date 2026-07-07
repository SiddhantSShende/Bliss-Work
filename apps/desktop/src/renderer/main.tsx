import React from "react";
import { createRoot } from "react-dom/client";
import { App, useSession, refreshSession, type PlatformConfig, type ServerEvent, type RtcTransport, type FileSink } from "@taskboard/app";
import type { PinResult } from "@taskboard/shared";
import "@taskboard/ui/styles.css";
import "./index.css";

declare global {
  interface Window {
    taskboard: {
      setToken: (t: string | null) => void;
      pinTask: (taskId: string) => Promise<PinResult>;
      listPinned: () => Promise<string[]>;
      onWsEvent: (cb: (e: ServerEvent) => void) => () => void;
      onTokenRequest: (cb: () => void) => () => void;
      onInviteDeepLink: (cb: (token: string) => void) => () => void;
      rtc: RtcTransport;
      fileSink: FileSink;
      hash: {
        update: (id: string, data: ArrayBuffer) => Promise<void>;
        digest: (id: string) => Promise<string>;
      };
    };
  }
}

const bridge = window.taskboard;

// Service endpoints. A PACKAGED desktop build talks to the hosted BlissWork
// backend on communication.rnrtechs.com — the SAME origin the production web
// app uses — so a downloaded installer works out of the box with no config. In
// dev (`npm run desktop`, import.meta.env.DEV) we target the local compose
// stack. Any VITE_* override wins, so a custom backend needs no code edit.
// NOTE: the main process (ws-process) has its own mirror of these defaults in
// src/main/index.ts (keyed off app.isPackaged) — keep the two in lock-step.
const env = import.meta.env;
const PROD_ENDPOINTS = {
  authBase: "https://communication.rnrtechs.com/api/auth",
  taskBase: "https://communication.rnrtechs.com/api/tasks",
  notificationBase: "https://communication.rnrtechs.com/api/notifications",
  messagingBase: "https://communication.rnrtechs.com/api/messaging",
  wsUrl: "wss://communication.rnrtechs.com/ws",
};
const DEV_ENDPOINTS = {
  authBase: "http://localhost:8001",
  taskBase: "http://localhost:8002",
  notificationBase: "http://localhost:8003",
  messagingBase: "http://localhost:8004",
  wsUrl: "ws://localhost:8090/ws",
};
const ENDPOINTS = env.DEV ? DEV_ENDPOINTS : PROD_ENDPOINTS;

const config: PlatformConfig = {
  kind: "electron",
  authBase: env.VITE_AUTH_BASE ?? ENDPOINTS.authBase,
  taskBase: env.VITE_TASK_BASE ?? ENDPOINTS.taskBase,
  notificationBase: env.VITE_NOTIFICATION_BASE ?? ENDPOINTS.notificationBase,
  messagingBase: env.VITE_MESSAGING_BASE ?? ENDPOINTS.messagingBase,
  wsUrl: env.VITE_WS_URL ?? ENDPOINTS.wsUrl,
  router: "hash",
  pinTask: (taskId) => bridge.pinTask(taskId),
  listPinned: () => bridge.listPinned(),
  persistToken: (t) => bridge.setToken(t),
  eventSource: {
    connect: () => bridge.setToken(useSession.getState().accessToken),
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
  const s = await refreshSession(config.authBase, config.persistToken);
  if (!s) bridge.setToken(null);
});

// Invite deep-link → route into the hash router.
bridge.onInviteDeepLink((token) => {
  location.hash = `#/invite?token=${encodeURIComponent(token)}`;
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App config={config} />
  </React.StrictMode>,
);
