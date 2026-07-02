import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clampToPrimary,
  forget,
  gc,
  getGeometry,
  isOnPrimary,
  saveGeometry,
  touch,
} from "./sticky-state";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const preloadStickyChat = join(here, "../preload/sticky-chat.js");
const rendererDir = join(here, "../renderer");

/**
 * MAX_CHAT_WIDGETS: per the Phase 8 spec we allow up to 4 chat widgets in
 * addition to MAX_WIDGETS=5 task widgets (the docs called for 8/4=12; we set
 * the lower per-kind quota here so tasks always have their slot). A 12-slot
 * cap settings-gated raise lives in the settings page (not yet wired).
 */
const MAX_CHAT_WIDGETS = 4;

const SCREEN_PAD = 4;

/** Bootstrap payload the main process sends into a chat-sticky window on
 *  first paint. The renderer uses myUserId to render its own bubbles on the
 *  right; peerUsername titles the header. */
export interface ChatStickyBootstrap {
  threadId: string;
  conversationId: string;
  myUserId: string;
  peerUserId: string;
  peerUsername: string;
}

/**
 * Owns the manually-pinned chat sticky windows. Mirror of StickyManager but
 * keyed by threadId. Tasks auto-pin; chats are pinned by an explicit user
 * action (📌 button on the thread header) via IPC sticky:pin-chat.
 *
 * Lifecycle:
 *   pin(threadId, bootstrap)  → create-or-focus
 *   unpin(threadId)           → close + forget geometry
 *   pinnedIds()               → set of currently pinned threadIds
 *
 * Geometry is shared with the task widgets via sticky-state.ts (different
 * keyspace — task widget keys are taskIds, chat widget keys are threadIds).
 */
export class ChatStickyManager {
  private widgets = new Map<string, BrowserWindow>();
  /** Latest bootstrap per pinned thread, so a ready-handshake (or focus
   *  re-pin) can re-push it without the caller re-supplying it. */
  private boots = new Map<string, ChatStickyBootstrap>();

  pinnedIds(): string[] {
    return [...this.widgets.keys()];
  }

  /** A chat window's renderer has registered its listeners and is ready. Re-push
   *  its bootstrap so a did-finish-load push that raced ahead of the listener
   *  registration can't leave it stuck on "Loading thread…". */
  onRendererReady(threadId: string): void {
    const w = this.widgets.get(threadId);
    const boot = this.boots.get(threadId);
    if (w && !w.isDestroyed() && boot) this.push(w, boot);
  }

  has(threadId: string): boolean {
    const w = this.widgets.get(threadId);
    return !!w && !w.isDestroyed();
  }

  /** Pin a thread to the desktop. Idempotent: re-pinning focuses the
   *  existing widget instead of creating a duplicate. */
  pin(boot: ChatStickyBootstrap): void {
    this.boots.set(boot.threadId, boot);
    const existing = this.widgets.get(boot.threadId);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      touch(boot.threadId);
      this.push(existing, boot);
      return;
    }
    if (this.widgets.size >= MAX_CHAT_WIDGETS) {
      // Drop the oldest chat sticky to honour the quota. Map iteration order
      // is insertion order, so the first entry is always the oldest. The
      // guard above guarantees the map is non-empty.
      const oldest = this.widgets.entries().next().value;
      if (oldest) {
        const [firstKey, firstWin] = oldest;
        if (!firstWin.isDestroyed()) firstWin.close();
        this.widgets.delete(firstKey);
        this.boots.delete(firstKey);
      }
    }
    const w = this.createWindow(boot.threadId);
    this.widgets.set(boot.threadId, w);
    this.positionWidget(w, boot.threadId);
    this.wireGeometryPersistence(w, boot.threadId);
    const ww = w;
    w.webContents.on("did-finish-load", () => this.push(ww, boot));
  }

  /** Unpin (close) a chat sticky. The thread stays in the inbox; only the
   *  desktop widget goes away. */
  unpin(threadId: string): void {
    const w = this.widgets.get(threadId);
    if (w && !w.isDestroyed()) w.close();
    this.widgets.delete(threadId);
    this.boots.delete(threadId);
    forget(threadId);
  }

  /** Forward a new message into the sticky's webContents — the renderer
   *  appends it to the bubble feed without a round-trip. ws-process drives
   *  this from MessageCreated whose threadId is in pinnedThreads. */
  pushMessage(threadId: string, payload: unknown): void {
    const w = this.widgets.get(threadId);
    if (w && !w.isDestroyed()) w.webContents.send("sticky-chat:message", payload);
  }

  /** Main window focused: drop chat notes to normal z-order so they don't cover
   *  the app. Paired with raiseZOrder on blur. (Matches StickyManager so the
   *  whole sticky surface moves together.) */
  lowerZOrder(): void {
    for (const [, w] of this.widgets) if (!w.isDestroyed()) w.setAlwaysOnTop(false);
  }

  /** Main window blurred: float chat notes back over the desktop at the lightest
   *  always-on-top level so they stay visible on the main screen. */
  raiseZOrder(): void {
    for (const [, w] of this.widgets) if (!w.isDestroyed()) w.setAlwaysOnTop(false);
  }

  /** Re-confine every live chat note to the primary display (display change). */
  reclampAll(): void {
    for (const [, w] of this.widgets) {
      if (w.isDestroyed()) continue;
      const b = w.getBounds();
      if (isOnPrimary(b)) continue;
      const g = clampToPrimary({ ...b, minimized: false, lastSeenAt: 0 });
      w.setBounds({ x: g.x, y: g.y, width: b.width, height: b.height });
    }
  }

  destroyAll(): void {
    for (const [, w] of this.widgets) if (!w.isDestroyed()) w.destroy();
    this.widgets.clear();
    this.boots.clear();
  }

  private createWindow(threadId: string): BrowserWindow {
    const w = new BrowserWindow({
      width: 360,
      height: 420,
      minWidth: 280,
      minHeight: 240,
      frame: false,
      transparent: true,
      resizable: true,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: false,
      type: "desktop",
      hasShadow: true,
      maximizable: false,
      fullscreenable: false,
      show: false,
      webPreferences: {
        preload: preloadStickyChat,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        additionalArguments: [`--thread-id=${threadId}`],
      },
    });
    w.setAlwaysOnTop(false);

    const query = `?threadId=${encodeURIComponent(threadId)}`;
    if (DEV_URL) void w.loadURL(`${DEV_URL}/sticky-chat.html${query}`);
    else void w.loadFile(join(rendererDir, "sticky-chat.html"), { search: query });

    w.on("ready-to-show", () => w.showInactive());
    return w;
  }

  private positionWidget(w: BrowserWindow, threadId: string): void {
    const stored = getGeometry(threadId);
    if (stored) {
      const g = clampToPrimary(stored);
      w.setBounds({ x: g.x, y: g.y, width: g.width, height: g.height });
      if (g.minimized) w.minimize();
      return;
    }
    // Default chat-sticky placement: bottom-right cascade so it doesn't
    // collide with the top-right task-widget cascade.
    const { workArea } = screen.getPrimaryDisplay();
    const index = this.widgets.size - 1; // most recently inserted
    const x = workArea.x + workArea.width - 380 - SCREEN_PAD;
    const y = workArea.y + workArea.height - 460 - SCREEN_PAD - Math.max(0, index) * 40;
    w.setPosition(Math.max(workArea.x + SCREEN_PAD, x), Math.max(workArea.y + SCREEN_PAD, y));
  }

  private wireGeometryPersistence(w: BrowserWindow, threadId: string): void {
    const persist = () => {
      if (w.isDestroyed()) return;
      const b = w.getBounds();
      saveGeometry(threadId, {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        minimized: w.isMinimized(),
      });
    };
    w.on("move", persist);
    w.on("resize", persist);
    w.on("minimize", persist);
    w.on("restore", persist);
    // Keep chat notes on the main desktop screen: snap back to the primary
    // display if dragged onto another monitor (once the move finishes).
    w.on("moved", () => {
      if (w.isDestroyed()) return;
      const b = w.getBounds();
      if (!isOnPrimary(b)) {
        const g = clampToPrimary({ ...b, minimized: false, lastSeenAt: 0 });
        w.setBounds({ x: g.x, y: g.y, width: b.width, height: b.height });
      }
      persist();
    });
    w.on("close", () => {
      this.widgets.delete(threadId);
      this.boots.delete(threadId);
      gc(this.widgets.keys());
    });
  }

  private push(w: BrowserWindow, boot: ChatStickyBootstrap): void {
    if (!w.isDestroyed()) w.webContents.send("sticky-chat:bootstrap", boot);
  }
}
