/**
 * The meeting you are in, held above the router.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 * The room used to be rendered BY a route — Meetings, ChannelView, CallWindow,
 * JoinCallView each mounted `<CallRoom/>` themselves. `useCallRoom` disconnects
 * and posts a leave on unmount (deliberately: navigating away IS leaving), so
 * the meeting could not survive a click on anything. Being in a meeting and
 * using BlissWork were the same surface, and you could only have one.
 *
 * So the room moved up here, above `<Routes>` and beside the other overlay that
 * outlives navigation (BrowserStickies). A route no longer renders the meeting;
 * it ASKS for one with `enter(call)` and gets on with its own life. Nothing
 * unmounts the room but leaving it.
 *
 * ── Why the state is so small ────────────────────────────────────────────────
 * Only what a route has to be able to say lives here: which call, and whether
 * it is minimised. Everything else the meeting knows — participants, hands,
 * notes, chat, who is speaking, what is pinned — stays inside CallRoom, which
 * is safe precisely BECAUSE it no longer unmounts. Lifting that state too would
 * have been a second copy of it with nothing to gain.
 *
 * ── Minimising navigates, on purpose ─────────────────────────────────────────
 * A meeting opened in its own tab (lib/callWindow) sits at /call/:id, where
 * there is no app to use. Minimising there without going anywhere would leave
 * the user staring at a blank page behind the floating window, so `minimize()`
 * takes them into the app. That is what makes "carry on working with the
 * meeting running" true in the tab the meeting owns.
 *
 * ── And it minimises itself when you leave the room ──────────────────────────
 * The room covers the screen, so navigating while it is up would put the page
 * the user asked for behind a meeting they are no longer watching. Going
 * anywhere other than the view the room took over minimises it, which makes
 * every existing way into the app work during a meeting instead of only the
 * Minimise button. See the effect below for what counts as leaving.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isAdhocCall, type CallDTO } from "@taskboard/shared";
import { useRuntime } from "./runtime";

/** Where the meeting tab goes when the room is minimised out of /call/:id. */
const APP_HOME = "/app/meetings";
/** The same, for an ad-hoc call: it is not a meeting, so it is not put in the
 *  Meetings area either. */
const ADHOC_HOME = "/app";

/** Remembers "you were in a meeting" across a reload. See useResumableMeeting. */
const RESUME_KEY = "tb.meeting-resume.v1";
const JOIN_REQUEST_EVENT = "taskboard:join-meeting";
const INCOMING_MEETING_EVENT = "taskboard:incoming-meeting";
const DISMISS_INCOMING_MEETING_EVENT = "taskboard:dismiss-incoming-meeting";

/** Which way to open the local mic/camera the moment a meeting connects — set
 *  by the incoming-meeting popup's Video Call / Voice Call buttons (see
 *  features/IncomingMeetingNotice) so that choice is honoured without asking
 *  again in the pre-join lobby. See CallRoom's `autoJoin` prop. */
export type AutoJoinMedia = "video" | "voice";

/** Ask the global meeting host to open a call's pre-join screen. `media`, when
 *  given, skips the lobby and joins straight in with that camera/mic state. */
export function requestMeetingJoin(callId: string, media?: AutoJoinMedia) {
  window.dispatchEvent(new CustomEvent(JOIN_REQUEST_EVENT, { detail: { callId, media } }));
}

export function onMeetingJoinRequest(listener: (callId: string, media?: AutoJoinMedia) => void) {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<{ callId?: unknown; media?: unknown }>).detail;
    if (typeof detail?.callId !== "string" || !detail.callId) return;
    const media = detail.media === "video" || detail.media === "voice" ? detail.media : undefined;
    listener(detail.callId, media);
  };
  window.addEventListener(JOIN_REQUEST_EVENT, handle);
  return () => window.removeEventListener(JOIN_REQUEST_EVENT, handle);
}

/**
 * Tell the incoming-meeting popup (features/IncomingMeetingNotice) that a call
 * started, is waiting, or is ringing for the current user. A plain window
 * event rather than context, matching requestMeetingJoin above — the socket
 * bridge that raises this (lib/queryBridge) has no reason to sit inside the
 * meeting session's own provider tree.
 */
export function announceIncomingMeeting(callId: string, title: string, adhoc?: AdhocIncoming) {
  window.dispatchEvent(new CustomEvent(INCOMING_MEETING_EVENT, { detail: { callId, title, adhoc } }));
}

/** Present when the announced call is an ad-hoc call (a conference somebody was
 *  added to), which is worded as a call and not as a meeting. `actorName` is who
 *  added them, when the server said. */
export interface AdhocIncoming {
  actorName?: string;
}

export function onIncomingMeetingAnnounced(
  listener: (callId: string, title: string, adhoc?: AdhocIncoming) => void,
) {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<{ callId?: unknown; title?: unknown; adhoc?: unknown }>).detail;
    if (typeof detail?.callId !== "string" || !detail.callId) return;
    const adhoc =
      detail.adhoc && typeof detail.adhoc === "object"
        ? { actorName: typeof (detail.adhoc as AdhocIncoming).actorName === "string" ? (detail.adhoc as AdhocIncoming).actorName : undefined }
        : undefined;
    listener(detail.callId, typeof detail.title === "string" ? detail.title : "", adhoc);
  };
  window.addEventListener(INCOMING_MEETING_EVENT, handle);
  return () => window.removeEventListener(INCOMING_MEETING_EVENT, handle);
}

/**
 * Tell the incoming-meeting popup (features/IncomingMeetingNotice) that a
 * call it may be showing an invite for is no longer incoming — it ended, or
 * was answered on another device/tab/window while the popup was still on
 * screen. A plain window event, same shape as announceIncomingMeeting above,
 * raised by the socket bridge (lib/queryBridge) on CallEnded/
 * CallParticipantAdded. Harmless to raise for a callId nobody is currently
 * showing — the listener only acts when it matches what is on screen.
 */
export function dismissIncomingMeeting(callId: string) {
  window.dispatchEvent(new CustomEvent(DISMISS_INCOMING_MEETING_EVENT, { detail: { callId } }));
}

export function onIncomingMeetingDismissed(listener: (callId: string) => void) {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<{ callId?: unknown }>).detail;
    if (typeof detail?.callId !== "string" || !detail.callId) return;
    listener(detail.callId);
  };
  window.addEventListener(DISMISS_INCOMING_MEETING_EVENT, handle);
  return () => window.removeEventListener(DISMISS_INCOMING_MEETING_EVENT, handle);
}

export interface MeetingSessionApi {
  /** The meeting in progress, or null. */
  call: CallDTO | null;
  /** Running, but out of the way: the floating window instead of the room. */
  minimized: boolean;
  /** Which camera/mic state to auto-apply once `call` connects — the third
   *  argument `enter` was last called with. Consumed once by CallRoom's
   *  `autoJoin` prop; null for every ordinary join (Meetings list, a channel,
   *  the rejoin offer), which keeps the pre-join lobby exactly as it was. */
  autoJoinMedia: AutoJoinMedia | null;
  /**
   * Take over the screen with this meeting.
   *
   * `onExit` is the caller's own idea of where the user should end up when the
   * meeting is over — back to the channel, back to Meetings, or closing the tab
   * — because only the caller knows what it interrupted.
   */
  enter: (call: CallDTO, onExit?: () => void, autoJoinMedia?: AutoJoinMedia) => void;
  /** The meeting is over. Runs the entering caller's `onExit`. */
  exit: () => void;
  minimize: () => void;
  restore: () => void;
}

const Ctx = createContext<MeetingSessionApi | null>(null);

/**
 * The raw context, exported for the one caller that needs to shadow it
 * rather than read it: the dedicated `/call/:callId` tab (routes/CallWindow)
 * renders `CallRoom` itself now instead of asking `MeetingHost` to, and does
 * so wrapped in `<MeetingSessionContext.Provider value={null}>`. `CallRoom`
 * already has a defined "no session" behaviour — see its own `session`
 * comment — built for the standalone dev-preview harness: no Minimise
 * control, no MiniMeeting bubble, the room simply always shows itself. That
 * is exactly right for a tab whose entire purpose IS the meeting; without
 * this, `useMeetingSessionOptional()` would still find the app-wide provider
 * (it wraps the whole router) and offer a Minimise that navigates the tab to
 * /app/meetings — tearing this directly-mounted room down along with the
 * navigation, which `enter()`-based minimising was never meant to do to a
 * room a route owns.
 */
export { Ctx as MeetingSessionContext };

export function MeetingSessionProvider({ children }: { children: ReactNode }) {
  const { config } = useRuntime();
  const [call, setCall] = useState<CallDTO | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [autoJoinMedia, setAutoJoinMedia] = useState<AutoJoinMedia | null>(null);
  const onExitRef = useRef<(() => void) | null>(null);
  const nav = useNavigate();
  const location = useLocation();
  // Read inside minimize() without making it change identity on every route
  // change — a control that is re-created as you navigate is one that loses
  // focus and re-runs effects for no reason.
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  /** The route the full-screen room covers; null when it is not covering one. */
  const anchorRef = useRef<string | null>(null);

  const enter = useCallback(
    (next: CallDTO, onExit?: () => void, media?: AutoJoinMedia) => {
      // Electron: the meeting gets its own OS window instead of taking over
      // this one — see main/meeting-window-manager.ts. Nothing below runs on
      // that platform; there is no overlay to show, minimise or resume here
      // because this window never renders the room at all.
      if (config.openMeetingWindow) {
        config.openMeetingWindow(next.id);
        return;
      }
      onExitRef.current = onExit ?? null;
      setCall(next);
      setMinimized(false);
      setAutoJoinMedia(media ?? null);
      // "You were in a meeting — rejoin?" is a Meetings feature; an ad-hoc call
      // is not one, and a reload ends it for you like any other call.
      if (!isAdhocCall(next)) rememberResumableMeeting(next.id);
    },
    [config],
  );

  const exit = useCallback(() => {
    const onExit = onExitRef.current;
    onExitRef.current = null;
    setCall(null);
    setMinimized(false);
    setAutoJoinMedia(null);
    forgetResumableMeeting();
    onExit?.();
  }, []);

  const callRef = useRef<CallDTO | null>(null);
  callRef.current = call;

  const minimize = useCallback(() => {
    setMinimized(true);
    // /call/:id holds nothing but the meeting, so minimising there has to put
    // something behind the floating window. Anywhere else, the app is already
    // underneath and moving the user would be taking the page they were on.
    if (pathRef.current.startsWith("/call/")) {
      nav(callRef.current && isAdhocCall(callRef.current) ? ADHOC_HOME : APP_HOME);
    }
  }, [nav]);

  const restore = useCallback(() => setMinimized(false), []);

  // ── Going somewhere else puts the meeting away by itself ────────────────────
  //
  // The room is a full-screen overlay above every route, so anything that
  // navigates while it is up — the Join action on a "call has started" toast, a
  // sticky note (BrowserStickies sits above the room), a link in the chat, the
  // back button — used to land the user on a page they could not see, behind a
  // meeting they were no longer looking at. Leaving the view the room took over
  // IS asking for the app back, so the meeting minimises itself and carries on
  // running in the floating window rather than covering the page it was left
  // for.
  //
  // Anchored to the path the room covers, captured on the first render it is
  // full-screen on:
  //   • here rather than in `enter()`, because a caller may navigate and enter
  //     in the same tick and only after the commit is the route the room
  //     actually covers known;
  //   • dropped whenever the room is not full-screen, so restoring re-anchors
  //     to wherever it was restored — otherwise the meeting the user just asked
  //     back would put itself away again immediately;
  //   • PATHNAME only, so moving about inside that view — a panel writing a
  //     query string, a hash — is not leaving it.
  useEffect(() => {
    if (!call || minimized) {
      anchorRef.current = null;
      return;
    }
    if (anchorRef.current === null) {
      anchorRef.current = location.pathname;
      return;
    }
    if (anchorRef.current === location.pathname) return;
    // Through minimize() so there is one way out of the full-screen room, and it
    // is the one the Minimise button uses. It navigates only from /call/:id, and
    // by here the user has already gone somewhere themselves.
    minimize();
  }, [call, minimized, location.pathname, minimize]);

  const value = useMemo<MeetingSessionApi>(
    () => ({ call, minimized, autoJoinMedia, enter, exit, minimize, restore }),
    [call, minimized, autoJoinMedia, enter, exit, minimize, restore],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The meeting session. Throws outside the provider, which is a wiring bug. */
export function useMeetingSession(): MeetingSessionApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMeetingSession must be used inside MeetingSessionProvider");
  return ctx;
}

/**
 * The same session, for components that may render with no meeting in progress
 * and must not care. Returns null outside the provider rather than throwing, so
 * a surface can be dropped anywhere.
 */
export function useMeetingSessionOptional(): MeetingSessionApi | null {
  return useContext(Ctx);
}

// ── Surviving a reload ───────────────────────────────────────────────────────
//
// A refresh tears down the page and with it the room; nothing about that can be
// prevented from JavaScript. What CAN be honest is the offer to go back in: the
// call is still LIVE server-side and the token endpoint re-authorises from the
// database, so rejoining is a real join, not a restored illusion of one.
//
// Per TAB (sessionStorage), because "I was in a meeting" is true of the tab
// that was in it and of no other.

function rememberResumableMeeting(callId: string): void {
  try {
    window.sessionStorage.setItem(RESUME_KEY, callId);
  } catch {
    // No storage: the offer simply is not made. Nothing else changes.
  }
}

function forgetResumableMeeting(): void {
  try {
    window.sessionStorage.removeItem(RESUME_KEY);
  } catch {
    // Unreadable is unwritable; nothing to do.
  }
}

function readResumableMeeting(): string | null {
  try {
    return window.sessionStorage.getItem(RESUME_KEY);
  } catch {
    return null;
  }
}

/**
 * "You were in a meeting" — the id to offer a rejoin for, once.
 *
 * Read on mount and cleared immediately, so declining is remembered and a
 * second reload does not ask again. Returns null when this tab was not in a
 * meeting, which is the overwhelmingly common case.
 */
export function useResumableMeeting(): string | null {
  const [callId] = useState(() => readResumableMeeting());
  useEffect(() => {
    // Cleared whichever way the user answers: the offer is made once.
    if (callId) forgetResumableMeeting();
  }, [callId]);
  return callId;
}
