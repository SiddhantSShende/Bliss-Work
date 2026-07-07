import { app, BrowserWindow, ipcMain, Tray, Menu, screen, session, utilityProcess, UtilityProcess } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StickyTaskDTO } from "@taskboard/shared";
import { createMainWindow } from "./windows";
import { StickyManager } from "./sticky-manager";
import { ChatStickyManager, type ChatStickyBootstrap } from "./chat-sticky-manager";
import { initCache, getTasks, setTasks } from "./cache";
import { flushSync as flushStickyState, initStickyState } from "./sticky-state";
import { trayIcon } from "./assets";
import { buildAppMenu } from "./menu";
import { registerFileSink } from "./file-sink";

const here = fileURLToPath(new URL(".", import.meta.url));

// Service endpoints for the ws-process (single WS + task REST client). A
// PACKAGED build (app.isPackaged) targets the hosted BlissWork backend on
// communication.rnrtechs.com so a downloaded installer works with no config;
// dev (running from node_modules/electron) targets the local compose stack.
// TB_* env overrides win for custom deployments. MUST stay in lock-step with
// the renderer defaults in src/renderer/main.tsx.
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
const DEFAULT_ENDPOINTS = app.isPackaged ? PROD_ENDPOINTS : DEV_ENDPOINTS;
const ENDPOINTS = {
  authBase: process.env.TB_AUTH_BASE ?? DEFAULT_ENDPOINTS.authBase,
  taskBase: process.env.TB_TASK_BASE ?? DEFAULT_ENDPOINTS.taskBase,
  notificationBase: process.env.TB_NOTIFICATION_BASE ?? DEFAULT_ENDPOINTS.notificationBase,
  messagingBase: process.env.TB_MESSAGING_BASE ?? DEFAULT_ENDPOINTS.messagingBase,
  wsUrl: process.env.TB_WS_URL ?? DEFAULT_ENDPOINTS.wsUrl,
};

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let wsProc: UtilityProcess | null = null;
let quitting = false;
// ws-process crash-recovery state: exponential backoff so a persistently
// crashing child doesn't spin-restart, reset once the child is healthy again.
let wsRestarts = 0;
let wsRestartTimer: NodeJS.Timeout | null = null;
const sticky = new StickyManager();
const chatSticky = new ChatStickyManager();

// Last-resort guards: the app runs in the tray with always-on-top notes that
// must outlive a stray error in an IPC handler or async callback. Log and keep
// running rather than letting an unhandled error tear the process down.
process.on("uncaughtException", (err) => console.error("[main] uncaughtException", err));
process.on("unhandledRejection", (reason) => console.error("[main] unhandledRejection", reason));

// Single-instance: focus existing + forward deep-link.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    focusMain();
    forwardDeepLink(argv.find((a) => a.startsWith("taskboard://")));
  });
  app.whenReady().then(() => {
    // WebRTC calls need camera/mic. Electron DENIES media by default; the app
    // only ever loads our own origin, so granting "media" (and nothing else) is
    // safe. NOTE: macOS packaged/notarized builds ALSO require
    // NSCameraUsageDescription + NSMicrophoneUsageDescription (Info.plist) and the
    // com.apple.security.device.{camera,audio-input} entitlements, or the OS
    // blocks capture before this handler is ever consulted.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");
    bootstrap();
  });
}

// Custom protocol for emailed invite deep-links.
if (process.defaultApp) app.setAsDefaultProtocolClient("taskboard", process.execPath, [process.argv[1] ?? ""]);
else app.setAsDefaultProtocolClient("taskboard");

app.on("open-url", (_e, url) => {
  focusMain();
  forwardDeepLink(url);
});

function bootstrap() {
  initCache();
  initStickyState();
  sticky.setTasks(getTasks());

  // Auto-start at login (Windows + macOS). Without this, a reboot would lose
  // every pinned sticky until the user manually relaunched — defeating the
  // "still there after I close the app" promise. The user can disable this
  // from the OS settings. We launch hidden ("openAsHidden" on macOS;
  // Windows always starts the app then we keep mainWindow hidden via the
  // tray) so logging in doesn't dump a window in the user's face.
  if (!process.defaultApp) {
    // Only configure in packaged builds — in dev (`npm run desktop`), Electron
    // is launched from node_modules and registering its path as a login item
    // would be wrong.
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      args: ["--auto-start"],
    });
  }
  const startedAtLogin = process.argv.includes("--auto-start");

  Menu.setApplicationMenu(
    buildAppMenu({
      onShow: focusMain,
      onQuit: quitApp,
    }),
  );
  mainWindow = createMainWindow(startedAtLogin);
  wireMainWindow(mainWindow);
  startWsProcess();
  createTray();
  registerFileSink();

  // Keep sticky notes on the main desktop screen when the display layout
  // changes (monitor plugged/unplugged/resolution change) — re-confine any note
  // that ended up off the primary display back onto it.
  const reclampStickies = () => {
    sticky.reclampAll();
    chatSticky.reclampAll();
  };
  screen.on("display-added", reclampStickies);
  screen.on("display-removed", reclampStickies);
  screen.on("display-metrics-changed", reclampStickies);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      wireMainWindow(mainWindow);
    }
  });
}

function wireMainWindow(win: BrowserWindow) {
  // Sticky notes are always pinned on top (see StickyManager), so the main
  // window's focus/minimize state no longer gates them. We only intercept close
  // to keep running in the tray — so the widgets + WS survive the window being
  // dismissed. A real quit sets `quitting`.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Task notes are pinned to the desktop BEHIND every app and never float on
  // top, so focus/blur no longer needs to raise or lower them. We still re-assert
  // "never always-on-top" on both transitions as a hard guarantee against any
  // platform quirk leaving a note promoted above app windows.
  win.on("focus", () => {
    sticky.lowerZOrder();
    chatSticky.lowerZOrder();
  });
  win.on("blur", () => {
    sticky.raiseZOrder();
    chatSticky.raiseZOrder();
  });
}

function focusMain() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    wireMainWindow(mainWindow);
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function forwardDeepLink(url?: string) {
  if (!url) return;
  try {
    const token = new URL(url).searchParams.get("token");
    if (token) mainWindow?.webContents.send("deeplink:invite", token);
  } catch {
    /* ignore */
  }
}

function startWsProcess() {
  wsProc = utilityProcess.fork(join(here, "ws-process.js"));
  wsProc.postMessage({ type: "config", ...ENDPOINTS });

  // Recover from a child crash: realtime events + sticky pushes flow through
  // this utility process, so a silent death would freeze the whole app's live
  // updates. Restart with capped exponential backoff and ask the renderer to
  // re-send the access token so the new child can re-authenticate.
  wsProc.on("exit", (code) => {
    if (quitting) return;
    console.error("[main] ws-process exited", code, "— scheduling restart");
    const delay = Math.min(30_000, 1_000 * 2 ** wsRestarts);
    wsRestarts++;
    if (wsRestartTimer) clearTimeout(wsRestartTimer);
    wsRestartTimer = setTimeout(() => {
      wsRestartTimer = null;
      startWsProcess();
      // The new child has no token yet; prompt the renderer to forward it.
      mainWindow?.webContents.send("token:request");
    }, delay);
  });

  wsProc.on(
    "message",
    (m: {
      type: string;
      event?: unknown;
      tasks?: StickyTaskDTO[];
      // Phase 8: ws-process drives sticky-chat fan-out for pinned threads.
      threadId?: string;
      payload?: unknown;
      // Phase 10: inbound rtc.* control frame to relay to the renderer.
      frame?: unknown;
    }) => {
      // Any inbound message means the child is alive and talking — reset the
      // restart backoff so a later crash again starts from a short delay.
      wsRestarts = 0;
      switch (m.type) {
        case "event":
          mainWindow?.webContents.send("ws:event", m.event);
          break;
        case "sticky": {
          const live = m.tasks ?? [];
          setTasks(live);
          // Live server push: auto-pin newly actionable tasks so an allocation
          // pops up on the desktop on its own.
          sticky.setTasks(live, { live: true });
          // LIVE push only: an id absent here means the task left the actionable
          // set (completed/left/ignored), so unpin it. Never prune from the
          // bootstrap cache push, which can be stale/empty.
          sticky.prunePinned(live.map((t) => t.taskId));
          updateTray();
          break;
        }
        case "sticky-chat-message":
          if (m.threadId) chatSticky.pushMessage(m.threadId, m.payload);
          break;
        case "rtc-frame":
          mainWindow?.webContents.send("rtc:frame", m.frame);
          break;
        case "need-token":
          mainWindow?.webContents.send("token:request");
          break;
      }
    },
  );
}

function quitApp() {
  quitting = true;
  if (wsRestartTimer) {
    clearTimeout(wsRestartTimer);
    wsRestartTimer = null;
  }
  sticky.destroyAll();
  chatSticky.destroyAll();
  app.quit();
}

function createTray() {
  tray = new Tray(trayIcon());
  updateTray();
  tray.on("click", focusMain);
}

function updateTray() {
  if (!tray) return;
  const n = sticky.taskCount();
  tray.setToolTip(`BlissWork${n ? ` — ${n} active task${n > 1 ? "s" : ""}` : ""}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Active tasks: ${n}`, enabled: false },
      { type: "separator" },
      { label: "Show BlissWork", click: focusMain },
      { label: "Quit", click: quitApp },
    ]),
  );
}

/** Runtime validation for the ChatStickyBootstrap IPC payload — a renderer (or a
 *  compromised one) must not be able to drive window creation with a malformed
 *  object. The four ids must be non-empty strings; peerUsername may be empty. */
function isChatStickyBootstrap(v: unknown): v is ChatStickyBootstrap {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  const idFields = ["threadId", "conversationId", "myUserId", "peerUserId"];
  return (
    idFields.every((k) => typeof b[k] === "string" && (b[k] as string).length > 0) &&
    typeof b.peerUsername === "string"
  );
}

// ── IPC from the main renderer ────────────────────────────────────────────────
ipcMain.on("auth:token", (_e, token: string | null) => {
  wsProc?.postMessage({ type: "token", token });
});
ipcMain.on("task:intent", (_e, intent: { taskId: string; action: string }) => {
  wsProc?.postMessage({ type: "intent", ...intent });
});
// Pin an acknowledged task to the desktop as a locked sticky note. Returns the
// authoritative pinned set (+ refusal reason) so the renderer reflects reality.
ipcMain.handle("task:pin", (_e, taskId: unknown) => {
  if (typeof taskId !== "string" || !taskId) {
    return { ok: false, reason: "invalid", pinned: sticky.listPinned() };
  }
  try {
    const res = sticky.pin(taskId);
    updateTray();
    return res;
  } catch (err) {
    console.error("[sticky] task:pin failed", err);
    return { ok: false, reason: "invalid", pinned: sticky.listPinned() };
  }
});
ipcMain.handle("task:list-pinned", () => {
  try {
    return sticky.listPinned();
  } catch (err) {
    console.error("[sticky] task:list-pinned failed", err);
    return [];
  }
});
// A note's renderer has subscribed to "sticky:task" and is ready for its task.
// Re-push it so a did-finish-load push that raced ahead of the renderer's IPC
// listener registration can't strand the note on "Loading…".
ipcMain.on("sticky:ready", (_e, taskId: unknown) => {
  if (typeof taskId !== "string" || !taskId) return;
  try {
    sticky.onRendererReady(taskId);
  } catch (err) {
    console.error("[sticky] sticky:ready failed", err);
  }
});
// Collapse a note to a pill / expand it back (from the note's own renderer).
ipcMain.on("sticky:collapse", (_e, p: unknown) => {
  if (!p || typeof p !== "object") return;
  const { taskId, collapsed } = p as { taskId?: unknown; collapsed?: unknown };
  if (typeof taskId !== "string" || !taskId || typeof collapsed !== "boolean") return;
  try {
    sticky.setCollapsed(taskId, collapsed);
  } catch (err) {
    console.error("[sticky] sticky:collapse failed", err);
  }
});
// Phase 10: renderer → ws-process WebRTC signaling (rtc.offer/answer/ice/cancel).
ipcMain.on("rtc:send", (_e, frame: unknown) => {
  // Only forward a well-formed frame ({ type: string, ... }); never relay an
  // arbitrary object into the ws-process / out over the socket.
  if (!frame || typeof frame !== "object" || typeof (frame as { type?: unknown }).type !== "string") {
    return;
  }
  wsProc?.postMessage({ type: "rtc-send", frame });
});

// Phase 8: pinned-chat sticky widgets ─────────────────────────────────────────
ipcMain.on("sticky:pin-chat", (_e, boot: unknown) => {
  if (!isChatStickyBootstrap(boot)) {
    console.error("[sticky] sticky:pin-chat ignored — invalid payload");
    return;
  }
  chatSticky.pin(boot);
  // Tell ws-process to forward MessageCreated for this thread into the chat
  // sticky pipeline (it filters before posting back).
  wsProc?.postMessage({ type: "sticky-chat-subscribe", threadId: boot.threadId });
});
ipcMain.on("sticky:unpin-chat", (_e, threadId: string) => {
  chatSticky.unpin(threadId);
  wsProc?.postMessage({ type: "sticky-chat-unsubscribe", threadId });
});
ipcMain.handle("sticky:list-pinned-chats", () => chatSticky.pinnedIds());
// A chat window's renderer is ready; re-push its bootstrap (see sticky:ready).
ipcMain.on("sticky-chat:ready", (_e, threadId: unknown) => {
  if (typeof threadId !== "string" || !threadId) return;
  try {
    chatSticky.onRendererReady(threadId);
  } catch (err) {
    console.error("[sticky] sticky-chat:ready failed", err);
  }
});

// IPC originating from a sticky-chat window itself.
ipcMain.on(
  "sticky-chat:send",
  (_e, p: { threadId: string; body: string; clientMsgId: string }) => {
    wsProc?.postMessage({ type: "send-dm", ...p });
  },
);
ipcMain.on("sticky-chat:unpin", (_e, threadId: string) => {
  chatSticky.unpin(threadId);
  wsProc?.postMessage({ type: "sticky-chat-unsubscribe", threadId });
});

app.on("window-all-closed", () => {
  // Keep running in tray (widgets + WS alive) except on explicit quit.
  if (process.platform !== "darwin" && quitting) app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  // Flush any pending sticky-state writes so the user's geometry survives a
  // tray-quit. The atomic temp-then-rename means a SIGKILL during this call
  // still leaves a valid prior file in place.
  flushStickyState();
});
