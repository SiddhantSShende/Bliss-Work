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
import type { CallDTO } from "@taskboard/shared";

/** Where the meeting tab goes when the room is minimised out of /call/:id. */
const APP_HOME = "/app/meetings";

/** Remembers "you were in a meeting" across a reload. See useResumableMeeting. */
const RESUME_KEY = "tb.meeting-resume.v1";
const JOIN_REQUEST_EVENT = "taskboard:join-meeting";

/** Ask the global meeting host to open a call's pre-join screen. */
export function requestMeetingJoin(callId: string) {
  window.dispatchEvent(new CustomEvent(JOIN_REQUEST_EVENT, { detail: { callId } }));
}

export function onMeetingJoinRequest(listener: (callId: string) => void) {
  const handle = (event: Event) => {
    const callId = (event as CustomEvent<{ callId?: unknown }>).detail?.callId;
    if (typeof callId === "string" && callId) listener(callId);
  };
  window.addEventListener(JOIN_REQUEST_EVENT, handle);
  return () => window.removeEventListener(JOIN_REQUEST_EVENT, handle);
}

export interface MeetingSessionApi {
  /** The meeting in progress, or null. */
  call: CallDTO | null;
  /** Running, but out of the way: the floating window instead of the room. */
  minimized: boolean;
  /**
   * Take over the screen with this meeting.
   *
   * `onExit` is the caller's own idea of where the user should end up when the
   * meeting is over — back to the channel, back to Meetings, or closing the tab
   * — because only the caller knows what it interrupted.
   */
  enter: (call: CallDTO, onExit?: () => void) => void;
  /** The meeting is over. Runs the entering caller's `onExit`. */
  exit: () => void;
  minimize: () => void;
  restore: () => void;
}

const Ctx = createContext<MeetingSessionApi | null>(null);

export function MeetingSessionProvider({ children }: { children: ReactNode }) {
  const [call, setCall] = useState<CallDTO | null>(null);
  const [minimized, setMinimized] = useState(false);
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

  const enter = useCallback((next: CallDTO, onExit?: () => void) => {
    onExitRef.current = onExit ?? null;
    setCall(next);
    setMinimized(false);
    rememberResumableMeeting(next.id);
  }, []);

  const exit = useCallback(() => {
    const onExit = onExitRef.current;
    onExitRef.current = null;
    setCall(null);
    setMinimized(false);
    forgetResumableMeeting();
    onExit?.();
  }, []);

  const minimize = useCallback(() => {
    setMinimized(true);
    // /call/:id holds nothing but the meeting, so minimising there has to put
    // something behind the floating window. Anywhere else, the app is already
    // underneath and moving the user would be taking the page they were on.
    if (pathRef.current.startsWith("/call/")) nav(APP_HOME);
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
    () => ({ call, minimized, enter, exit, minimize, restore }),
    [call, minimized, enter, exit, minimize, restore],
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
