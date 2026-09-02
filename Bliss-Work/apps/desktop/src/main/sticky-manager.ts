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
import { createStickyWindow, setNoteOnTop } from "./windows";
import {
  addPinned,
  clampToPrimary,
  gc,
  getGeometry,
  getPinned,
  isPinned,
  removePinned,
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
 * no manual pin or prior acknowledge needed. (The manual "Pin to desktop"
 * button remains as a fallback.)
 *
 * A note is a DESKTOP WIDGET. It rests on the user's desktop and is on screen
 * whenever the desktop is what they are looking at — including while BlissWork
 * is minimised or closed to the tray — and it is taken away only while some
 * OTHER application is in front (setSafeToFloat, driven by ./app-active).
 * Nothing here ever sits over another application's work.
 *
 * ── What removes a note ──────────────────────────────────────────────────────
 * Completing, ignoring or leaving the task. That is the whole list, and it is
 * the promise the feature makes: an allocation you have not dealt with does not
 * go away because you read it, closed the app, or restarted the machine. The
 * server is what decides — a terminal status drops the task from /tasks/sticky
 * and prunePinned then tears the window down.
 *
 * `hideForSession` is the one exception, and it is deliberately NOT persisted:
 * the note's own X takes it off screen until the app restarts or the pin is
 * reconciled, and then it comes back. An earlier version persisted that set and
 * also triggered it from merely OPENING the task, which meant reading a task in
 * the inbox silently retired its note for good — the exact opposite of the
 * promise above.
 *
 * Lifecycle on the note: a SENT note offers Acknowledge / Ignore. Ignoring drops
 * it from the server's actionable list → prunePinned tears the window down.
 * Acknowledging keeps it floating but locks it (Complete only) — the user can
 * COLLAPSE it to a pill (setCollapsed) but the only removal is completing the
 * task. The pinned set persists across relaunches so an unfinished commitment
 * comes back.
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
  /**
   * Notes the user took off screen with the note's own X, THIS RUN ONLY.
   *
   * In memory on purpose — see the class doc. Nothing writes it to disk, so a
   * restart brings every still-actionable note back, and the only permanent
   * removal remains a terminal status on the server.
   */
  private hiddenThisSession = new Set<string>();

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
   * Only a THIS-RUN hide holds a task back, and only until the app restarts.
   * There is deliberately no persisted veto here: an actionable task the user
   * has not completed or ignored is one this is supposed to keep putting back.
   */
  private autopinActionable(): void {
    // Counted off the SAME set reconcile() renders from. Counting the raw
    // pinned set instead would let notes hidden this run keep occupying slots
    // under the cap, so hiding one would shrink the desktop to four notes
    // rather than letting the next task take its place.
    let floating = selectFloatingTasks(this.tasks, this.visiblePinned(), -1).length;
    for (const t of this.tasks) {
      if (floating >= MAX_WIDGETS) break;
      if (this.hiddenThisSession.has(t.taskId)) continue;
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
   * Notes hidden this run are respected: adopting a pin does not un-hide it,
   * because the user's decision about this session is more recent than the
   * server's record of the commitment.
   */
  adoptServerPins(taskIds: readonly string[]): void {
    for (const id of taskIds) {
      if (typeof id !== "string" || !id) continue;
      if (!isPinned(id)) addPinned(id);
    }
    this.reconcile();
  }

  /**
   * The pinned set minus anything hidden this run — what actually goes on
   * screen, and the single definition both autopinActionable and reconcile
   * count against so they cannot disagree about how full the desktop is.
   *
   * Ids stay in the persisted pinned set throughout: that is what brings a
   * hidden note back on the next launch.
   */
  private visiblePinned(): string[] {
    return getPinned().filter((id) => !this.hiddenThisSession.has(id));
  }

  /**
   * Take a note off screen for the rest of this run.
   *
   * Called from the note's own X, and from nowhere else — in particular NOT
   * from opening the task, which is reading it, not dealing with it. The task
   * is untouched: this is about the note, not the commitment, so the pin stays
   * on disk and the note is back on the next launch (or the next reconcile) if
   * the task is still actionable.
   */
  hideForSession(taskId: string): void {
    if (typeof taskId !== "string" || !taskId) return;
    this.hiddenThisSession.add(taskId);
    // No per-task window to close any more — reconcile() drops it from the
    // carousel's visible set (and closes the shared window if that was the
    // last one), advancing the index the same way any other removal does.
    this.reconcile();
  }

  taskFor(id: string): StickyTaskDTO | undefined {
    return this.tasks.find((t) => t.taskId === id);
  }

  taskCount(): number {
    return this.tasks.length;
  }

  /**
   * Manually pin a task to the desktop (the in-app "Pin to desktop" fallback;
   * actionable tasks already auto-pin via autopinActionable). Returns the
   * authoritative pinned set so the renderer reflects reality.
   *
   * - Idempotent: re-pinning a task surfaces its existing note (restoring a
   *   minimized window / expanding a collapsed pill) rather than duplicating it.
   * - Capped: refuses (reason "limit") once MAX_WIDGETS tasks already float, so
   *   we never tell the user a note is pinned when it can't be shown.
   * - The note floats with whatever real status the task has (SENT → Acknowledge
   *   / Ignore; ACKNOWLEDGED → Complete); the next list fills in any lag.
   */
  pin(taskId: string): PinResult {
    if (typeof taskId !== "string" || !taskId) {
      return { ok: false, reason: "invalid", pinned: getPinned() };
    }
    // Asking for a note back is the undo for having hidden it — otherwise a
    // hidden task reports "already pinned" and nothing appears.
    this.hiddenThisSession.delete(taskId);
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

  /** Task ids currently pinned to the desktop (the renderer reflects this on
   *  the "Pin to desktop" / "Pinned" button). */
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
    // A task that has left the actionable set can also forget it was hidden:
    // the session set stays bounded, and a task which becomes actionable AGAIN
    // (reassigned, re-opened) is free to float once more without a restart.
    for (const id of idsToPrune(this.hiddenThisSession, live)) {
      this.hiddenThisSession.delete(id);
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

  /**
   * Show or hide every note as the desktop reading changes.
   *
   * This is the whole of "the note rests on my desktop, and gets out of the way
   * of other applications". `safe` is true while BlissWork is frontmost OR the
   * bare desktop is showing; false only while another application is in front.
   *
   * Two things happen together, and both matter: the always-on-top flag is
   * dropped as well as the window hidden. Hiding alone would leave a note that
   * is merely off screen but still topmost, so anything that reveals it — a
   * window animation, a workspace switch — flashes it over someone else's work.
   * Dropping the flag alone would leave it visibly stacked underneath. On Linux
   * setNoteOnTop is a no-op: `type: "desktop"` already parks the note at the
   * bottom of the stack, so there is nothing to raise or drop.
   *
   * The same windows come back on return — nothing is recreated, so a note
   * keeps its position, its size, its collapsed state and its task.
   *
   * showInactive, never show: a note must not take focus even as it reappears.
   * The window is non-focusable anyway, which is also why CLICKING a note does
   * not count as leaving BlissWork — the buttons keep working while it's up.
   *
   * See ./app-active for how the reading is decided.
   */
  setSafeToFloat(safe: boolean): void {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    if (safe) {
      setNoteOnTop(w, true);
      if (!w.isVisible()) w.showInactive();
    } else {
      setNoteOnTop(w, false);
      if (w.isVisible()) w.hide();
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
    //
    // Notes hidden this run are filtered out of the PINNED set rather than out
    // of the result, so a hidden note does not hold a slot under the cap — and,
    // critically, so the next live push does not put it straight back. It stays
    // pinned on disk throughout: that is what brings it back after a restart.
    const visible = selectFloatingTasks(this.tasks, this.visiblePinned(), MAX_WIDGETS);

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
      // minimised has no taskbar button to bring it back and setSafeToFloat
      // cannot show it either — it is invisible for good, across every restart,
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
