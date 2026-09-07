import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, powerMonitor, screen, session, shell, Tray, utilityProcess, UtilityProcess } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StickyTaskDTO } from "@taskboard/shared";
import { createMainWindow } from "./windows";
import { StickyManager } from "./sticky-manager";
import {
  onShouldFloatChange,
  startAppActiveWatch,
  stopAppActiveWatch,
  trackMainWindow,
} from "./app-active";
import { ChatStickyManager, type ChatStickyBootstrap } from "./chat-sticky-manager";
import { MeetingInviteManager } from "./meeting-invite-manager";
import { MeetingWindowManager } from "./meeting-window-manager";
import { initCache, getTasks, setTasks } from "./cache";
import {
  initSessionToken,
  getRefreshToken,
  setRefreshToken,
  clearRefreshToken,
} from "./session-token";
import * as notificationPrefs from "./notification-prefs";
import { flushSync as flushStickyState, initStickyState } from "./sticky-state";
import { trayIcon } from "./assets";
import { buildAppMenu } from "./menu";
import { registerFileSink } from "./file-sink";
import { registerAttachmentOpen } from "./attachment-open";
import { checkForUpdatesNow, checkOnWindowFocus, initAutoUpdate } from "./updater";
import { installLocationProviderKey, hasPreciseLocationProvider } from "./geo-key";
import { locationSettingsUrl } from "../shared/location-settings";
import { mediaSettingsUrl } from "../shared/media-settings";
import { initScreenshotGuard } from "./screenshot-guard";
import { initWindowStateGuard } from "./window-state-guard";
import { popupFor, raise, shouldNotify, userIdFromToken, windowStateOf } from "./notifier";
import { resolveEndpointsFromEnv } from "../shared/endpoints";
import { findDeepLink, parseDeepLink } from "../shared/deeplink";
import { openExternalSafely } from "./harden";
import { forwardDeepLinkWhenReady } from "./deep-link-forwarder";

const here = fileURLToPath(new URL(".", import.meta.url));

// Service endpoints for the ws-process (single WS + task REST client). A
// PACKAGED build (app.isPackaged) targets the hosted BlissWork backend on
// communication.rnrtechs.com so a downloaded installer works with no config;
// dev (running from node_modules/electron) targets the local compose stack.
// TB_* env overrides win for custom deployments. MUST stay in lock-step with
// the renderer defaults in src/renderer/main.tsx.
// Endpoint defaults live in src/shared/endpoints.ts — shared verbatim with the
// renderer so the two processes can never disagree about which backend this
// build talks to. TB_* env overrides win for custom deployments.
const ENDPOINTS = resolveEndpointsFromEnv(app.isPackaged, {
  authBase: process.env.TB_AUTH_BASE,
  taskBase: process.env.TB_TASK_BASE,
  notificationBase: process.env.TB_NOTIFICATION_BASE,
  messagingBase: process.env.TB_MESSAGING_BASE,
  // See the note in src/renderer/main.tsx: this key was missing from both
  // override maps, making TB_TELEMETRY_BASE silently inert on desktop.
  telemetryBase: process.env.TB_TELEMETRY_BASE,
  stickyBase: process.env.TB_STICKY_BASE,
  wsUrl: process.env.TB_WS_URL,
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let wsProc: UtilityProcess | null = null;
let quitting = false;
// Separate from `quitting`: quitApp() (tray/menu Quit) already sets
// `quitting = true` BEFORE calling app.quit() — the very call that fires
// `before-quit` — so reusing that flag as this section's re-entry guard
// would make the most common quit path skip the notify-and-wait sequence
// below entirely. This one only guards against starting that sequence twice
// (e.g. a second Cmd+Q while the first quit is still waiting on its timeout).
let quitTeardownStarted = false;
// ws-process crash-recovery state: exponential backoff so a persistently
// crashing child doesn't spin-restart, reset once the child is healthy again.
let wsRestarts = 0;
let wsRestartTimer: NodeJS.Timeout | null = null;
// The signed-in user id, kept in step with the renderer's access token. Read
// ONLY to decide whether an incoming event is the user's own doing — see
// notifier.userIdFromToken, which is explicit that this is not authentication.
let sessionUserId: string | null = null;
const sticky = new StickyManager();
const chatSticky = new ChatStickyManager();
const meetingInvite = new MeetingInviteManager();
const meetingWindows = new MeetingWindowManager();
// So the main window's status pill (see the meeting-window:status/closed
// channels below) clears itself even on a non-graceful close — a crash, or
// destroyAll() at quit, both of which skip the window's own close handshake.
meetingWindows.onClosed = (callId) => mainWindow?.webContents.send("meeting-window:closed", callId);

// Last-resort guards: the app runs in the tray with always-on-top notes that
// must outlive a stray error in an IPC handler or async callback. Log and keep
// running rather than letting an unhandled error tear the process down.
process.on("uncaughtException", (err) => console.error("[main] uncaughtException", err));
process.on("unhandledRejection", (reason) => console.error("[main] unhandledRejection", reason));

// Chromium refuses to play audio in a document that has never been clicked, so
// an incoming-call ringtone can be silent in a window the user has not touched
// since launch. That policy exists to stop hostile PAGES autoplaying at you; in
// a desktop app that only ever loads our own origin there is nothing to defend
// against, and a call that rings silently is a real bug. Must be set before
// `ready` — Chromium reads its command line during startup.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Same timing rule as the switch above, for the same reason: Chromium reads the
// geolocation API key while it builds its network context during startup, so
// installing it inside `whenReady` is a silent no-op. Without a key the network
// locator is dead and `getCurrentPosition` can only fall back to an OS locator —
// which Linux does not have. See geo-key.ts.
installLocationProviderKey();

// Single-instance: focus existing + forward deep-link.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    focusMain();
    // focusMain() only constructs/shows/focuses the window — it does not
    // wait for the renderer to be ready the way the argv cold-start path
    // below does — so forwarding cannot just call forwardDeepLink directly
    // here. See deep-link-forwarder.ts.
    if (mainWindow) forwardDeepLinkWhenReady(mainWindow, findDeepLink(argv), forwardDeepLink);
  });
  app.whenReady().then(() => {
    // WebRTC calls need camera/mic. Electron DENIES media by default; the app
    // only ever loads our own origin, so granting "media" (and nothing else) is
    // safe. NOTE: macOS packaged/notarized builds ALSO require
    // NSCameraUsageDescription + NSMicrophoneUsageDescription (Info.plist) and the
    // com.apple.security.device.{camera,audio-input} entitlements, or the OS
    // blocks capture before this handler is ever consulted.
    // "geolocation" joins "media" here: sharing your location in chat goes
    // through navigator.geolocation, and Electron's default DENY meant every
    // attempt failed with PERMISSION_DENIED before it could even reach a
    // location provider. Still a closed allowlist — notifications, MIDI, USB,
    // clipboard-read and the rest stay denied.
    //
    // Granting is necessary but not sufficient: Chromium's NETWORK locator
    // needs a Google API key that Electron does not ship, so on a machine with
    // no OS-level provider (typically Linux) getCurrentPosition still fails.
    // useChatMedia falls back to /maps/whereami for exactly that case.
    //
    // NOTE for packaged macOS builds: CoreLocation is gated by the OS before
    // this handler is consulted, so Info.plist needs
    // NSLocationWhenInUseUsageDescription — see electron-builder config.
    //
    // "picture-in-picture" is the meeting's floating window: Electron is
    // Chromium, so requestPictureInPicture() on the stage's <video> produces
    // a real always-on-top OS window with no second BrowserWindow and no
    // second call connection — see lib/useMeetingPiP. Denied by default like
    // everything else here, so without this the request would just fail.
    const allowed = new Set(["media", "geolocation", "picture-in-picture"]);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

    // Screen sharing in a call. getDisplayMedia() is REFUSED outright in
    // Electron unless this handler exists — there is no Chromium picker in an
    // app shell, so the choice of what to capture has to be made here.
    //
    // useSystemPicker hands that choice to the OS on macOS and Windows, which
    // is the right answer wherever it is available: the user picks from the
    // platform's own dialog, with its own thumbnails and its own idea of what
    // an app is allowed to see. Where it is not available (Linux) Electron
    // falls back to this callback, and the primary screen is what it gets —
    // the in-call panel makes a running share impossible to miss, and its Stop
    // button is one click away.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ["screen"] })
          .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
          // An empty stream is how this API says "cancelled", which the
          // renderer already treats as a non-event rather than an error.
          .catch(() => callback({}));
      },
      { useSystemPicker: true },
    );
    bootstrap();
    // Check for a newer release + auto-update (packaged non-Store builds only).
    initAutoUpdate(() => mainWindow);
    // Screenshot deterrence. Content protection itself is applied per-window by
    // hardenWindow; this wires the focus-scoped capture-key registration and
    // routes a detected attempt to the renderer's toast. Read the header of
    // screenshot-guard.ts before treating this as a guarantee — it is not one
    // on Linux, and it is not one against a phone camera anywhere.
    // Put the window back if the platform minimised or restored it down while
    // the machine was locked or asleep. Nothing here does that on its own — see
    // window-state-guard.ts for why it is a restoration rather than a
    // prevention.
    initWindowStateGuard(() => mainWindow);

    initScreenshotGuard((chord, recorded) => {
      // `recorded` travels with the notice so the renderer reports the attempt
      // to the server only when main could not — see screenshot-guard.ts.
      mainWindow?.webContents.send("security:screenshot-blocked", { chord, recorded });
    });
  });
}

// Windows: bind this process to the installed app's identity. Without it the
// shell treats us as a generic Electron host — the taskbar button shows the
// stock Electron icon instead of ours, taskbar pinning targets the wrong thing,
// and toast notifications are attributed to "Electron". Must match the
// `appId` in package.json's electron-builder config, because that is what the
// NSIS/AppX installer stamps on the Start-menu shortcut. No-op off Windows.
app.setAppUserModelId("com.blisswork.desktop");

// Custom protocol for emailed invite + meeting-join deep-links.
if (process.defaultApp) app.setAsDefaultProtocolClient("taskboard", process.execPath, [process.argv[1] ?? ""]);
else app.setAsDefaultProtocolClient("taskboard");

app.on("open-url", (_e, url) => {
  focusMain();
  // Same race as second-instance above (this is macOS's own entry point for
  // the identical cold-start problem) — see deep-link-forwarder.ts.
  if (mainWindow) forwardDeepLinkWhenReady(mainWindow, url, forwardDeepLink);
});

function bootstrap() {
  initCache();
  initSessionToken();
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

  // COLD START: on Windows/Linux a deep link that LAUNCHES the app arrives in
  // argv, not through `second-instance` (which only fires when an instance is
  // already running) and not through `open-url` (macOS only). Without this,
  // clicking an invite or a meeting-join link while the app is closed opens a
  // blank app and silently drops the token. Wait for the renderer to be ready,
  // or the IPC lands before anything is listening.
  const launchLink = findDeepLink(process.argv);
  if (launchLink) {
    mainWindow.webContents.once("did-finish-load", () => forwardDeepLink(launchLink));
  }

  startWsProcess();
  createTray();
  registerFileSink(() => mainWindow);
  registerAttachmentOpen(() => mainWindow);

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

  // Keep the task notes on screen exactly while the user can see their desktop
  // — whether that is BlissWork itself in front or the bare desktop with
  // BlissWork minimised or in the tray — and take them off the moment another
  // application is. See ./app-active for how that reading is made, and why it
  // is safe to consult the OS for it.
  onShouldFloatChange((safe) => sticky.setSafeToFloat(safe));
  startAppActiveWatch();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      wireMainWindow(mainWindow);
    }
  });
}

function wireMainWindow(win: BrowserWindow) {
  // The task notes are DESKTOP widgets, not children of this window — they
  // outlive it being minimised or closed to the tray. This window is still
  // tracked, because its focus is one of the two reasons a note may be on
  // screen. Re-pointed here rather than captured once, because it can be
  // recreated (macOS `activate`, the tray path).
  trackMainWindow(win);

  // Intercept close to keep running in the tray, so the widgets + WS survive
  // the window being dismissed. A real quit sets `quitting`.
  // Windows only, and it must be registered BEFORE the close handler below so
  // `quitting` is already set by the time the shutdown's close arrives —
  // otherwise the app hides itself instead of quitting, which is what made the
  // window appear to minimise when the machine was shut down.
  win.on("session-end", onSystemShutdown);

  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Task-note visibility is NOT wired here: ./app-active listens app-wide, so
  // that focus moving between BlissWork's own windows (main window → a chat
  // note) never reads as leaving the app. Chat stickies are a separate feature
  // with their own (unchanged) always-behind behaviour.
  win.on("focus", () => {
    chatSticky.lowerZOrder();
    checkOnWindowFocus();
  });
  win.on("blur", () => {
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

/**
 * Route one taskboard:// deep link to the renderer.
 *
 *   taskboard://invite?token=…          → an emailed invite
 *   taskboard://join?t=…                → a meeting link, handed off from
 *                                         the browser landing page at /join
 *
 * Parsing lives in shared/deeplink.ts so it can be unit-tested; this function
 * only maps the result onto an IPC channel.
 */
function forwardDeepLink(url?: string) {
  const link = parseDeepLink(url);
  if (!link) return;
  if (link.kind === "meeting") {
    mainWindow?.webContents.send("deeplink:meeting", link.token);
  } else {
    mainWindow?.webContents.send("deeplink:invite", link.token);
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
      /** True for the connect-time catch-up burst — see WsEventMeta. */
      replayed?: boolean;
      tasks?: StickyTaskDTO[];
      /** Task ids sticky-svc still considers open commitments for this user.
       *  Absent when that service is not configured or was unreachable, which
       *  is the signal to keep today's task-svc-only behaviour. */
      openPins?: string[];
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
          mainWindow?.webContents.send("ws:event", m.event, { replayed: m.replayed === true });
          // Live events only. The replayed burst is everything that happened
          // while this client was offline, so popping one notification per item
          // would bury the desktop on every reconnect — and the user has
          // already been told about all of it by whatever device was awake.
          if (m.replayed !== true) maybeNotify(m.event);
          break;
        case "sticky": {
          const live = m.tasks ?? [];
          setTasks(live);
          // Durable pin set from sticky-svc, when it is deployed and reachable.
          // Purely ADDITIVE: it can restore a pin this machine has never seen
          // (a reinstall, or a second device), and it can never remove one —
          // prunePinned below still answers only to the task-svc list.
          if (m.openPins) sticky.adoptServerPins(m.openPins);
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

/**
 * Raise an OS notification for one live event, if it deserves one and the app
 * is not already in front of the user.
 *
 * This is the whole of "notify me when the window is closed": the ws-process
 * keeps running in the tray, so the events were always arriving — they just had
 * nowhere visible to go. Clicking the popup brings the window back.
 */
function maybeNotify(event: unknown) {
  if (!notificationPrefs.getDesktopEnabled()) return;
  if (!shouldNotify(windowStateOf(mainWindow))) return;
  const popup = popupFor(event, sessionUserId);
  if (popup) raise(popup, focusMain);
}

function quitApp() {
  quitting = true;
  if (wsRestartTimer) {
    clearTimeout(wsRestartTimer);
    wsRestartTimer = null;
  }
  sticky.destroyAll();
  chatSticky.destroyAll();
  meetingInvite.destroy();
  meetingWindows.destroyAll();
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
// Open a URL in the user's DEFAULT browser — used for handoffs like the
// WhatsApp forward link and map links, which have no business opening inside
// the app's own renderer.
//
// The allowlist lives in shared/external-url.ts and is shared with the
// window-open / navigation guards in harden.ts, so every path from renderer
// content to the OS enforces one rule rather than three similar ones.
ipcMain.on("shell:open-external", (_e, raw: unknown) => {
  openExternalSafely(raw, "ipc");
});

// Which build is this? Shown in Settings → About so a stale desktop app is
// visible rather than silently missing features the web app already has.
ipcMain.handle("app:version", () => app.getVersion());

ipcMain.handle("app:check-updates", () => checkForUpdatesNow());

// Whether this build can get a PRECISE fix. False still shares a location — the
// server's IP lookup answers — it just means the pin will be city-level, and
// saying so up front beats letting the user watch a ten-second timeout and
// guess. See geo-key.ts.
ipcMain.handle("geo:precise", () => hasPreciseLocationProvider());

// Open the OS page where location access for desktop apps is granted.
//
// Takes NO argument. That is the whole security design: `shell.openExternal`
// hands a URL to whichever app registered the scheme, and `ms-settings:` is in
// the same Windows family as the handlers external-url.ts refuses to open. The
// renderer cannot influence the string — it asks to open "the location settings
// page", main decides what that is from a fixed per-platform map, and nothing
// crosses the boundary. Adding a url parameter here would undo that; don't.
//
// Returns false where the platform has no such page (Linux), though the preload
// omits the bridge method there so the renderer never offers the button.
ipcMain.handle("geo:open-settings", async () => {
  const url = locationSettingsUrl();
  if (!url) return false;
  await shell.openExternal(url);
  return true;
});

// Same design as geo:open-settings above, one per media kind: no argument,
// main resolves the fixed per-platform URL itself. See shared/media-settings.
ipcMain.handle("media:open-camera-settings", async () => {
  const url = mediaSettingsUrl("camera");
  if (!url) return false;
  await shell.openExternal(url);
  return true;
});
ipcMain.handle("media:open-microphone-settings", async () => {
  const url = mediaSettingsUrl("microphone");
  if (!url) return false;
  await shell.openExternal(url);
  return true;
});

// The auth channels carry credentials, so they are the one IPC group that must
// not accept traffic from any window that happens to have a preload. Only the
// main window ever holds a session; the sticky windows load different preloads
// and have no business touching tokens.
function fromMainWindow(e: { sender: Electron.WebContents }): boolean {
  return e.sender === mainWindow?.webContents;
}

ipcMain.on("auth:token", (e, token: string | null) => {
  if (!fromMainWindow(e)) return;
  // Every token change comes through here (login, refresh, sign-out), which
  // makes it the one place that always knows who is signed in.
  sessionUserId = userIdFromToken(token);
  wsProc?.postMessage({ type: "token", token });
});

// See src/main/session-token.ts: the packaged renderer is on file://, so it
// cannot send the SameSite=lax refresh cookie itself and reads the token here
// to put in the /auth/refresh body instead.
ipcMain.handle("auth:refresh-token", (e) => {
  if (!fromMainWindow(e)) return null;
  return getRefreshToken();
});

ipcMain.on("auth:set-refresh-token", (e, token: unknown) => {
  if (!fromMainWindow(e)) return;
  if (token === null) {
    void clearRefreshToken();
    return;
  }
  if (typeof token !== "string" || !token) return;
  setRefreshToken(token);
});
// ── Desktop notification preference ──────────────────────────────────────────
// The renderer's own copy lives in localStorage (see
// packages/app/src/lib/notificationPrefs.ts); this mirror is what
// maybeNotify() reads before raising an OS popup for a message/task/call
// while the window is minimised or in the tray, since main has no access to
// the renderer's localStorage. Guarded by fromMainWindow for the same reason
// every other renderer-facing preference here is.
ipcMain.handle("notifications:get-desktop-enabled", (e) => {
  if (!fromMainWindow(e)) return true;
  return notificationPrefs.getDesktopEnabled();
});

ipcMain.handle("notifications:set-desktop-enabled", (e, enabled: unknown) => {
  if (!fromMainWindow(e)) return;
  notificationPrefs.setDesktopEnabled(enabled === true);
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
// Take a note off screen for the rest of this run. Sent ONLY by the note's own
// X — not by opening the task, which is reading it, not dealing with it. The
// pin survives, so the note is back on the next launch if the task is still
// actionable; only completing or ignoring it removes it for good.
ipcMain.on("sticky:dismiss", (_e, taskId: unknown) => {
  if (typeof taskId !== "string" || !taskId) return;
  try {
    sticky.hideForSession(taskId);
    updateTray();
  } catch (err) {
    console.error("[sticky] sticky:dismiss failed", err);
  }
});
// The carousel window's renderer has subscribed to "sticky:tasks" and is
// ready for the current page. Re-push it so a did-finish-load push that
// raced ahead of the renderer's IPC listener registration can't strand the
// note on "Loading…".
ipcMain.on("sticky:ready", () => {
  try {
    sticky.onRendererReady();
  } catch (err) {
    console.error("[sticky] sticky:ready failed", err);
  }
});
// Page the carousel to the next/previous pinned task (from the note's own
// nav arrows).
ipcMain.on("sticky:next", () => {
  try {
    sticky.next();
  } catch (err) {
    console.error("[sticky] sticky:next failed", err);
  }
});
ipcMain.on("sticky:prev", () => {
  try {
    sticky.prev();
  } catch (err) {
    console.error("[sticky] sticky:prev failed", err);
  }
});
// Collapse the container to a pill / expand it back (from the note's own renderer).
ipcMain.on("sticky:collapse", (_e, p: unknown) => {
  if (!p || typeof p !== "object") return;
  const { collapsed } = p as { collapsed?: unknown };
  if (typeof collapsed !== "boolean") return;
  try {
    sticky.setCollapsed(collapsed);
  } catch (err) {
    console.error("[sticky] sticky:collapse failed", err);
  }
});
// The note's own renderer reporting its resolved theme colour (see
// StickyManager.setBackgroundColor for why the window needs telling at all).
ipcMain.on("sticky:bg", (_e, p: unknown) => {
  if (!p || typeof p !== "object") return;
  const { color } = p as { color?: unknown };
  if (typeof color !== "string" || !color) return;
  try {
    sticky.setBackgroundColor(color);
  } catch (err) {
    console.error("[sticky] sticky:bg failed", err);
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

// ── Meeting-invite popup (desktop-level, always-on-top) ──────────────────────
// The renderer-driven counterpart of features/IncomingMeetingNotice — see
// main/meeting-invite-manager.ts's own doc comment for the full design. Only
// the MAIN window ever announces an invite (it is the one running the query
// bridge that hears call.started/call.waiting/call.ring), so this is guarded
// by fromMainWindow the same way the auth channels are.
ipcMain.on("meeting-invite:show", (e, payload: unknown) => {
  if (!fromMainWindow(e)) return;
  if (!payload || typeof payload !== "object") return;
  const { callId, title, organizer } = payload as Record<string, unknown>;
  if (typeof callId !== "string" || !callId || typeof title !== "string") return;
  meetingInvite.show({ callId, title, organizer: typeof organizer === "string" ? organizer : "" });
});

// The call this popup was announcing ended, or was answered elsewhere, while
// it was still on screen (see queryBridge's CallEnded/CallParticipantAdded
// handling and IncomingMeetingNotice's onIncomingMeetingDismissed). Same
// sender as meeting-invite:show — only the main window's query bridge hears
// those events.
ipcMain.on("meeting-invite:dismiss", (e, callId: unknown) => {
  if (!fromMainWindow(e)) return;
  if (typeof callId !== "string" || !callId) return;
  meetingInvite.dismiss(callId);
});

// From the invite popup's OWN window/preload, not the main window — same
// trust level as sticky:dismiss (a callId + a choice of three fixed actions,
// nothing session-bearing). Video/Voice bring the main window forward and
// hand the join off to it (requestMeetingJoin lives in the shared app code,
// which only the main window renders); Leave just clears the popup. Sender
// is verified against the popup MeetingInviteManager actually has open
// rather than trusted implicitly — same pattern meeting-window:status below
// uses against MeetingWindowManager.all(). Not exploitable today (only the
// popup's own hardened preload exposes this channel), but nothing stops a
// future window/preload from picking up the same channel name by accident.
ipcMain.on("meeting-invite:act", (e, payload: unknown) => {
  if (!payload || typeof payload !== "object") return;
  const { callId, action } = payload as Record<string, unknown>;
  if (typeof callId !== "string" || !callId) return;
  if (meetingInvite.currentWindow()?.webContents !== e.sender) return;
  if (action === "video" || action === "voice") {
    focusMain();
    mainWindow?.webContents.send("meeting-invite:join", { callId, media: action });
  } else if (action !== "leave") {
    return;
  }
  meetingInvite.dismiss(callId);
});

// The invite popup's own renderer has registered its "meeting-invite:update"
// listener and is ready — re-push the latest invite so an update that raced
// ahead of it (IncomingMeetingNotice's second call, once the organizer
// resolves) can't be silently lost. Same handshake as sticky:ready, same
// sender check as meeting-invite:act above.
ipcMain.on("meeting-invite:ready", (e, callId: unknown) => {
  if (typeof callId !== "string" || !callId) return;
  if (meetingInvite.currentWindow()?.webContents !== e.sender) return;
  try {
    meetingInvite.onRendererReady(callId);
  } catch (err) {
    console.error("[meeting-invite] meeting-invite:ready failed", err);
  }
});

// ── Meeting window (desktop-only) ────────────────────────────────────────────
// Open (or focus) a meeting in its own window — see main/meeting-window-manager.ts
// and lib/MeetingSession.tsx's `enter()`, which calls this instead of rendering
// the room as an overlay when the bridge is present. Ungated: no credentials
// cross this channel, same trust level as sticky:pin-chat/task:pin.
ipcMain.on("meeting-window:open", (_e, payload: unknown) => {
  if (!payload || typeof payload !== "object") return;
  const { callId } = payload as Record<string, unknown>;
  if (typeof callId !== "string" || !callId) return;
  meetingWindows.open(callId);
});

// Forward a meeting window's own live status to the main window's status
// pill (features/MeetingWindowStatusBar.tsx). Sender must be a window this
// manager actually opened — informational only (no credentials), same light
// shape-check as rtc:send's frame, but worth confirming the sender is who it
// claims to be rather than trusting an arbitrary payload's own callId.
ipcMain.on("meeting-window:status", (e, status: unknown) => {
  if (!status || typeof status !== "object") return;
  if (typeof (status as Record<string, unknown>).callId !== "string") return;
  if (!meetingWindows.all().some((w) => w.webContents === e.sender)) return;
  mainWindow?.webContents.send("meeting-window:status", status);
});

// The status pill's hang-up button. Round-trips to the window that actually
// owns the live LiveKit room — see MeetingWindowManager.requestClose, which
// reaches the exact same graceful-close handshake the OS close button uses.
ipcMain.on("meeting-window:hangup", (_e, callId: unknown) => {
  if (typeof callId !== "string" || !callId) return;
  meetingWindows.requestClose(callId);
});

app.on("window-all-closed", () => {
  // Keep running in tray (widgets + WS alive) except on explicit quit.
  if (process.platform !== "darwin" && quitting) app.quit();
});

/**
 * The OS is shutting down, logging out, or restarting.
 *
 * Without this the shutdown reads as an ordinary window close, so the handler
 * in wireMainWindow preventDefaults it and calls `win.hide()` — the window
 * disappears (users read that as "it minimised itself"), the app is killed a
 * moment later, and nothing has flushed. Setting `quitting` lets the close fall
 * through to a real quit, and flushing here means the window's geometry is on
 * disk even if the kill arrives before `before-quit` does.
 *
 * Both signals are wired because neither is universal. `session-end` is a
 * BrowserWindow event and Windows-only (WM_ENDSESSION); powerMonitor's
 * `shutdown` is what Linux and macOS emit. The handler is idempotent, so a
 * platform that delivers both is harmless.
 */
function onSystemShutdown(): void {
  quitting = true;
  flushStickyState();
  // Best-effort only — see before-quit below for the real notify-and-wait
  // sequence. OS shutdown runs on a budget this app does not control (Windows
  // can force-terminate a slow WM_ENDSESSION responder), so this never
  // preventDefaults the close or waits on a reply; it just gives an active
  // meeting a CHANCE to hear about it if the renderer is still around to.
  // Targets meeting windows, not mainWindow — see the before-quit handler's
  // own comment on why nothing in mainWindow's renderer answers this anymore.
  for (const w of meetingWindows.all()) w.webContents.send("app:before-quit");
}

powerMonitor.on("shutdown", onSystemShutdown);

/**
 * Give every active meeting a chance to leave cleanly before the process dies.
 *
 * Neither a hang-up click nor a React unmount is coming on a real quit — the
 * renderer can be torn down before either runs — so without this, the server
 * is never told the user left and the "resume this meeting" marker never
 * clears (see MeetingSession.tsx). This pauses the quit just long enough for
 * every open meeting window's renderer to disconnect its room and call
 * leaveCall(), then lets the quit proceed either way.
 *
 * Targets meeting windows, NOT mainWindow: `enter()` (MeetingSession.tsx)
 * opens a meeting in its own window instead of rendering CallRoom as an
 * overlay in this one now, so nothing in mainWindow's renderer subscribes to
 * app:before-quit any more — waiting on it here would either hang out the
 * full safety timeout on every ordinary quit or (with no listener ever
 * answering) do so unconditionally. The common case — no meeting open — must
 * stay exactly as fast as it always was, which is why this skips the wait
 * entirely when meetingWindows.all() is empty.
 */
app.on("before-quit", (e) => {
  quitting = true;
  stopAppActiveWatch();
  // Flush any pending sticky-state writes so the user's geometry survives a
  // tray-quit. The atomic temp-then-rename means a SIGKILL during this call
  // still leaves a valid prior file in place.
  flushStickyState();

  if (quitTeardownStarted) return;
  quitTeardownStarted = true;

  const targets = meetingWindows
    .all()
    .map((w) => w.webContents)
    .filter((wc) => !wc.isDestroyed());
  if (targets.length === 0) {
    finishQuit();
    return;
  }

  e.preventDefault();
  let remaining = targets.length;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(safety);
    ipcMain.removeListener("app:quit-ready", onReady);
    finishQuit();
  };
  const onReady = (ev: Electron.IpcMainEvent) => {
    if (!targets.includes(ev.sender)) return;
    remaining--;
    if (remaining <= 0) finish();
  };
  ipcMain.on("app:quit-ready", onReady);
  for (const wc of targets) wc.send("app:before-quit");
  // Bounds the WORST case (every meeting window hangs) to the same 1200ms a
  // single one always waited — acks arrive independently, so this is not
  // "1200ms per window".
  const safety = setTimeout(finish, 1200);
});

function finishQuit(): void {
  // Reuses the same graceful-close path explicit sign-out already sends (see
  // ws-process.ts's `case "token"`), rather than abandoning the socket.
  wsProc?.postMessage({ type: "token", token: null });
  sticky.destroyAll();
  chatSticky.destroyAll();
  meetingInvite.destroy();
  meetingWindows.destroyAll();
  // app.exit(), not app.quit() — Electron does not re-emit before-quit/
  // will-quit for app.exit(), so this cannot loop back into the handler above.
  app.exit(0);
}
