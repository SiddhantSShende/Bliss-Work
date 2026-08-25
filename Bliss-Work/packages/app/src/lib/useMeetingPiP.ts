/**
 * Native browser Picture-in-Picture for the meeting's stage video.
 *
 * ── Why a hidden video element of its own ────────────────────────────────────
 * `requestPictureInPicture()` operates on a real `HTMLVideoElement`, and the
 * ones CallTile renders come and go with the UI they belong to (hidden behind
 * `display:none` while minimised, unmounted when nobody is on the stage) —
 * exactly the states PiP is supposed to survive. This hook owns ONE video
 * element, created once and never part of the React tree, and keeps it
 * attached to whatever the room's stage is currently showing. It is the SAME
 * `Track` object CallTile attaches elsewhere — LiveKit tracks attach to any
 * number of elements at once — so this is never a second connection, and
 * never a second subscription.
 *
 * ── Why this also IS the Electron implementation ─────────────────────────────
 * Electron's renderer is Chromium, and Chromium's video Picture-in-Picture is
 * a platform feature, not a browser-tab feature: `requestPictureInPicture()`
 * produces a genuine always-on-top OS window there too, over the SAME video
 * element, with no second BrowserWindow, no IPC, and therefore no way to end
 * up with a second call connection. See main/index.ts for the one Electron
 * change this needed (allow-listing the "picture-in-picture" permission).
 *
 * ── State this deliberately does NOT touch ───────────────────────────────────
 * No speaker/pin state, and no call-lifecycle state OF ITS OWN: this hook
 * never calls session.minimize()/restore() itself, so it stays usable outside
 * a MeetingSession (the dev preview harness renders CallRoom on its own).
 * `onAway`/`onBack` are the escape hatch for a caller that DOES have one —
 * CallRoom uses them to collapse the maximized room in step with PiP — fired
 * on the same signal PiP itself reacts to, whether or not the native request
 * succeeds.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "livekit-client";

export interface MeetingPiPApi {
  /** Whether this runtime can enter Picture-in-Picture at all. */
  supported: boolean;
  /** Whether the meeting's video is the current PiP window right now. */
  active: boolean;
  /** Enter PiP if not active, exit if it is. Safe to call from a click. */
  toggle: () => void;
}

export interface MeetingPiPCallbacks {
  /**
   * The user appears to have switched away from the window — fires whether
   * or not the native PiP request itself succeeds (unsupported runtimes,
   * and refusals with no user gesture behind them, still fire this). This is
   * the hook's half of "fall back to the existing minimised card": the
   * caller decides what that fallback is.
   */
  onAway?: () => void;
  /** The user is back. Fires once per return, whether or not PiP was active. */
  onBack?: () => void;
}

export function useMeetingPiP(
  track: Track | null,
  enabled: boolean,
  { onAway, onBack }: MeetingPiPCallbacks = {},
): MeetingPiPApi {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  // Whether the last hide/blur has been matched by a show/focus yet. A plain
  // ref rather than effect-local state: it must survive the away/back effect
  // re-subscribing (see the refs below) and must NOT survive `enabled` going
  // false, which the leaving/ended effect resets explicitly.
  const awayRef = useRef(false);
  // Read fresh by the away/back effect without it having to depend on the
  // callbacks themselves — CallRoom passes a fresh object every render, and
  // depending on it directly would tear the listeners down and re-add them on
  // every unrelated re-render (a speaking-state tick, a participant sync).
  const onAwayRef = useRef(onAway);
  onAwayRef.current = onAway;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  // The element PiP actually operates on — created once, off-screen, and
  // never rendered by React. Not `display:none`: the Picture-in-Picture spec
  // requires the element to be laid out, so it is shrunk to a transparent
  // 1x1px instead.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.style.position = "fixed";
    el.style.width = "1px";
    el.style.height = "1px";
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
    document.body.appendChild(el);
    videoRef.current = el;
    setSupported("pictureInPictureEnabled" in document && document.pictureInPictureEnabled);

    const onEnter = () => setActive(true);
    const onLeave = () => setActive(false);
    el.addEventListener("enterpictureinpicture", onEnter);
    el.addEventListener("leavepictureinpicture", onLeave);

    return () => {
      el.removeEventListener("enterpictureinpicture", onEnter);
      el.removeEventListener("leavepictureinpicture", onLeave);
      if (document.pictureInPictureElement === el) void document.exitPictureInPicture().catch(() => {});
      el.remove();
      videoRef.current = null;
    };
  }, []);

  // Follow whatever the stage is currently showing — the same attach/detach
  // pattern CallTile uses for its own tiles, on this one extra element.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    track.attach(el);
    void el.play().catch(() => {});
    return () => {
      track.detach(el);
    };
  }, [track]);

  const enter = useCallback(() => {
    const el = videoRef.current;
    if (!el || !supported) return;
    // A rejected/blocked request (no user gesture, nothing attached yet, a
    // browser policy) is an expected outcome here, not a bug — swallowing it
    // is what lets the existing minimised card carry on as the fallback.
    void el.requestPictureInPicture().catch(() => {});
  }, [supported]);

  const toggle = useCallback(() => {
    if (active) {
      void document.exitPictureInPicture().catch(() => {});
      return;
    }
    enter();
  }, [active, enter]);

  // Best-effort auto-attempt on hide, auto-exit on return. The hide-side
  // attempt has no user gesture behind it, so browsers are free to refuse —
  // that refusal is exactly what falls back to onAway's minimised card.
  //
  // Two signals, because neither covers both hosts on its own — the same gap
  // useWhatsAppForward.ts hit first. A browser tab switch fires
  // visibilitychange. The desktop app keeps the window "visible" to the Page
  // Visibility API while the user is on a completely different application —
  // Electron does not treat losing OS focus as losing visibility unless the
  // window is actually minimised — so only window blur/focus fire there.
  // `awayRef` makes a real tab switch, which can fire both, a single event
  // rather than two.
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    // PiP itself is entered/exited unconditionally on every signal, exactly as
    // before this hook had an away/back notion at all — a manual toggle() can
    // put PiP into a state neither `awayRef` nor a caller's onAway ever knew
    // about, and returning to the window should still close it. `awayRef`
    // guards ONLY the onAway/onBack notifications, so a real transition that
    // fires both signals (a tab switch fires visibilitychange AND blur/focus)
    // tells the caller once rather than twice.
    const goAway = () => {
      enter();
      if (awayRef.current) return;
      awayRef.current = true;
      onAwayRef.current?.();
    };
    const comeBack = () => {
      if (document.pictureInPictureElement === videoRef.current) {
        void document.exitPictureInPicture().catch(() => {});
      }
      if (!awayRef.current) return;
      awayRef.current = false;
      onBackRef.current?.();
    };
    const onVisibility = () => (document.hidden ? goAway() : comeBack());
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", goAway);
    window.addEventListener("focus", comeBack);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", goAway);
      window.removeEventListener("focus", comeBack);
    };
  }, [enabled, enter]);

  // Left or ended: exit immediately rather than waiting for CallRoom to
  // unmount, so a call that ends while floating doesn't leave a stale PiP
  // window on screen. Also drops the away/back latch — a call that ends while
  // "away" must not have the NEXT call's first blur silently ignored as an
  // already-away no-op.
  useEffect(() => {
    if (enabled) return;
    awayRef.current = false;
    if (typeof document !== "undefined" && document.pictureInPictureElement === videoRef.current) {
      void document.exitPictureInPicture().catch(() => {});
    }
  }, [enabled]);

  return { supported, active, toggle };
}
