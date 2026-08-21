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
 * No speaker/pin state, no call-lifecycle state. `enabled` is the only input
 * that isn't the video itself, and it exists so leaving/ending the call (or
 * losing the stage track) tears the hidden element and any live PiP session
 * down without waiting for CallRoom to unmount.
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

export function useMeetingPiP(track: Track | null, enabled: boolean): MeetingPiPApi {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

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
  // that refusal is exactly what falls back to the existing minimised card.
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.hidden) {
        enter();
      } else if (document.pictureInPictureElement === videoRef.current) {
        void document.exitPictureInPicture().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled, enter]);

  // Left or ended: exit immediately rather than waiting for CallRoom to
  // unmount, so a call that ends while floating doesn't leave a stale PiP
  // window on screen.
  useEffect(() => {
    if (enabled) return;
    if (typeof document !== "undefined" && document.pictureInPictureElement === videoRef.current) {
      void document.exitPictureInPicture().catch(() => {});
    }
  }, [enabled]);

  return { supported, active, toggle };
}
