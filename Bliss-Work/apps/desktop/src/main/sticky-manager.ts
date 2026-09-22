import { BrowserWindow, screen } from "electron";
import {
  actionsFor,
  canAcceptNewPin,
  canFloatTask,
  idsToPrune,
  selectFloatingTasks,
  type PinResult,
  type StickyTaskDTO,
} from "@taskboard/shared";
import { createStickyWindow } from "./windows";
import {
  addPinned,
  addUnpinned,
  clampToPrimary,
  gc,
  getGeometry,
  getPinned,
  getUnpinned,
  isPinned,
  isUnpinned,
  removePinned,
  removeUnpinned,
  saveGeometry,
} from "./sticky-state";
import { reclampGroupToPrimary, snapBackIfOffPrimary } from "./sticky-window-group";

/**
 * Fixed synthetic geometry key for the single carousel container, in the same
 * `sticky-state.ts` geometry map that used to hold one entry per taskId. One
 * widget now, one entry — no schema change needed (StickyGeometry already has
 * every field a container needs), and old per-taskId entries simply stop being
 * written and age out via the existing 30-day GC.
 */
const CONTAINER_ID = "sticky:tasks";

/**
 * Hard cap on simultaneous task widgets. Settings-gated raise to 12 lives in
 * Phase 8. Any task beyond the cap is dropped from the rendered widget set but
 * still appears in the in-app inbox/tasks view.
 */
const MAX_WIDGETS = 5;

/**
 * Per-edge clamp margin to keep restored widgets from straddling the work-area
 * boundary by even one pixel (Windows can refuse to show a window whose origin
 * is exactly at the screen edge).
 */
const SCREEN_PAD = 4;

/** Pill (collapsed) dimensions. Below the window's normal minimums, so the
 *  collapse path must lower setMinimumSize BEFORE resizing (see setCollapsed). */
const PILL_W = 220;
const PILL_H = 52;
/** The note's normal minimum size (mirrors createStickyWindow). Restored when
 *  the user expands a collapsed pill back to a full note. */
const FULL_MIN_W = 320;
const FULL_MIN_H = 140;
/** Fallback full size if we somehow lack a stored expanded size (mirrors
 *  createStickyWindow's default). */
const FULL_W = 380;
const FULL_H = 200;

/**
 * Owns the floating task widget windows — the product differentiator.
 *
 * A task floats iff it is PINNED AND still actionable (SENT or ACKNOWLEDGED).
 * Actionable tasks auto-pin on every live server push (see autopinActionable),
 * so a freshly ALLOCATED task pops up on its own showing Acknowledge / Ignore —
 * no manual pin or prior acknowledge needed.
 *
 * The note is a persistent desktop overlay: always on top of every other
 * application, on every workspace, and never hidden because focus moved
 * elsewhere (see createStickyWindow). Nothing here reacts to which application
 * is in front.
 *
 * ── What removes a note ──────────────────────────────────────────────────────
 * Completing, ignoring or leaving the task, or the user's explicit Unpin
 * (unpin()). That is the whole list: an allocation you have not dealt with does
 * not go away because you read it, closed the app, or restarted the machine.
 * The server decides the first three — a terminal status drops the task from
 * /tasks/sticky and prunePinned then tears the window down.
 *
 * Unpin is persisted (see ./sticky-state's `unpinned`) and respected by every
 * automatic path, so it holds across server pushes and restarts. Opening a task
 * never unpins it: an earlier version retired a note whenever its task was
 * merely read in the inbox, with the task still outstanding.
 *
 * Lifecycle on the note: a SENT note offers Acknowledge / Ignore. Ignoring drops
 * it from the server's actionable list → prunePinned tears the window down.
 * Acknowledging keeps it floating but locks it (Complete only) — the user can
 * COLLAPSE it to a pill (setCollapsed). The pinned set persists across
 * relaunches so an unfinished commitment comes back.
 *
 * Inherited from Phase 7:
 *   * Geometry restore + persist via ./sticky-state (per-widget x/y/w/h + a
 *     collapsed flag and last-expanded size).
 *   * Display-aware clamp so an unplugged external monitor doesn't strand
 *     widgets off-screen on relaunch.
 */
export class StickyManager {
  /** The single carousel window, or null while nothing is pinned/floating. */
  private win: BrowserWindow | null = null;
  /** The floating set as of the last reconcile() — what the carousel pages
   *  through. next()/prev() only move currentIndex within this; reconcile()
   *  is what recomputes it. */
  private visible: StickyTaskDTO[] = [];
  /** Which entry of `visible` the carousel currently shows. */
  private currentIndex = 0;
  private tasks: StickyTaskDTO[] = [];

  /** Latest known actionable task list (server returns only SENT/ACKNOWLEDGED).
   *  Stored whole so taskCount()/tray reflect ALL active tasks, while only the
   *  pinned∩actionable subset is actually floated.
   *
   *  `live` distinguishes a real server push (which can auto-pin freshly
   *  allocated tasks) from the bootstrap cache push (possibly stale — its
   *  already-pinned tasks still restore via reconcile(), but we don't auto-pin
   *  off a stale snapshot). */
  setTasks(tasks: StickyTaskDTO[], opts: { live?: boolean } = {}): void {
    this.tasks = tasks;
    if (opts.live) this.autopinActionable();
    this.reconcile();
  }

  /**
   * Pin every actionable (SENT/ACKNOWLEDGED) task not already pinned, up to the
   * on-screen cap. This is what makes an allocation auto-float: the ws-process
   * re-fetches /tasks/sticky on every `task.*` event, so a newly assigned SENT
   * task lands in `this.tasks` and gets pinned + reconciled into a window with
   * no manual pin. Capped so the persisted pinned set can't grow unbounded.
   *
   * The one thing that holds a task back is the user's explicit Unpin — an
   * actionable task they have not completed, ignored or unpinned is one this is
   * supposed to keep putting back.
   */
  private autopinActionable(): void {
    // Counted off the SAME set reconcile() renders from, so the two cannot
    // disagree about how full the desktop is.
    let floating = selectFloatingTasks(this.tasks, getPinned(), -1).length;
    for (const t of this.tasks) {
      if (floating >= MAX_WIDGETS) break;
      if (isUnpinned(t.taskId)) continue;
      if (!isPinned(t.taskId) && canFloatTask(t.myStatus)) {
        addPinned(t.taskId);
        floating++;
      }
    }
  }

  /**
   * Adopt the durable pin set from sticky-svc.
   *
   * Purely ADDITIVE, and that is the whole safety property: this can restore a
   * pin this machine has never seen — a fresh install, a second device, a
   * cleared profile — but it can never remove one. Only prunePinned, driven by
   * task-svc's live actionable list, takes a note away.
   *
   * So a sticky-svc outage, a lagging consumer, or a build with no stickyBase
   * configured degrades to exactly the behaviour that shipped before the
   * service existed, rather than wiping someone's desktop.
   *
   * An explicit Unpin is respected: the server still counts the task as an open
   * commitment, but the user's decision about where its note lives is theirs.
   */
  adoptServerPins(taskIds: readonly string[]): void {
    for (const id of taskIds) {
      if (typeof id !== "string" || !id) continue;
      if (!isPinned(id) && !isUnpinned(id)) addPinned(id);
    }
    this.reconcile();
  }

  /**
   * Explicit Unpin, from the note's own Unpin button — and from nowhere else.
   *
   * Removes the task from the persisted pinned set AND records the veto that
   * keeps auto-pin from putting it straight back on the next server push (see
   * ./sticky-state). The task itself is untouched: this is about where its note
   * lives, not the commitment, so it stays in the in-app Tasks list with all its
   * actions.
   *
   * reconcile() then drops it from the carousel (closing the shared window if
   * it was the last one), advancing the index like any other removal.
   */
  unpin(taskId: string): void {
    if (typeof taskId !== "string" || !taskId) return;
    removePinned(taskId);
    addUnpinned(taskId);
    this.reconcile();
  }

  taskFor(id: string): StickyTaskDTO | undefined {
    return this.tasks.find((t) => t.taskId === id);
  }

  taskCount(): number {
    return this.tasks.length;
  }

  /**
   * Pin a task to the desktop on request (the acknowledge auto-pin in the app's
   * query bridge; actionable tasks already auto-pin via autopinActionable).
   * Returns the authoritative pinned set so the renderer reflects reality.
   *
   * - Idempotent: re-pinning a task surfaces its existing note (restoring a
   *   minimized window / expanding a collapsed pill) rather than duplicating it.
   * - Capped: refuses (reason "limit") once MAX_WIDGETS tasks already float, so
   *   we never tell the user a note is pinned when it can't be shown.
   * - Refuses (reason "unpinned") a task the user explicitly unpinned: nothing
   *   automatic may undo an Unpin, and acknowledging is not a request to re-pin.
   * - The note floats with whatever real status the task has (SENT → Acknowledge
   *   / Ignore; ACKNOWLEDGED → Complete); the next list fills in any lag.
   */
  pin(taskId: string): PinResult {
    if (typeof taskId !== "string" || !taskId) {
      return { ok: false, reason: "invalid", pinned: getPinned() };
    }
    if (isUnpinned(taskId)) {
      return { ok: false, reason: "unpinned", pinned: getPinned() };
    }
    if (isPinned(taskId)) {
      // Already pinned — bring the CONTAINER into view and page it to this
      // task, rather than creating or duplicating anything.
      if (this.win && !this.win.isDestroyed() && this.win.isMinimized()) this.win.restore();
      if (getGeometry(CONTAINER_ID)?.collapsed) this.setCollapsed(false);
      this.reconcile();
      this.showTask(taskId);
      // Deliberately do NOT focus()/raise the note: it is a non-focusable
      // companion window whose z-order is the OS's business, not ours.
      // Making it visible again just means restoring/expanding it in place.
      return { ok: true, pinned: getPinned() };
    }
    // If the task isn't in this.tasks yet (a very fresh assign + immediate manual
    // pin before /tasks/sticky has been re-fetched), synthesise a minimal SENT
    // row so reconcile() creates the window now rather than waiting for the next
    // list. The next setTasks fills in the real fields (and real status).
    if (!this.tasks.some((t) => t.taskId === taskId)) {
      this.tasks = [
        ...this.tasks,
        {
          taskId,
          title: "Loading…",
          description: "",
          senderUsername: "",
          myStatus: "SENT",
          actions: actionsFor("SENT"),
          statusVersion: 0,
        } as unknown as StickyTaskDTO,
      ];
    }
    // New pin — enforce the on-screen cap (count tasks that already float).
    // Same set autopinActionable/reconcile count against.
    const floatingCount = selectFloatingTasks(this.tasks, getPinned(), -1).length;
    if (!canAcceptNewPin(floatingCount, MAX_WIDGETS)) {
      return { ok: false, reason: "limit", pinned: getPinned() };
    }
    addPinned(taskId);
    this.reconcile();
    // A newly pinned task is what the carousel shows now — satisfies "newly
    // pinned tasks automatically become available in the same carousel"
    // without making the user page to find it.
    this.showTask(taskId);
    return { ok: true, pinned: getPinned() };
  }

  /** Point the carousel at a specific task, if it's currently floating.
   *  No-op (silently) if the task isn't in the visible set — callers only
   *  invoke this right after a reconcile that should have put it there. */
  private showTask(taskId: string): void {
    const i = this.visible.findIndex((t) => t.taskId === taskId);
    if (i === -1) return;
    this.currentIndex = i;
    this.pushCurrent();
  }

  /** Task ids currently pinned to the desktop (the in-app cards mirror this to
   *  lock an acknowledged pinned task to Complete-only). */
  listPinned(): string[] {
    return getPinned();
  }

  /**
   * A note's renderer has registered its "sticky:task" listener and signalled
   * readiness. Push the freshest task to it now.
   *
   * The window is created with a one-shot did-finish-load push, but that event
   * can fire before the renderer's React effect subscribes — dropping the push
   * (ipcRenderer doesn't buffer) and leaving the note on "Loading…" until the
   * next task list change, which may never come after a lone acknowledge. This
   * handshake guarantees the note paints its task as soon as it's ready.
   */
  onRendererReady(): void {
    this.pushCurrent();
  }

  /**
   * Drop from the pinned set any pinned id NOT present in the latest LIVE list.
   * The server's /tasks/sticky endpoint returns only SENT/ACKNOWLEDGED tasks,
   * so completion (or leave/ignore from another surface) manifests as ABSENCE.
   * The utilityProcess only emits a list after a SUCCESSFUL fetch, so absence
   * here reliably means "no longer active" — safe to unpin and forget.
   *
   * MUST be called only on a live server push, never on the bootstrap cache
   * push (a stale/empty cache would wrongly unpin an unfinished commitment).
   */
  prunePinned(liveIds: Iterable<string>): void {
    const live = [...liveIds];
    // A task that has left the actionable set can also forget it was unpinned:
    // the persisted veto stays bounded, and a task which becomes actionable
    // AGAIN (reassigned, re-opened) is free to pin itself once more.
    for (const id of idsToPrune(getUnpinned(), live)) {
      removeUnpinned(id);
    }
    for (const id of idsToPrune(getPinned(), live)) {
      removePinned(id);
    }
    // No per-task window/geometry to tear down individually any more —
    // reconcile() drops the pruned ids from the carousel's visible set and
    // closes the shared window if nothing is left floating.
    this.reconcile();
  }

  /** Collapse a note to a small pill, or expand it back. The note window is
   *  resized in place — never recreated, so it keeps its owner and its place
   *  in the group.
   *  Order matters: when shrinking below the normal minimum we must lower the
   *  minimum size BEFORE setBounds, and restore it AFTER expanding. */
  setCollapsed(collapsed: boolean): void {
    const w = this.win;
    if (!w || w.isDestroyed()) {
      // No live window (e.g. transiently absent). Still persist the intent so
      // the flag is correct when the container re-creates, rather than
      // silently dropping the user's collapse/expand.
      const g = getGeometry(CONTAINER_ID);
      if (g) {
        saveGeometry(CONTAINER_ID, {
          x: g.x,
          y: g.y,
          width: g.width,
          height: g.height,
          minimized: g.minimized,
          collapsed,
          expandedWidth: g.expandedWidth,
          expandedHeight: g.expandedHeight,
        });
      }
      return;
    }
    const b = w.getBounds();
    if (collapsed) {
      // Save the flag + the full size to restore to BEFORE resizing, so the
      // 'resize' persist listener (which copies prev.collapsed) stays correct
      // regardless of event timing. Lower the minimum before shrinking below it.
      saveGeometry(CONTAINER_ID, {
        x: b.x,
        y: b.y,
        width: PILL_W,
        height: PILL_H,
        minimized: w.isMinimized(),
        collapsed: true,
        expandedWidth: b.width,
        expandedHeight: b.height,
      });
      w.setMinimumSize(PILL_W, PILL_H);
      w.setResizable(false);
      w.setBounds({ x: b.x, y: b.y, width: PILL_W, height: PILL_H });
    } else {
      const stored = getGeometry(CONTAINER_ID);
      const fw = stored?.expandedWidth ?? FULL_W;
      const fh = stored?.expandedHeight ?? FULL_H;
      // Save collapsed:false BEFORE setBounds so a same-tick 'resize' persist
      // can't record full bounds while the flag still reads true.
      saveGeometry(CONTAINER_ID, {
        x: b.x,
        y: b.y,
        width: fw,
        height: fh,
        minimized: w.isMinimized(),
        collapsed: false,
        expandedWidth: fw,
        expandedHeight: fh,
      });
      w.setBounds({ x: b.x, y: b.y, width: fw, height: fh });
      w.setMinimumSize(FULL_MIN_W, FULL_MIN_H);
      w.setResizable(true);
    }
  }

  /** Re-confine the note to the primary display. Called on display
   *  add/remove/metrics-change so unplugging the monitor it drifted toward
   *  can't strand it off the main desktop screen. */
  reclampAll(): void {
    reclampGroupToPrimary(this.win ? [this.win] : []);
  }

  /** Advance the carousel to the next pinned task, wrapping around. A no-op
   *  with 0 or 1 floating tasks (arrows are hidden in that case anyway). */
  next(): void {
    if (this.visible.length <= 1) return;
    this.currentIndex = (this.currentIndex + 1) % this.visible.length;
    this.pushCurrent();
  }

  /** Retreat the carousel to the previous pinned task, wrapping around. */
  prev(): void {
    if (this.visible.length <= 1) return;
    this.currentIndex = (this.currentIndex - 1 + this.visible.length) % this.visible.length;
    this.pushCurrent();
  }

  private reconcile(): void {
    // Float only pinned tasks that are still actionable (SENT/ACK), capped.
    const visible = selectFloatingTasks(this.tasks, getPinned(), MAX_WIDGETS);

    if (visible.length === 0) {
      if (this.win && !this.win.isDestroyed()) this.win.close();
      this.win = null;
      this.visible = [];
      this.currentIndex = 0;
      gc([CONTAINER_ID]);
      return;
    }

    // Keep pointing at the same task across a reconcile (one elsewhere got
    // acknowledged, a new one auto-pinned) rather than snapping the carousel
    // back to the first page under the user. Falls back to clamping in range
    // if the previously shown task itself dropped out of the set (hidden,
    // pruned, or the cap demoted it).
    const shownId = this.visible[this.currentIndex]?.taskId;
    const keptIndex = shownId ? visible.findIndex((t) => t.taskId === shownId) : -1;
    this.visible = visible;
    this.currentIndex = keptIndex !== -1 ? keptIndex : Math.min(this.currentIndex, visible.length - 1);

    if (!this.win || this.win.isDestroyed()) {
      const collapsed = getGeometry(CONTAINER_ID)?.collapsed ?? false;
      const win = createStickyWindow(collapsed);
      this.win = win;
      this.positionWidget(win);
      this.wireGeometryPersistence(win);
      // Look up the freshest carousel state when the page finishes loading
      // (not a captured snapshot), and fire once so an HMR reload can't
      // re-push stale data over a newer render.
      win.webContents.once("did-finish-load", () => this.pushCurrent());
    } else {
      this.pushCurrent();
    }

    // GC against the container's own key so sticky-state.json doesn't grow
    // forever. There's exactly one entry for it (unlike the old per-task
    // scheme), so this just keeps it exempt from the age-out sweep for as
    // long as something is pinned.
    gc([CONTAINER_ID]);
  }

  /** Restore from sticky-state.json if present; otherwise place the container
   *  at its default top-right position so first-run feels familiar. */
  private positionWidget(w: BrowserWindow): void {
    const stored = getGeometry(CONTAINER_ID);
    if (stored) {
      const g = clampToPrimary(stored);
      if (g.collapsed) {
        // Lower the minimum first so setBounds isn't clamped back up, and force
        // the canonical pill size — never trust a possibly-full stored size on a
        // collapsed record (which would yield a non-resizable oversized pill).
        w.setMinimumSize(PILL_W, PILL_H);
        w.setResizable(false);
        w.setBounds({ x: g.x, y: g.y, width: PILL_W, height: PILL_H });
      } else {
        w.setBounds({ x: g.x, y: g.y, width: g.width, height: g.height });
      }
      // Deliberately NOT restoring a stored `minimized` flag. This window is
      // built minimizable:false + skipTaskbar:true, so a note that somehow got
      // minimised has no taskbar button to bring it back and nothing else
      // shows it either — it is invisible for good, across every restart,
      // with tasks still pinned. Older state files (and Linux WMs that
      // minimise regardless of the flag) can both carry one, so it is ignored
      // here and cleared on the next save.
      return;
    }
    const { workArea } = screen.getPrimaryDisplay();
    // Inset by the note's own width so the default position tucks it against
    // the right edge rather than half off-screen.
    const x = workArea.x + workArea.width - FULL_W - SCREEN_PAD;
    const y = workArea.y + 20;
    w.setPosition(Math.max(workArea.x + SCREEN_PAD, x), Math.max(workArea.y + SCREEN_PAD, y));
  }

  /** Wire move/resize/minimize listeners to keep sticky-state in sync. Preserves
   *  the collapsed flag + last-expanded size across plain move/resize events
   *  (which fire on programmatic collapse too). */
  private wireGeometryPersistence(w: BrowserWindow): void {
    const persist = () => {
      if (w.isDestroyed()) return;
      const b = w.getBounds();
      const prev = getGeometry(CONTAINER_ID);
      saveGeometry(CONTAINER_ID, {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        minimized: w.isMinimized(),
        collapsed: prev?.collapsed,
        expandedWidth: prev?.expandedWidth,
        expandedHeight: prev?.expandedHeight,
      });
    };
    w.on("move", persist);
    w.on("resize", persist);
    w.on("minimize", persist);
    w.on("restore", persist);
    // Sticky notes belong on the main desktop screen only. If the user drags a
    // note onto a secondary monitor, snap it back onto the primary display once
    // the move finishes ('moved' fires once on Windows/macOS, so we never fight
    // an in-progress drag). persist() then records the corrected position.
    w.on("moved", () => {
      snapBackIfOffPrimary(w);
      persist();
    });
    // No user-facing close on a locked note; window teardown is driven by the
    // manager (unpin/complete via reconcile/prunePinned), which owns the
    // pinned-set + geometry cleanup.
  }

  /**
   * Keep the note window's native (opaque, not transparent — see
   * ./windows.ts) background in step with its own renderer's resolved theme.
   * The renderer computes the colour itself off the DOM (never a raw theme
   * token trusted verbatim) and reports it here; a malformed value is simply
   * dropped rather than handed to the native window.
   */
  setBackgroundColor(color: string): void {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
    w.setBackgroundColor(color);
  }

  /** Push the current carousel page (the full visible set + which index is
   *  shown) to the renderer. Sending the whole set rather than just the
   *  index keeps main and renderer trivially in sync — no separate "here's
   *  the array" vs "here's where you are" messages to keep ordered. */
  private pushCurrent(): void {
    const w = this.win;
    if (w && !w.isDestroyed()) {
      w.webContents.send("sticky:tasks", { tasks: this.visible, index: this.currentIndex });
    }
  }

  destroyAll(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
