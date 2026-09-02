import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon } from "./assets";
import { hardenWindow } from "./harden";

/** How long a meeting window is given to disconnect the room and post its
 *  leave before it is destroyed regardless — same budget the app-quit
 *  handshake uses (main/index.ts), for the same reason: no meeting active
 *  is not a case that should exist here (this manager only ever holds
 *  windows that DO have one), but a hung/unresponsive renderer must not
 *  block the window from ever closing. */
const GRACEFUL_CLOSE_TIMEOUT_MS = 1200;

const here = fileURLToPath(new URL(".", import.meta.url));
const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const preloadMain = join(here, "../preload/index.js");
const rendererDir = join(here, "../renderer");

/**
 * Owns the per-meeting windows a call opens into on desktop, so the main
 * window stays free for the rest of the app while a meeting runs — see
 * lib/MeetingSession.tsx's `enter()`, which calls `open()` here instead of
 * rendering the room as an overlay when this bridge is present.
 *
 * A real, first-class window (frame, taskbar entry, focusable) — NOT a
 * companion widget like the sticky notes (ChatStickyManager's closest
 * lifecycle analogue: a Map<id, BrowserWindow>, idempotent open/focus,
 * self-removing on close). It loads the SAME renderer bundle the main window
 * does, hash-routed to /call/:callId, because CallWindow.tsx is already a
 * fully self-contained "callId in, room out" component and LiveKit's
 * Room.connect() needs a real renderer with getUserMedia/RTCPeerConnection —
 * this cannot be a "dumb display" window the way the sticky notes are.
 *
 * No `partition` is set, so the window shares the main window's default
 * session — cookies, granted media/screen-share permissions, and the
 * same-origin BroadcastChannel session mirror (lib/authChannel.ts) all carry
 * over automatically. Only auth needs a deliberate hand-off, because
 * apps/desktop/src/main/index.ts's `fromMainWindow` gate deliberately
 * excludes every window but the tracked main one from credential IPC.
 */
export class MeetingWindowManager {
  private windows = new Map<string, BrowserWindow>();

  /** Notified with a callId whenever one of these windows closes, however it
   *  closed — set once by the caller (main/index.ts) so the main window's
   *  status pill can clear itself even on a non-graceful close (a crash, or
   *  a `destroy()` that skipped the handshake in wireGracefulClose). */
  onClosed?: (callId: string) => void;

  has(callId: string): boolean {
    const w = this.windows.get(callId);
    return !!w && !w.isDestroyed();
  }

  get(callId: string): BrowserWindow | undefined {
    const w = this.windows.get(callId);
    return w && !w.isDestroyed() ? w : undefined;
  }

  all(): BrowserWindow[] {
    return [...this.windows.values()].filter((w) => !w.isDestroyed());
  }

  /** Open a meeting's own window, or focus it if it is already open —
   *  idempotent for the same reason ChatStickyManager.pin() is: joining the
   *  same meeting twice must focus the window already in it, never spawn a
   *  second one. */
  open(callId: string): void {
    const existing = this.windows.get(callId);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    const win = this.createWindow(callId);
    this.windows.set(callId, win);
    this.wireGracefulClose(win);
    this.wireCrashRecovery(win, callId);
    win.on("closed", () => {
      this.windows.delete(callId);
      this.onClosed?.(callId);
    });
  }

  /** Ask a meeting's window to close. Used by the main window's status-pill
   *  hang-up button; the OS close button reaches the exact same handshake
   *  via `BrowserWindow`'s own "close" event, which `win.close()` triggers
   *  identically to a user clicking the window chrome. No-op if the callId
   *  has no open window. */
  requestClose(callId: string): void {
    const win = this.windows.get(callId);
    if (win && !win.isDestroyed()) win.close();
  }

  destroyAll(): void {
    for (const [, w] of this.windows) if (!w.isDestroyed()) w.destroy();
    this.windows.clear();
  }

  /**
   * Pause this window's close just long enough for its renderer to
   * disconnect the LiveKit room and post its leave — same shape as the
   * app-quit handshake in main/index.ts, scoped to one window instead of
   * the whole app. `close` fires identically whether the user clicked the
   * window chrome or something called `win.close()` (requestClose above),
   * so this one handler covers both triggers.
   */
  private wireGracefulClose(win: BrowserWindow): void {
    let closing = false;
    win.on("close", (e) => {
      if (closing) return; // the handshake below is already mid-flight
      if (win.webContents.isDestroyed()) return; // nothing left to ask
      closing = true;
      e.preventDefault();

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(safety);
        ipcMain.removeListener("meeting-window:close-ready", onReady);
        win.destroy();
      };
      const onReady = (ev: IpcMainEvent) => {
        if (ev.sender === win.webContents) finish();
      };
      ipcMain.on("meeting-window:close-ready", onReady);
      win.webContents.send("meeting-window:before-close");
      const safety = setTimeout(finish, GRACEFUL_CLOSE_TIMEOUT_MS);
    });
  }

  /**
   * A renderer crash (`render-process-gone`) does NOT destroy the
   * BrowserWindow — Electron leaves it sitting there blank and unresponsive,
   * still reporting `!isDestroyed()`. Without this, has()/get()/open() went
   * on treating that window as alive, so a retried open(callId) — e.g. the
   * user clicking Join again after the meeting window froze — just
   * re-focused the dead window instead of ever recovering the meeting.
   *
   * Only forces the window closed here. Cleanup (dropping it from
   * `windows`, firing onClosed) stays the SINGLE job of the "closed"
   * listener wired in open() above, exactly like every other way one of
   * these windows can go away (the OS close button, the hang-up button,
   * destroyAll() at quit) — so the status pill clears the same way
   * regardless of which of those this was. A crashed renderer cannot answer
   * wireGracefulClose's own handshake, so this destroys the window directly
   * rather than routing through requestClose()/win.close().
   */
  private wireCrashRecovery(win: BrowserWindow, callId: string): void {
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error("[meeting-window] renderer gone", callId, details.reason);
      if (!win.isDestroyed()) win.destroy();
    });
  }

  private createWindow(callId: string): BrowserWindow {
    const win = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 720,
      minHeight: 480,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#16181f",
      title: "Meeting · BlissWork",
      icon: appIcon(),
      webPreferences: {
        preload: preloadMain,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    hardenWindow(win, "meeting");

    // A real (non-hash) query string, read by the preload via location.search
    // the same way sticky.ts reads its own taskId/collapsed — proven to work
    // regardless of what the hash router does with the rest of the URL.
    // callId rides here too rather than in a hash the router would have to
    // race against on first paint; renderer/main.tsx seeds location.hash from
    // it, imperatively, before the app ever renders — the same technique
    // onMeetingDeepLink already uses for an inbound deep link.
    const query = `?w=meeting&callId=${encodeURIComponent(callId)}`;
    if (DEV_URL) void win.loadURL(`${DEV_URL}${query}`);
    else void win.loadFile(join(rendererDir, "index.html"), { search: query });

    win.on("ready-to-show", () => win.show());
    return win;
  }
}
