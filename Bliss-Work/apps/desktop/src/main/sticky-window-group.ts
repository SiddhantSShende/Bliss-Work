import type { BrowserWindow } from "electron";
import { clampToPrimary, isOnPrimary } from "./sticky-state";

/**
 * Shared BrowserWindow-group glue for StickyManager and ChatStickyManager.
 *
 * Both managers own a `Map<string, BrowserWindow>` of live widgets and need the
 * same operations on it — re-confine to the primary display, snap a single
 * dragged widget back onto it, and (chat only) drop always-on-top. The underlying clamp
 * math already lives in ./sticky-state (shared); this is the thin per-window
 * iteration on top of it, factored out because it was byte-for-byte identical
 * in both managers and every caller already invokes it on both managers back
 * to back (see index.ts).
 *
 * Deliberately NOT a merge of the two managers themselves — pin semantics
 * (auto-pin + cap-refusal vs explicit-pin + LRU-evict), default placement
 * (collapse-aware top-right cascade vs bottom-right cascade), and window
 * creation (createStickyWindow vs a hardened chat window) differ for real
 * product reasons and stay in each manager.
 */

/**
 * Force every live window in the group OUT of always-on-top.
 *
 * Named for what it does rather than for a policy, because it is only correct
 * for CHAT notes — the only caller. A chat note is a normal floating window and
 * is meant to sit in the ordinary stack.
 *
 * Do NOT apply this to task notes. Their always-on-top flag is the mechanism
 * that rests them on the desktop (see createStickyWindow and
 * StickyManager.setSafeToFloat); calling this on them would silently undo the
 * feature, which is exactly how it was lost once already.
 */
export function dropAlwaysOnTop(widgets: Iterable<BrowserWindow>): void {
  for (const w of widgets) if (!w.isDestroyed()) w.setAlwaysOnTop(false);
}

/** Re-confine every live window in the group to the primary display's work
 *  area. Called on display add/remove/metrics-change so an unplugged monitor
 *  can't strand a widget off the main desktop screen. */
export function reclampGroupToPrimary(widgets: Iterable<BrowserWindow>): void {
  for (const w of widgets) {
    if (w.isDestroyed()) continue;
    const b = w.getBounds();
    if (isOnPrimary(b)) continue;
    const g = clampToPrimary({ ...b, minimized: false, lastSeenAt: 0 });
    w.setBounds({ x: g.x, y: g.y, width: b.width, height: b.height });
  }
}

/** Snap one window back onto the primary display if a drag left it on a
 *  secondary monitor. Call from a `moved` listener once the move has
 *  finished (never mid-drag). No-op if the window is already on-primary. */
export function snapBackIfOffPrimary(w: BrowserWindow): void {
  if (w.isDestroyed()) return;
  const b = w.getBounds();
  if (isOnPrimary(b)) return;
  const g = clampToPrimary({ ...b, minimized: false, lastSeenAt: 0 });
  w.setBounds({ x: g.x, y: g.y, width: b.width, height: b.height });
}
