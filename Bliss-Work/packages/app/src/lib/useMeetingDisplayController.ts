/**
 * The single source of truth for how the meeting is currently displayed, and
 * the one place that decides what a user-behaviour "away"/"return" signal
 * should DO to it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * PICTURE_IN_PICTURE (lib/useMeetingPiP.ts) and MINIMIZED (lib/MeetingSession.tsx)
 * are each owned by their own hook/provider, for good reasons that predate this
 * file — PiP is pure browser mechanics with no call-lifecycle opinion, MINIMIZED
 * is what keeps a meeting alive while the rest of the app is used. Left to
 * their own devices they are two independent booleans that can both be true at
 * once. This hook is the layer above both of them that enforces they never are,
 * and that translates a behavioural event into the right one of them —
 * exactly the "Meeting Display Controller" a caller like CallRoom should talk
 * to instead of poking session.minimize()/pip.enter() directly from several
 * places.
 *
 * ── Where the away/return signal comes from ──────────────────────────────────
 * lib/userBehaviorAnalysis.ts — the app's existing, general-purpose "is the
 * user still on this page" detector (visibilitychange + window blur/focus).
 * This hook is a CONSUMER of it, not a second implementation: it owns no
 * `document.addEventListener` of its own.
 *
 * ── The flow ──────────────────────────────────────────────────────────────────
 *   USER_AWAY    → attempt PiP (lib/useMeetingPiP's enter(), which is already
 *                  guarded against duplicate/concurrent requests and against
 *                  re-entering while already active) →
 *                    succeeded → drop out of MINIMIZED if it was on
 *                    failed    → fall back to MINIMIZED, unless already there
 *   USER_RETURNED → exit PiP if active, then restore whatever display mode
 *                   was in effect before this away episode started — which is
 *                   NOT always NORMAL: a meeting the user minimised on purpose
 *                   BEFORE switching tabs must still be minimised when they
 *                   come back, or the away signal would be silently overriding
 *                   a choice it was never asked to touch.
 *
 * Manually minimising while PiP is active (the button, not a behaviour event)
 * goes through `handleMinimize` below, which exits PiP first — the other half
 * of the mutual-exclusion invariant, for the one transition that isn't driven
 * by userBehaviorAnalysis at all.
 */
import { useCallback, useEffect, useRef } from "react";
import { useUserBehaviorAnalysis } from "./userBehaviorAnalysis";
import type { MeetingPiPApi } from "./useMeetingPiP";

export type MeetingDisplayMode = "NORMAL" | "MINIMIZED" | "PICTURE_IN_PICTURE";

/** The slice of MeetingSessionApi this controller needs — narrowed so it can
 *  be exercised in a test, or reused outside a MeetingSession, without the
 *  rest of that API along for the ride. */
export interface MeetingDisplaySession {
  minimized: boolean;
  minimize: () => void;
  restore: () => void;
}

export interface MeetingDisplayController {
  /** The one place to ask "what is the meeting doing right now" — computed,
   *  not stored twice: PICTURE_IN_PICTURE whenever the browser reports PiP
   *  active, MINIMIZED whenever the session says so and PiP is not, NORMAL
   *  otherwise. Because it is computed from the two underlying flags every
   *  render rather than latched, it can never itself go stale into a state
   *  where both would read true. */
  mode: MeetingDisplayMode;
  /** Minimise, exiting an active PiP session first. Use this instead of
   *  calling session.minimize() directly — see the file doc. */
  handleMinimize: () => void;
}

export function useMeetingDisplayController(
  session: MeetingDisplaySession | null,
  pip: MeetingPiPApi,
  enabled: boolean,
): MeetingDisplayController {
  const minimized = session?.minimized ?? false;

  // What the display mode was the moment the CURRENT away episode started —
  // restored verbatim on return. Covers both directions: a fallback minimise
  // this controller applied on the way out is undone on the way back, and a
  // minimise the USER already had in place before going away is left alone
  // (put back exactly as found), never popped open just because they switched
  // tabs and came back.
  const priorMinimizedRef = useRef(false);
  // Whether the fallback branch below is what minimised the room on this
  // away episode — as opposed to it already having been minimised. Only this
  // case gets undone automatically; an independent, deliberate minimise is
  // the user's to restore, not this controller's.
  const autoMinimizedRef = useRef(false);

  const onAway = useCallback(() => {
    if (!session) return;
    priorMinimizedRef.current = minimized;
    void pip.enter().then((entered) => {
      if (entered) {
        // PiP is now the visible surface; a mini-card behind it would be the
        // exact double-display this controller exists to prevent. The
        // reconciliation effect below also catches this — this is the
        // synchronous half for the common case, so there is no visible frame
        // where both are true.
        if (minimized) session.restore();
        return;
      }
      // PiP unsupported, no track yet, or the browser refused it (most often
      // for lacking a user gesture — see useMeetingPiP's file doc; this is an
      // expected platform limitation, not something to retry or work around).
      // Fall back to the existing minimised card so the meeting still keeps
      // running out of the way. Do nothing if it is already minimised — there
      // is nothing to change, and re-minimising would be indistinguishable
      // from this controller having done it, which would wrongly pop it back
      // open on return (see onReturn below).
      if (!minimized) {
        autoMinimizedRef.current = true;
        session.minimize();
      }
    });
  }, [session, minimized, pip]);

  const onReturn = useCallback(() => {
    if (!session) return;
    void pip.exit().then(() => {
      if (priorMinimizedRef.current) session.minimize();
      else if (autoMinimizedRef.current) session.restore();
      autoMinimizedRef.current = false;
    });
  }, [session, pip]);

  useUserBehaviorAnalysis(enabled, { onAway, onReturn });

  // Belt-and-suspenders for the same invariant `onAway` already applies in
  // the common case: PiP's own grant is asynchronous (see useMeetingPiP), so
  // "minimised, then a beat later PiP actually engages" is reachable even
  // outside the away flow above — most notably the browser's native
  // `autopictureinpicture` attribute, which can put PiP into the ACTIVE state
  // on its own, with no call into this controller at all. Whenever that
  // happens while minimised, drop out of minimised immediately; onReturn is
  // what restores the right prior mode once PiP ends either way.
  useEffect(() => {
    if (pip.active && minimized) session?.restore();
  }, [pip.active, minimized, session]);

  // The manual path: a click, not a behaviour event, so it is handled here
  // directly rather than through userBehaviorAnalysis. PiP has to actually
  // let go before minimising — see useMeetingPiP.exit's own doc for why this
  // is sequenced on its promise rather than left to the effect above (no
  // visible flicker for something the user is watching happen).
  const handleMinimize = useCallback(() => {
    if (!session) return;
    void pip.exit().then(() => session.minimize());
  }, [pip, session]);

  const mode: MeetingDisplayMode = pip.active
    ? "PICTURE_IN_PICTURE"
    : minimized
      ? "MINIMIZED"
      : "NORMAL";

  return { mode, handleMinimize };
}
