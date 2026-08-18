import { app, BrowserWindow, powerMonitor } from "electron";

/**
 * Put the main window back the way the user left it after the machine has been
 * away.
 *
 * ── The problem ──────────────────────────────────────────────────────────────
 *
 * Leave the laptop idle with BlissWork open and come back to find the window
 * minimised, or restored down from maximised. Nothing in this app does that:
 * there is no idle timer here that touches a window, and the only `hide()` is
 * the tray behaviour on an explicit close.
 *
 * It is the platform. A screen lock, a display sleep or a suspend/resume cycle
 * re-composites the desktop, and a window can come back minimised or
 * restored-down — Windows is the usual offender (the compositor re-evaluates
 * display affinity, which this app sets for screenshot protection), and on
 * Linux a window manager that raises the desktop layer during a lock has the
 * same effect. None of it is something an app can prevent.
 *
 * ── What this does instead ───────────────────────────────────────────────────
 *
 * It remembers the window's state at the moment the machine went away, and
 * reverts anything that changed by the time it came back. Prevention is not
 * available; restoration is, and it is indistinguishable to the user as long as
 * it happens before they look.
 *
 * Two rules keep it from fighting the person it serves:
 *
 *   • It only ever UNDOES. A window the user minimised themselves before
 *     walking away stays minimised, and one they had closed to the tray is
 *     never summoned back — a chat app that pops itself open on a locked
 *     machine is a worse bug than the one being fixed.
 *   • It only acts across an away/back transition. Anything the user does while
 *     they are at the machine is theirs.
 *
 * ── What it does not cover ───────────────────────────────────────────────────
 *
 * The transitions it can see are `lock-screen`/`unlock-screen` (Windows and
 * macOS) and `suspend`/`resume` (all three platforms). A Linux desktop that
 * dims and blanks the screen without locking or suspending emits none of them,
 * so an idle period there passes unobserved — nothing is broken by that, the
 * window simply is not put back. Polling `getSystemIdleTime` would close the
 * gap and is deliberately not done: a timer running for the life of the process
 * to catch a case nobody has reported is the wrong trade.
 */

/** The parts of a window's state that a system transition can change. */
export interface WindowState {
  /** Visible at all — false when closed to the tray. */
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
}

/** What to do to a window that changed state while nobody was at the machine.
 *
 *  Pure, and exported, so the policy is testable without an Electron window —
 *  the same reason captureChordOf and clampToPrimary are split out. */
export function restoreAction(before: WindowState, now: WindowState): "none" | "restore" | "maximize" {
  // In the tray before, or in the tray now: not ours to touch. Showing a window
  // the user put away would be a worse bug than the one this fixes.
  if (!before.visible || !now.visible) return "none";
  // They minimised it themselves before walking away. Leave it alone.
  if (before.minimized) return "none";
  if (now.minimized) return "restore";
  // Restored down by a display change — put it back where they left it.
  if (before.maximized && !now.maximized) return "maximize";
  return "none";
}

export function snapshotOf(win: BrowserWindow): WindowState {
  return {
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    maximized: win.isMaximized(),
  };
}

let away: WindowState | null = null;

/**
 * True while the machine is locked or asleep.
 *
 * Read by the geometry persistence in windows.ts: a resize the SYSTEM performed
 * while the user was away is not a size the user chose, and recording it would
 * make the next launch open at whatever the compositor happened to leave behind.
 */
export function isSystemAway(): boolean {
  return away !== null;
}

/**
 * How long to wait after the machine wakes before checking.
 *
 * The window state settles asynchronously — the compositor is still restoring
 * windows when `resume` fires — so reading it immediately reads the state on the
 * way through rather than the state it lands in.
 */
const SETTLE_MS = 600;

export function initWindowStateGuard(getWindow: () => BrowserWindow | null): void {
  const onAway = () => {
    if (away) return; // lock-then-suspend is one absence, not two
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    away = snapshotOf(win);
  };

  const onBack = () => {
    const before = away;
    away = null;
    if (!before) return;
    setTimeout(() => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      const action = restoreAction(before, snapshotOf(win));
      if (action === "none") return;
      try {
        if (action === "restore") win.restore();
        else win.maximize();
        console.info(`[window] ${action}d the main window after the machine woke`);
      } catch (err) {
        console.warn("[window] failed to restore the main window after wake", err);
      }
    }, SETTLE_MS);
  };

  powerMonitor.on("lock-screen", onAway);
  powerMonitor.on("suspend", onAway);
  powerMonitor.on("unlock-screen", onBack);
  powerMonitor.on("resume", onBack);
  // A quit that arrives while the machine is away must not leave the flag set
  // for a next run that shares the module (tests, and a relaunch in-process).
  app.on("will-quit", () => {
    away = null;
  });
}
