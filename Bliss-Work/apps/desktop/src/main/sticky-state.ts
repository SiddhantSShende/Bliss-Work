import { app, screen } from "electron";
import { readFileSync, renameSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Per-widget geometry + pinned-set persistence.
 *
 * Layout on disk:
 *   userData/sticky-state.json:
 *     {
 *       version: 1,
 *       geometry: {
 *         [taskId|threadId]: {
 *           x, y, width, height, minimized, lastSeenAt,
 *           collapsed?, expandedWidth?, expandedHeight?   // task pill state
 *         }
 *       },
 *       pinned: string[],    // task ids pinned to the desktop
 *       unpinned: string[]   // task ids the user explicitly unpinned
 *     }
 *
 * `pinned` is the load-bearing source of truth for the "pin a task to the
 * desktop" feature: StickyManager floats a note iff its id is in `pinned` AND
 * the task is still actionable (SENT or ACKNOWLEDGED). Persisting it is what
 * makes a note survive relaunch — an unfinished commitment comes back until it
 * is completed, ignored or unpinned.
 *
 * ── `unpinned`: only an EXPLICIT Unpin writes it ─────────────────────────────
 * Tasks auto-pin on every live server push, so removing an id from `pinned` is
 * not enough to make an Unpin stick — the next push would pin it straight back.
 * `unpinned` is the veto that stops that, and it is persisted so the choice
 * survives a relaunch too. It is written by StickyManager.unpin() (the note's
 * own Unpin button) and by nothing else.
 *
 * That narrowness matters. An earlier `dismissed` list was ALSO written whenever
 * a task was merely opened in the inbox, so reading an allocation retired its
 * note for good with the task still outstanding. An id leaves `unpinned` once
 * its task leaves the actionable set (StickyManager.prunePinned), so the list
 * stays bounded and a task that becomes actionable again pins again. An older
 * file may still carry the retired `dismissed` field; it is ignored on load and
 * dropped on the next write.
 *
 * `minimized` is persisted for the main window but ignored for NOTES on
 * restore, for a related reason — see positionWidget in ./sticky-manager.
 *
 * Why a separate file from taskboard-cache.json: cache.json is the last-known
 * SNAPSHOT; sticky-state is per-widget USER PREFERENCE. Different lifecycles —
 * the cache can be invalidated and rewritten on every server message; state
 * survives logouts and migrates with the user.
 *
 * Writes are 200ms-debounced. Atomic-rename (temp→final) so a SIGKILL during
 * write can't leave a half-written JSON the next launch trips over. On parse
 * failure we MERGE defaults instead of nuking the file outright.
 *
 * GC: geometry entries whose lastSeenAt is older than 30 days AND aren't in the
 * current live snapshot are dropped on the next flush. Pinned ids are EXEMPT —
 * a pinned note must restore its geometry no matter how long the app was closed.
 */

const SCHEMA_VERSION = 1;
const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEBOUNCE_MS = 200;

export interface StickyGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  lastSeenAt: number; // ms since epoch — drives the 30-day GC.
  /** Collapsed-to-pill state (task widgets only). Survives relaunch so a
   *  pinned note that the user shrank comes back as a pill, not full size. */
  collapsed?: boolean;
  /** Last full (expanded) size, captured on collapse so expand can restore it
   *  instead of snapping to the default 320×200. */
  expandedWidth?: number;
  expandedHeight?: number;
}

/**
 * The MAIN window's last geometry. Deliberately not stored as a `geometry`
 * entry: that map is GC'd on age and clamped to the primary display, both of
 * which are right for a desktop note and wrong for the app window, which may
 * legitimately live on a second monitor and must survive a month of not being
 * opened.
 */
export interface MainWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Restored maximized rather than at the stored rectangle. */
  maximized: boolean;
}

interface OnDisk {
  version: number;
  geometry: Record<string, StickyGeometry>;
  /** Absent until the window has been moved or resized at least once. */
  main?: MainWindowBounds;
  /** Task ids the user has explicitly pinned to the desktop. The single source
   *  of truth for which acknowledged tasks float (StickyManager gates on this ∩
   *  ACKNOWLEDGED). Persisted so a pinned note re-floats after relaunch — the
   *  "only Complete removes it" promise must survive a restart. */
  pinned: string[];
  /** Task ids the user explicitly unpinned. Auto-pin skips these so an Unpin is
   *  not undone by the next server push — see the file doc. */
  unpinned: string[];
}

let filePath = "";
let mem: OnDisk = { version: SCHEMA_VERSION, geometry: {}, pinned: [], unpinned: [] };
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;

export function initStickyState(): void {
  filePath = join(app.getPath("userData"), "sticky-state.json");
  if (!existsSync(filePath)) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      /* userData always exists in practice */
    }
    return;
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<OnDisk>;
    mem = {
      version: SCHEMA_VERSION,
      geometry:
        parsed.geometry && typeof parsed.geometry === "object"
          ? parsed.geometry
          : {},
      pinned: stringList(parsed.pinned),
      unpinned: stringList(parsed.unpinned),
      main: isMainBounds(parsed.main) ? parsed.main : undefined,
    };
    // A note recorded as minimized cannot be brought back: the window is built
    // minimizable:false + skipTaskbar:true, so there is no taskbar button and
    // no show path. Clearing it on load is what rescues an install that already
    // has one — otherwise that task's note is invisible for good.
    for (const g of Object.values(mem.geometry)) {
      if (g && g.minimized) g.minimized = false;
    }
  } catch {
    // Don't crash on a corrupted file; merge defaults instead.
    mem = { version: SCHEMA_VERSION, geometry: {}, pinned: [], unpinned: [] };
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function isMainBounds(v: unknown): v is MainWindowBounds {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    // A zero or negative size would open an invisible window that the user then
    // has no way to grab — reject the whole record rather than half-apply it.
    typeof b.width === "number" && b.width > 0 &&
    typeof b.height === "number" && b.height > 0 &&
    typeof b.maximized === "boolean"
  );
}

/** Last known main-window geometry, or undefined for a first run. */
export function getMainWindowBounds(): MainWindowBounds | undefined {
  return mem.main ? { ...mem.main } : undefined;
}

/** Record the main window's geometry (debounced, atomic — same writer as the
 *  sticky geometry). */
export function saveMainWindowBounds(b: MainWindowBounds): void {
  mem.main = { ...b };
  scheduleFlush();
}

// ── Pinned set ────────────────────────────────────────────────────────────────
// The desktop-local set of task ids the user has pinned. Kept here (alongside
// geometry) so it shares the same atomic, debounced, crash-safe writer.

/** Current pinned task ids (a copy — callers must not mutate the array). */
export function getPinned(): string[] {
  return [...mem.pinned];
}

export function isPinned(id: string): boolean {
  return mem.pinned.includes(id);
}

/** Pin a task id. Idempotent. Ignores non-string/empty ids so a malformed IPC
 *  payload can never poison the persisted set. */
export function addPinned(id: string): void {
  if (typeof id !== "string" || !id) return;
  if (!mem.pinned.includes(id)) {
    mem.pinned.push(id);
    scheduleFlush();
  }
}

/** Unpin a task id (e.g. once it's completed). Idempotent. */
export function removePinned(id: string): void {
  const i = mem.pinned.indexOf(id);
  if (i !== -1) {
    mem.pinned.splice(i, 1);
    scheduleFlush();
  }
}

// ── Explicit-unpin veto ───────────────────────────────────────────────────────

/** Whether the user explicitly unpinned this task (auto-pin must skip it). */
export function isUnpinned(id: string): boolean {
  return mem.unpinned.includes(id);
}

/** Record an explicit Unpin. Idempotent; ignores non-string/empty ids. */
export function addUnpinned(id: string): void {
  if (typeof id !== "string" || !id) return;
  if (!mem.unpinned.includes(id)) {
    mem.unpinned.push(id);
    scheduleFlush();
  }
}

/** Forget an explicit Unpin, e.g. once its task is no longer actionable.
 *  Idempotent. */
export function removeUnpinned(id: string): void {
  const i = mem.unpinned.indexOf(id);
  if (i !== -1) {
    mem.unpinned.splice(i, 1);
    scheduleFlush();
  }
}

/** Current explicit-unpin ids (a copy). */
export function getUnpinned(): string[] {
  return [...mem.unpinned];
}

/** Return geometry for a widget, or undefined if none stored. */
export function getGeometry(widgetId: string): StickyGeometry | undefined {
  return mem.geometry[widgetId];
}

/**
 * Clamp a stored position so the widget sits FULLY within the PRIMARY display's
 * work area. Sticky notes live only on the main desktop screen (product
 * requirement), so a geometry restored from a since-unplugged external monitor —
 * or one dragged onto a secondary display in a prior session — is pulled back
 * onto the primary display rather than left off-screen or on another monitor.
 */
export function clampToPrimary(g: StickyGeometry): StickyGeometry {
  const wa = screen.getPrimaryDisplay().workArea;
  // Fit within [wa.x, wa.x+width-w]; Math.max guards a widget wider/taller than
  // the work area (pin its top-left to the work-area origin).
  const x = Math.max(wa.x, Math.min(g.x, wa.x + wa.width - g.width));
  const y = Math.max(wa.y, Math.min(g.y, wa.y + wa.height - g.height));
  return { ...g, x, y };
}

/** True iff the widget's CENTER lies within the primary display's work area.
 *  Drives the "snap a note dragged onto a secondary monitor back to the main
 *  desktop screen" behaviour in the sticky managers. */
export function isOnPrimary(b: { x: number; y: number; width: number; height: number }): boolean {
  const wa = screen.getPrimaryDisplay().workArea;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height;
}

/** Stamp + persist (debounced) the geometry for a widget. */
export function saveGeometry(widgetId: string, g: Omit<StickyGeometry, "lastSeenAt">): void {
  mem.geometry[widgetId] = { ...g, lastSeenAt: Date.now() };
  scheduleFlush();
}

/** Mark this widget as still alive (no geometry change). Touches lastSeenAt. */
export function touch(widgetId: string): void {
  const cur = mem.geometry[widgetId];
  if (cur) {
    cur.lastSeenAt = Date.now();
    scheduleFlush();
  }
}

/** Remove a widget's saved geometry (e.g. on explicit unpin / close). */
export function forget(widgetId: string): void {
  if (widgetId in mem.geometry) {
    delete mem.geometry[widgetId];
    scheduleFlush();
  }
}

/** Run GC: drop entries older than GC_MAX_AGE_MS AND not in the live snapshot.
 *  Pinned ids are always kept — a pinned note must restore its geometry on the
 *  next launch no matter how long the app was closed. */
export function gc(live: Iterable<string>): void {
  const liveSet = new Set(live);
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(mem.geometry)) {
    const g = mem.geometry[id];
    if (!g) continue;
    if (!liveSet.has(id) && !mem.pinned.includes(id) && now - g.lastSeenAt > GC_MAX_AGE_MS) {
      delete mem.geometry[id];
      changed = true;
    }
  }
  if (changed) scheduleFlush();
}

/** Force-flush any pending write — call on `before-quit`. */
export function flushSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!dirty) return;
  writeAtomic();
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeAtomic();
  }, DEBOUNCE_MS);
}

function writeAtomic(): void {
  if (!filePath) return;
  const tmp = filePath + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(mem), "utf8");
    renameSync(tmp, filePath);
    dirty = false;
  } catch {
    // Best-effort. A future write will retry.
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}
