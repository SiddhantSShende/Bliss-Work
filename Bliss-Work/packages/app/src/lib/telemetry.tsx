/**
 * The client half of the member activity record.
 *
 * Mounted once inside the authenticated shell. It observes four things and
 * nothing else:
 *
 *   * which section you are in, and for how long   (route.enter / route.dwell)
 *   * whether the window has focus                 (focus / blur)
 *   * whether you are actually at the keyboard     (idle.start / idle.end)
 *   * that you are still here                      (a beacon, recorded on the
 *                                                   session rather than as an
 *                                                   event of its own)
 *
 * It does NOT observe what you type, click, or read — everything of that kind
 * is already recorded server-side from the events the services emit, where it
 * cannot be forged. This half exists to answer "were they working", which no
 * server-side event can answer on its own.
 *
 * Every timer and listener is torn down on unmount, and the whole thing is inert
 * until the session is authenticated.
 *
 * ── Who measures idle and active time ───────────────────────────────────────
 * Here, from the window's own input and visibility — EXCEPT where the host
 * reports `config.osActivityTracking`. The desktop's main process then reads the
 * OS's own idle counter, which sees the whole machine where this can only see
 * its own window (and so calls someone working in another application idle).
 * In that mode this component takes no part in idle/active accounting at all —
 * no input listeners, no idle timer, no idle.start/idle.end, no addTime — and
 * what it keeps is everything that is not a measurement of time: which section
 * you are in (route.enter / route.dwell), window focus/blur, and presence.
 * Doing both would credit the same minutes twice.
 *
 * The host's measurements arrive here instead: on each tick this collects the
 * spans the main process has finished (`config.drainActivitySpans`) and feeds
 * them to the same queue — see lib/activitySpans.ts for how a span becomes an
 * event and time. That is the ONLY place desktop active/idle time comes from.
 */
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useRuntime } from "./runtime";
import { ensureFreshSession } from "./refresh";
import { useSession } from "../store/session";
import { surfaceOf } from "./section";
import { TelemetryQueue, type QueuedEvent } from "./telemetryQueue";
import { ingestActivitySpans } from "./activitySpans";

/** Every field but the id `TelemetryQueue.push()` assigns itself. */
type UnstampedEvent = Omit<QueuedEvent, "clientEventId">;
import {
  endSession,
  getSessionId,
  installTelemetrySession,
  onSessionIdChange,
} from "./telemetrySession";

/** Flush cadence while the tab is visible. */
const FLUSH_MS = 30_000;
/**
 * No pointer/key/scroll for this long, while visible, and you are idle. Five
 * minutes is the interval at which "away from the keyboard" starts to mean
 * something; anything shorter reports a person reading a long document as idle.
 */
const IDLE_AFTER_MS = 5 * 60_000;
/** Beat while visible. The server's session timeout is 3x this. */
const HEARTBEAT_MS = 60_000;
/** Hidden-but-open: still alive, but at a twentieth of the traffic. */
const HIDDEN_HEARTBEAT_MS = 5 * 60_000;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

/**
 * The queue belonging to the mounted bridge, if any.
 *
 * Module-level so SIGN-OUT can close the activity session explicitly, while the
 * access token is still valid. Leaving it to the unmount does not work: the
 * session store is cleared first, so the final beacon goes out with no bearer,
 * 401s, and the session stays open on the server — which is what left people
 * reading as "Online" to their colleagues long after they signed out.
 */
let activeQueue: TelemetryQueue | null = null;
/** The mounted bridge's span collector, so sign-out can take what main has finished before it closes the session. */
let activeDrain: (() => Promise<void>) | null = null;

/**
 * Close the activity session NOW. Call BEFORE clearing the session.
 *
 * Idempotent and never throws: a failure here must not stop a sign-out. The
 * server's sweeper is the backstop if it does fail, but it is measured in
 * minutes, which is exactly the delay this exists to remove.
 */
export async function endTelemetrySession(): Promise<void> {
  const queue = activeQueue;
  if (!queue) return;
  activeQueue = null;
  const drain = activeDrain;
  activeDrain = null;
  try {
    await drain?.(); // never throws; spans main has already closed ride the goodbye

    if (!(await queue.flush({ ended: true }))) {
      // Either a periodic flush was in flight and swallowed ours (flush is
      // single-flight) or the request failed and the batch was re-queued. The
      // goodbye is the one message that must land — without it the person keeps
      // reading as Online to their colleagues until the server's sweeper times
      // the session out — so give it one more try.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await queue.flush({ ended: true });
    }
    // The id is closed server-side now. Keeping it would have the next sign-in
    // open with a dead session id, which the server answers by minting a
    // replacement — correct, but a round trip and a confusing wire. endSession
    // (not setSessionId(null)) so sibling tabs are told too, not just this one.
    endSession();
  } catch {
    /* best-effort: never block or break a sign-out */
  }
}

export function TelemetryBridge() {
  const { api, config } = useRuntime();
  const location = useLocation();
  const status = useSession((s) => s.status);
  const authed = status === "authed";
  const osAccounting = config.osActivityTracking === true;

  const queueRef = useRef<TelemetryQueue | null>(null);
  // Refs, not state: every one of these changes on a timer or a DOM event, and
  // re-rendering the whole shell because a heartbeat fired would make the
  // observer more expensive than the thing observed.
  const lastInputRef = useRef(Date.now());
  const idleSinceRef = useRef<number | null>(null);
  const accrualStartRef = useRef(Date.now());
  const surfaceRef = useRef<{ name: string; since: number } | null>(null);
  // The visibility state that was true for the period accrue() is about to
  // classify — NOT necessarily document.visibilityState right now. See accrue().
  const wasVisibleRef = useRef(true);

  useEffect(() => {
    if (!authed) return;

    const queue = new TelemetryQueue(
      (payload) => api.sendBeacon(payload),
      // Desktop rows are distinguishable from web rows in the record, which
      // matters once the desktop agent starts contributing app usage too.
      typeof window !== "undefined" && "taskboard" in window ? "desktop" : "web",
      // Skip the beacon rather than send one that is certain to fail (offline,
      // or a token that expired while the machine slept): the browser logs
      // every failed request to the console no matter how quietly it is handled.
      () => ensureFreshSession(config.authBase, config.persistToken, config.getRefreshToken),
    );
    queueRef.current = queue;
    activeQueue = queue;
    queue.sessionId = getSessionId();
    wasVisibleRef.current = document.visibilityState !== "hidden";

    const teardownSession = installTelemetrySession();
    const unsubscribe = onSessionIdChange((id) => {
      queue.sessionId = id;
    });

    const now = () => Date.now();
    // With nothing accrued here a quiet heartbeat has no payload, so presence has
    // to be asserted explicitly or the server would sweep the session as gone.
    const heartbeatFlush = osAccounting ? { keepalive: true } : {};
    // Cleared on unmount: a collection still in flight when the user signs out
    // must not drop the old user's spans into whatever happens next.
    let live = true;
    const drainSpans = async () => {
      if (!osAccounting || !config.drainActivitySpans) return;
      try {
        const spans = await config.drainActivitySpans();
        if (live) ingestActivitySpans(queue, spans);
      } catch {
        // The window is reloading or the host is busy: the spans stay with main
        // and the next tick collects them. Telemetry never throws.
      }
    };
    const push = (event: UnstampedEvent) => {
      queue.push(event);
      if (queue.shouldFlush) void queue.flush();
    };
    const stamp = (extra: Partial<UnstampedEvent> & { action: string }): UnstampedEvent => ({
      category: "navigation",
      occurredAt: new Date().toISOString(),
      ...extra,
    });

    /** Bank the time since the last accrual as active or idle, and reset. */
    const accrue = () => {
      const t = now();
      const elapsed = Math.max(0, t - accrualStartRef.current);
      accrualStartRef.current = t;
      if (!elapsed) return;
      // The host measures active/idle itself (see the header). Time still
      // advances above so a later accrual never spans a gap, but none is banked.
      if (osAccounting) return;
      // Hidden or idle time is IDLE time. Counting a backgrounded tab as active
      // is the single easiest way to make this record dishonest, and it would
      // flatter everyone equally rather than measuring anything.
      //
      // Classify using wasVisibleRef — the visibility state that held for the
      // period just ending — not document.visibilityState. Per spec, the
      // latter has already flipped to the NEW value by the time a
      // visibilitychange listener runs, so reading it here would attribute an
      // entire just-ended hidden period to "active" the instant the tab comes
      // back. onVisibility() updates wasVisibleRef only after this call.
      const isIdle = !wasVisibleRef.current || idleSinceRef.current !== null;
      queue.addTime(isIdle ? 0 : elapsed, isIdle ? elapsed : 0);
    };

    const markActive = () => {
      lastInputRef.current = now();
      if (idleSinceRef.current !== null) {
        accrue();
        idleSinceRef.current = null;
        push(stamp({ action: "idle.end", category: "engagement" }));
      }
    };

    const checkIdle = () => {
      if (document.visibilityState === "hidden") return; // already idle by definition
      if (idleSinceRef.current !== null) return;
      if (now() - lastInputRef.current < IDLE_AFTER_MS) return;
      accrue();
      idleSinceRef.current = now();
      push(stamp({ action: "idle.start", category: "engagement" }));
    };

    const onVisibility = () => {
      // accrue() must run BEFORE wasVisibleRef is updated: it needs to
      // classify the period that just ended using the OLD visibility state,
      // and document.visibilityState itself has already moved to the new one.
      accrue();
      const isHidden = document.visibilityState === "hidden";
      wasVisibleRef.current = !isHidden;
      if (isHidden) {
        push(stamp({ action: "blur", category: "engagement" }));
        // Flush on the way out: a tab that is hidden may never come back, and
        // whatever is buffered is the most recent thing we know.
        void queue.flush();
      } else {
        markActive();
        push(stamp({ action: "focus", category: "engagement" }));
      }
    };

    /**
     * Last chance to speak. `pagehide` (not `beforeunload`) because it is the
     * only unload-ish event that fires reliably on mobile Safari and when a tab
     * is discarded — and `ended: true` closes the session precisely instead of
     * leaving it for the sweeper three minutes later.
     */
    const onPageHide = () => {
      accrue();
      closeSurface();
      void queue.flush({ ended: true });
    };

    const closeSurface = () => {
      const open = surfaceRef.current;
      if (!open) return;
      const durationMs = now() - open.since;
      surfaceRef.current = null;
      // Sub-second dwells are navigation noise — a redirect, a mistyped click.
      if (durationMs >= 1000) {
        push(stamp({ action: "route.dwell", surface: open.name, durationMs }));
      }
    };

    // Input listeners exist only to detect in-window idleness; in OS-accounting
    // mode there is nothing for them to feed.
    if (!osAccounting) {
      ACTIVITY_EVENTS.forEach((e) =>
        window.addEventListener(e, markActive, { passive: true }),
      );
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    // Back online: don't sit out the remainder of a backoff that only existed
    // because we weren't.
    const onOnline = () => {
      queue.clearBackoff();
      void queue.flush();
    };
    window.addEventListener("online", onOnline);

    /** One periodic pass: collect the host's spans (desktop only), bank time, send. */
    const sync = () => {
      const send = () => {
        accrue();
        void queue.flush(heartbeatFlush);
      };
      if (osAccounting) void drainSpans().then(send);
      else send();
    };
    const flushTimer = window.setInterval(sync, FLUSH_MS);
    const idleTimer = osAccounting ? undefined : window.setInterval(checkIdle, 30_000);
    /**
     * "Still here." Deliberately NOT an event: the beacon itself is the signal
     * — the server advances the session's last_seen_at and banks the accrued
     * active/idle time on receipt — so recording a row alongside it stored the
     * same fact twice and put a minute-by-minute wall of identical entries on
     * the timeline, on top of the events that actually say what someone did.
     */
    const beat = sync;
    let heartbeatTimer = window.setInterval(beat, HEARTBEAT_MS);
    const retuneHeartbeat = () => {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = window.setInterval(
        beat,
        document.visibilityState === "hidden" ? HIDDEN_HEARTBEAT_MS : HEARTBEAT_MS,
      );
    };
    document.addEventListener("visibilitychange", retuneHeartbeat);
    activeDrain = drainSpans;
    void drainSpans(); // whatever main finished before this window was ready

    return () => {
      live = false;
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, markActive));
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("visibilitychange", retuneHeartbeat);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      window.clearInterval(flushTimer);
      if (idleTimer !== undefined) window.clearInterval(idleTimer);
      window.clearInterval(heartbeatTimer);
      unsubscribe();
      teardownSession();
      accrue();
      closeSurface();
      // Only if this queue is still the live one. A sign-out has already closed
      // the session through endTelemetrySession, and flushing again here would
      // be an unauthenticated POST (the token is gone by now) that either 401s
      // or re-opens the session we just closed.
      if (activeQueue === queue) {
        activeQueue = null;
        activeDrain = null;
        void queue.flush();
      }
      queueRef.current = null;
    };
    // Rebuilt only when auth flips — `api` is stable for the life of the runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Route changes: close the previous surface with its dwell time, open the new.
  useEffect(() => {
    const queue = queueRef.current;
    if (!authed || !queue) return;
    const name = surfaceOf(location.pathname);
    const open = surfaceRef.current;
    if (open?.name === name) return; // a detail route inside the same section

    if (open) {
      const durationMs = Date.now() - open.since;
      if (durationMs >= 1000) {
        queue.push({
          action: "route.dwell",
          category: "navigation",
          occurredAt: new Date().toISOString(),
          surface: open.name,
          durationMs,
        });
      }
    }
    surfaceRef.current = name ? { name, since: Date.now() } : null;
    if (name) {
      queue.push({
        action: "route.enter",
        category: "navigation",
        occurredAt: new Date().toISOString(),
        surface: name,
      });
    }
    if (queue.shouldFlush) void queue.flush();
  }, [authed, location.pathname]);

  // Sign-out: drop anything unsent and forget the id.
  //
  // The GOODBYE is not sent here, and cannot be: by the time `authed` flips the
  // session store has been cleared, so the beacon would carry no bearer and
  // 401. That is why signOut() calls endTelemetrySession() first, while the
  // token is still valid — this effect is the local cleanup that follows, and
  // the backstop for the sign-outs that never reach signOut (a dead refresh
  // family, a sibling tab's broadcast), where the server's sweeper closes the
  // session instead.
  useEffect(() => {
    if (authed) return;
    queueRef.current?.reset();
    endSession();
  }, [authed]);

  return null;
}
