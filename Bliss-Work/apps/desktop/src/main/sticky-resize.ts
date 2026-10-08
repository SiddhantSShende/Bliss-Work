import { screen, type BrowserWindow, type Rectangle } from "electron";

/**
 * Resizing and moving the pinned task note on Linux.
 *
 * On X11 a window created `focusable: false` is override-redirect (verified with
 * xwininfo): the window manager never sees it. Chromium's frameless resize
 * border still reports HTLEFT/HTBOTTOMRIGHT/... and shows the matching cursor,
 * but the resize itself is delegated to the window manager
 * (_NET_WM_MOVERESIZE), which ignores a window it does not manage — so the
 * cursor appeared and dragging did nothing. Re-enabling focus to get a managed
 * window would let a click on the note take keyboard focus from the user's other
 * application, which the note must never do (see createStickyWindow).
 *
 * So on Linux the native border is switched off (setResizable(false)) and the
 * note's renderer draws eight edge/corner hit zones instead (renderer/
 * StickyResizeHandles.tsx). While one is held, this module resizes the real
 * window with `setBounds` from the pointer position.
 *
 * Moving is the same story: the card is a `-webkit-app-region: drag` region,
 * which Chromium reports as HTCAPTION and answers with the same window-manager
 * request, so dragging the body did nothing either. On Linux the renderer drops
 * that region and reports the press itself, and the same cursor-following driver
 * moves the window ("move" below). Windows and macOS keep the OS's own resize
 * border and drag region untouched.
 */

/** Smallest size the content (title, Assigned row, Acknowledge/Ignore) lays out in. */
export const STICKY_MIN_SIZE = { width: 320, height: 300 };
/** Close to content size: the window is opaque, so more is just a flat rectangle. */
export const STICKY_MAX_SIZE = { width: 440, height: 440 };

export const RESIZE_EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
export type ResizeEdge = (typeof RESIZE_EDGES)[number];

/** What a pointer drag on the note does: resize from an edge/corner, or move it. */
export type NoteDrag = ResizeEdge | "move";

export function isNoteDrag(v: unknown): v is NoteDrag {
  return typeof v === "string" && (v === "move" || (RESIZE_EDGES as readonly string[]).includes(v));
}

/** True where the OS cannot resize the note itself and the renderer's handles do it. */
export function usesManualResize(): boolean {
  return process.platform === "linux";
}

/** The one place the note's native resizability is set. On Linux the native border
 *  stays off at all times — turning it back on would only bring back the dead
 *  resize cursor — and the renderer's handles are what make the note resizable. */
export function setNoteResizable(win: BrowserWindow, resizable: boolean): void {
  win.setResizable(resizable && !usesManualResize());
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** `start` dragged by (dx, dy) on `edge`: the opposite edge stays put, and the
 *  size is held inside the note's min/max. */
export function resizedBounds(start: Rectangle, edge: ResizeEdge, dx: number, dy: number): Rectangle {
  let { x, y, width, height } = start;
  if (edge.includes("e")) width = clamp(start.width + dx, STICKY_MIN_SIZE.width, STICKY_MAX_SIZE.width);
  if (edge.includes("w")) {
    width = clamp(start.width - dx, STICKY_MIN_SIZE.width, STICKY_MAX_SIZE.width);
    x = start.x + start.width - width;
  }
  if (edge.includes("s")) height = clamp(start.height + dy, STICKY_MIN_SIZE.height, STICKY_MAX_SIZE.height);
  if (edge.includes("n")) {
    height = clamp(start.height - dy, STICKY_MIN_SIZE.height, STICKY_MAX_SIZE.height);
    y = start.y + start.height - height;
  }
  return { x, y, width, height };
}

/** `start` after dragging by (dx, dy): a move keeps the size, a resize follows resizedBounds. */
export function draggedBounds(start: Rectangle, drag: NoteDrag, dx: number, dy: number): Rectangle {
  return drag === "move" ? { ...start, x: start.x + dx, y: start.y + dy } : resizedBounds(start, drag, dx, dy);
}

const POLL_MS = 8;
const active = new WeakMap<BrowserWindow, ReturnType<typeof setInterval>>();

/** Move/resize `win` to follow the cursor from where it is now, until endNoteDrag. */
export function beginNoteDrag(win: BrowserWindow, drag: NoteDrag): void {
  endNoteDrag(win);
  if (win.isDestroyed()) return;
  const start = win.getBounds();
  const origin = screen.getCursorScreenPoint();
  const timer = setInterval(() => {
    if (win.isDestroyed()) return endNoteDrag(win);
    const p = screen.getCursorScreenPoint();
    const next = draggedBounds(start, drag, p.x - origin.x, p.y - origin.y);
    const cur = win.getBounds();
    if (next.x !== cur.x || next.y !== cur.y || next.width !== cur.width || next.height !== cur.height) {
      win.setBounds(next);
    }
  }, POLL_MS);
  active.set(win, timer);
  win.once("closed", () => endNoteDrag(win));
}

export function endNoteDrag(win: BrowserWindow): void {
  const timer = active.get(win);
  if (timer === undefined) return;
  clearInterval(timer);
  active.delete(win);
}
