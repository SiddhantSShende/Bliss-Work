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
 * No speaker/pin state, no call-lifecycle state, and — as of this file —
 * no notion of the user having left the page. It never calls
 * session.minimize()/restore() itself, so it stays usable outside a
 * MeetingSession (the dev preview harness renders CallRoom on its own), and it
 * does not listen for visibilitychange/blur/focus itself either: that signal
 * is lib/userBehaviorAnalysis.ts's job, consumed by
 * lib/useMeetingDisplayController.ts, which is what decides WHEN to call
 * `enter`/`exit` here. This hook is purely the PiP mechanics — the browser API
 * layer — and nothing above it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "livekit-client";
import type { RoomParticipant } from "./useCallRoom";

/** Why an `enter()` attempt did not result in an active PiP session. Not
 *  exposed to meeting participants — this is for logging/diagnostics only,
 *  per the rule that a routine platform refusal is not an application error. */
export type PiPFailureReason =
  | "UNSUPPORTED"
  | "NO_VIDEO_ELEMENT"
  | "NO_VIDEO_TRACK"
  | "ALREADY_IN_PIP"
  | "REQUEST_IN_FLIGHT"
  | "NOT_READY"
  | "NOT_ALLOWED"
  | "BROWSER_RESTRICTION"
  | "UNKNOWN";

export interface MeetingPiPApi {
  /** Whether this runtime can enter Picture-in-Picture at all. */
  supported: boolean;
  /** Whether the meeting's video is the current PiP window right now. */
  active: boolean;
  /** Whether clicking PiP can do anything right now: supported AND there is a
   *  video to float (or PiP is already up, so the click leaves it). */
  available: boolean;
  /** Enter PiP if not active, exit if it is. Safe to call from a click. */
  toggle: () => void;
  /**
   * Attempt to enter PiP now. Resolves `true` once the browser has actually
   * granted it (the `enterpictureinpicture` event has fired and `active` is
   * true), `false` for every expected "no" (unsupported, no track, already
   * active, a request already in flight, or the browser rejecting it — most
   * commonly for lacking a user gesture). Never rejects: a caller branching on
   * success/failure should not also have to catch.
   *
   * Guarded against duplicate/concurrent requests and against re-entering
   * while already active — safe to call from multiple away signals firing in
   * quick succession (see useUserBehaviorAnalysis's own dedup, which this
   * backs up rather than replaces: two independent layers because the
   * consequence of a duplicate `requestPictureInPicture()` call is bad enough
   * to be worth defending twice).
   */
  enter: () => Promise<boolean>;
  /**
   * Leave PiP if active, and resolve once that has actually happened —
   * immediately if it was not active. For a caller that has to SEQUENCE "leave
   * PiP, then do something else" (the display controller's Minimise handling:
   * PiP and the minimised mini-card must never both be on screen, so
   * minimising has to wait for PiP to have actually let go rather than racing
   * it).
   */
  exit: () => Promise<void>;
}

/** HTMLMediaElement.HAVE_METADATA — spelled out because jsdom's constant is not
 *  something a test should have to rely on. */
const HAVE_METADATA = 1;
/** How long a click waits for the first frame before giving up. Chromium keeps a
 *  click's user activation for about five seconds, so this stays well inside it. */
const METADATA_WAIT_MS = 2_000;

/**
 * `requestPictureInPicture()` rejects with InvalidStateError until the element
 * has loaded metadata, i.e. until its first frame has arrived. The element is
 * attached a moment before that (or, for a paused remote layer, a long moment),
 * so a click that arrives first has to wait for it rather than be refused.
 */
function metadataReady(el: HTMLVideoElement): Promise<boolean> {
  if (el.readyState >= HAVE_METADATA) return Promise.resolve(true);
  return new Promise((resolve) => {
    const settle = (ok: boolean) => {
      clearTimeout(timer);
      el.removeEventListener("loadedmetadata", onMeta);
      resolve(ok);
    };
    const onMeta = () => settle(true);
    const timer = setTimeout(() => settle(false), METADATA_WAIT_MS);
    el.addEventListener("loadedmetadata", onMeta);
  });
}

/**
 * The video Picture-in-Picture should follow.
 *
 * The stage participant's own picture first — what CallTile shows on the stage —
 * so PiP is the same thing the viewer is looking at. But the stage is often an
 * avatar (cameras start OFF on join, and the active speaker is frequently
 * someone with no video), and PiP then had nothing to follow while the button
 * stayed lit. So when the stage has no picture, fall back to whoever does:
 * a remote screen share, then a remote camera, then the local camera.
 *
 * Never the local sharer's own screen: a floating window showing the capture of
 * the screen it sits on is a video-feedback loop (see CallTile's selfSharePreview).
 */
export function pickPipTrack(
  stage: RoomParticipant | undefined,
  participants: readonly RoomParticipant[],
): Track | null {
  const shown = (p: RoomParticipant): Track | null => {
    if (p.isLocal && p.sharing) return null;
    if (p.sharing) return p.screenTrack;
    return p.camOn ? p.videoTrack : null;
  };
  const staged = stage ? shown(stage) : null;
  if (staged) return staged;
  const remote = participants.filter((p) => !p.isLocal);
  const sharer = remote.find((p) => p.sharing && p.screenTrack);
  if (sharer) return sharer.screenTrack;
  const camera = [...remote, ...participants.filter((p) => p.isLocal)].find((p) => shown(p));
  return camera ? shown(camera) : null;
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
    // The browser-native path for tab-switch auto-PiP: `requestPictureInPicture()`
    // needs a recent user gesture (transient activation) and a tab switch is not
    // one, so calling it explicitly on an away signal is refused far more often
    // than it succeeds. `autopictureinpicture` is the one thing the spec
    // explicitly exempts from that requirement — the UA itself enters PiP when
    // the document is hidden while this element is playing, no script call
    // needed. The explicit `enter()` call stays as a best-effort fallback for a
    // browser that supports manual PiP but not this attribute.
    el.setAttribute("autopictureinpicture", "");
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
  //
  // `streamId` is CallTile's own lesson: LiveKit can swap the underlying
  // MediaStreamTrack (a camera re-acquired after being stopped) under the same
  // Track wrapper, and an effect keyed on the wrapper alone leaves this element
  // on the ended one — a blank floating window.
  const streamId = track?.mediaStreamTrack?.id;
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    track.attach(el);
    void el.play()?.catch(() => {});
    return () => {
      track.detach(el);
    };
  }, [track, streamId]);

  // Set the instant a request is issued and cleared once it settles — NOT the
  // same thing as `active`, which only flips once the browser has actually
  // granted the request. Two callers can both try to enter PiP within the
  // same tick (a real tab switch fires more than one behaviour signal for a
  // single transition), and `active` is still false for both since neither
  // has resolved yet. Without this ref both calls go through, which is the
  // literal "duplicate PiP request" the feature is required not to make.
  const pipPendingRef = useRef(false);

  const enter = useCallback((): Promise<boolean> => {
    const el = videoRef.current;
    // Classified for diagnostics, deliberately not surfaced to meeting
    // participants — every one of these is an expected, routine outcome (see
    // the file doc), not an application error. No telemetry sink in this app
    // is a fit for "expected, non-actionable, client-only" events like this
    // one (the member-activity pipe in lib/telemetry.tsx records what a
    // person did, not why a browser API declined), so this stays a
    // dev-console breadcrumb rather than a wired-up report.
    const fail = (reason: PiPFailureReason): false => {
      if (reason !== "ALREADY_IN_PIP" && reason !== "REQUEST_IN_FLIGHT") {
        console.debug(`[meeting-pip] enter() declined: ${reason}`);
      }
      return false;
    };
    if (!supported) return Promise.resolve(fail("UNSUPPORTED"));
    if (!el) return Promise.resolve(fail("NO_VIDEO_ELEMENT"));
    if (!track) return Promise.resolve(fail("NO_VIDEO_TRACK"));
    if (active || (typeof document !== "undefined" && document.pictureInPictureElement === el)) {
      return Promise.resolve(fail("ALREADY_IN_PIP"));
    }
    if (pipPendingRef.current) return Promise.resolve(fail("REQUEST_IN_FLIGHT"));
    pipPendingRef.current = true;
    // When the picture is already loaded the request is issued synchronously,
    // inside the click. Otherwise wait for the first frame (see metadataReady).
    const request = async (): Promise<boolean> => {
      if (el.readyState < HAVE_METADATA && !(await metadataReady(el))) return fail("NOT_READY");
      await el.requestPictureInPicture();
      return true;
    };
    return request()
      .catch((e: unknown) =>
        fail(
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "NOT_ALLOWED"
            : "BROWSER_RESTRICTION",
        ),
      )
      .finally(() => {
        pipPendingRef.current = false;
      });
  }, [supported, active, track]);

  const exit = useCallback((): Promise<void> => {
    if (typeof document === "undefined" || document.pictureInPictureElement !== videoRef.current) {
      return Promise.resolve();
    }
    return document.exitPictureInPicture().catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    if (active) {
      void exit();
      return;
    }
    void enter();
  }, [active, enter, exit]);

  // Left or ended: exit immediately rather than waiting for the caller to
  // unmount, so a call that ends while floating doesn't leave a stale PiP
  // window on screen.
  useEffect(() => {
    if (enabled) return;
    void exit();
  }, [enabled, exit]);

  return { supported, active, available: supported && (active || !!track), toggle, enter, exit };
}
