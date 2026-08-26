import { create } from "zustand";

/**
 * Which 1:1 chat or channel is on screen right now, for the ONE consumer that
 * cannot get this from the router: ScreenshotNotice.
 *
 * ── Why this exists instead of reading the URL ──────────────────────────────
 * A channel's id IS in the URL (`/app/channels/:channelId`), but a chat's
 * deliberately is not — see lib/selectedChat's docstring on why a private
 * conversation's UUID must never reach the address bar. ScreenshotNotice is
 * also mounted at the App root, outside <Router> and outside
 * <SelectedChatProvider> (see App.tsx), so it cannot call useLocation() or
 * useSelectedChat() even for the channel half of this. A tiny store that the
 * open view writes into — the same shape useSession already uses for
 * cross-cutting state — sidesteps both problems without moving anything.
 *
 * ── Why a store and not a second event listener ─────────────────────────────
 * Screenshot detection is DONE ELSEWHERE (screenGuard.ts / the desktop main
 * process) and already reports through exactly one listener, in
 * ScreenshotNotice. This module carries no listener of its own — DMView and
 * ChannelView only ever WRITE their own identity on mount and clear it on
 * unmount — so there is nothing here that can double-fire or leak.
 */
export type ActiveThread =
  | { kind: "chat"; conversationId: string; peerId: string; peerName: string }
  | { kind: "channel"; channelId: string };

interface ActiveThreadState {
  thread: ActiveThread | null;
  setActiveThread: (thread: ActiveThread) => void;
  /**
   * Clears only if the caller is still the one who set it — a DMView
   * unmounting AFTER a ChannelView has already taken over must not blank the
   * channel's own registration. Same guard `useChatTyping`-style effects use
   * for "am I still the current owner of this cleanup".
   */
  clearActiveThread: (thread: ActiveThread) => void;
}

export const useActiveThread = create<ActiveThreadState>((set) => ({
  thread: null,
  setActiveThread: (thread) => set({ thread }),
  clearActiveThread: (thread) =>
    set((s) => (s.thread === thread ? { thread: null } : s)),
}));
