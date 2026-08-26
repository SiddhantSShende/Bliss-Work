/**
 * Client-side user behaviour analysis: is the person still looking at this
 * page, or have they gone away from it.
 *
 * ── Why this exists as its own module ────────────────────────────────────────
 * This detection used to live inline inside useMeetingPiP.ts, private to the
 * meeting. It has nothing to do with video or Picture-in-Picture — it is a
 * general "is the user present" signal — so it is extracted here as the one
 * place in the app that owns `document.visibilitychange` / window blur+focus
 * for this purpose. Anything that needs to react to the user leaving or
 * returning (the meeting's auto-PiP is the first consumer) subscribes to
 * THIS, rather than adding its own listener pair. A second, independent
 * `document.addEventListener("visibilitychange", ...)` for the same concept
 * is exactly the duplication this module exists to prevent.
 *
 * This is NOT the same thing as `telemetry.tsx`'s TelemetryBridge, which also
 * listens for visibilitychange — that is a write-only analytics pipe (it POSTs
 * blur/focus/idle events to telemetry-svc for a member's historical activity
 * record) with no live signal exposed back into the running app, and it does
 * not cover the desktop case below. This module is the live, in-memory,
 * same-tab signal a component can actually subscribe to right now.
 *
 * ── Why both visibilitychange AND window blur/focus ──────────────────────────
 * A browser tab switch fires `visibilitychange` (`document.hidden` flips).
 * The desktop app (Electron) does NOT: its renderer keeps reporting the page
 * as visible while the user is on a completely different application, because
 * Electron only treats an actually-minimised window as hidden — losing OS
 * focus is invisible to the Page Visibility API there. Only window blur/focus
 * fire in that case. Using only one signal silently loses the other host.
 *
 * ── Purely client-local ───────────────────────────────────────────────────────
 * No network call, no server round-trip, no signaling frame. It observes only
 * this tab's own `document`/`window`, so by construction it can never affect
 * anyone but the person whose browser it runs in — there is no channel here
 * for one participant's away state to reach another participant's client.
 */
import { useEffect, useRef, useState } from "react";

export type UserBehaviorSource = "visibility" | "blur" | "focus";

export interface UserBehaviorEvent {
  /** `Date.now()` at the moment the event fired. */
  occurredAt: number;
  /** Which signal produced this event — for diagnostics, not for branching:
   *  a real tab switch fires more than one of these for a single transition
   *  (see the dedup note below), and callers see one logical event either way. */
  source: UserBehaviorSource;
}

export interface UserBehaviorCallbacks {
  /** The user appears to have left this page — a tab switch, an app switch on
   *  desktop, or a window blur. Fires once per transition even though a real
   *  tab switch can trigger more than one of the underlying browser events. */
  onAway?: (event: UserBehaviorEvent) => void;
  /** The user is back. Fires once per return, symmetrically with onAway. */
  onReturn?: (event: UserBehaviorEvent) => void;
}

export interface UserBehaviorAnalysis {
  /** Whether the user is currently believed to be away from this page. */
  away: boolean;
}

/**
 * Subscribes to this tab's presence. `enabled` gates the whole thing — pass
 * `false` when there is nothing that needs to know right now (call not
 * connected, feature not in use); the listeners are not attached at all.
 */
export function useUserBehaviorAnalysis(
  enabled: boolean,
  { onAway, onReturn }: UserBehaviorCallbacks = {},
): UserBehaviorAnalysis {
  const [away, setAway] = useState(false);
  // Whether the last leave has been matched by a return yet. A ref rather than
  // relying on `away` state directly: it must survive this effect
  // re-subscribing (see the callback refs below) and is what turns "a tab
  // switch fires both visibilitychange and blur" into a single onAway call
  // instead of two.
  const awayRef = useRef(false);
  // Read fresh without making the subscription effect depend on the callbacks
  // themselves — callers typically pass a fresh object every render, and
  // depending on it directly would tear the listeners down and re-add them on
  // every unrelated re-render.
  const onAwayRef = useRef(onAway);
  onAwayRef.current = onAway;
  const onReturnRef = useRef(onReturn);
  onReturnRef.current = onReturn;

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    const fireAway = (source: UserBehaviorSource) => {
      if (awayRef.current) return;
      awayRef.current = true;
      setAway(true);
      onAwayRef.current?.({ occurredAt: Date.now(), source });
    };
    const fireReturn = (source: UserBehaviorSource) => {
      if (!awayRef.current) return;
      awayRef.current = false;
      setAway(false);
      onReturnRef.current?.({ occurredAt: Date.now(), source });
    };
    const onVisibility = () =>
      document.hidden ? fireAway("visibility") : fireReturn("visibility");
    const onBlur = () => fireAway("blur");
    const onFocus = () => fireReturn("focus");

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled]);

  // Disabled mid-away (the feature that cared stopped caring — a call ended
  // while the tab was in the background): drop the latch so the NEXT time
  // this subscribes, a fresh away is not silently swallowed as an
  // already-away no-op, and the state doesn't stay stuck reporting "away".
  useEffect(() => {
    if (enabled) return;
    awayRef.current = false;
    setAway(false);
  }, [enabled]);

  return { away };
}
