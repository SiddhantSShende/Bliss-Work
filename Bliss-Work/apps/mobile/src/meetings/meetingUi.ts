import { useSyncExternalStore } from 'react';

/**
 * Where the running meeting is on screen:
 *  - full:      the full-screen meeting (default while a meeting is live);
 *  - minimized: hidden behind the app, with a slim "return to meeting" bar, so
 *               the user can use the rest of BlissWork while the call continues;
 *  - inPip:     the system Picture-in-Picture window (Android) — the meeting is
 *               drawn compact, controls hidden.
 *
 * Module-level on purpose: exactly one meeting can be live, and both the
 * overlay and the native PiP callback need to reach the same state.
 */
export interface MeetingUiState {
  minimized: boolean;
  inPip: boolean;
}

let state: MeetingUiState = { minimized: false, inPip: false };
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export const meetingUi = {
  get: (): MeetingUiState => state,
  subscribe: (l: () => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  minimize: () => {
    if (state.minimized) return;
    state = { ...state, minimized: true };
    emit();
  },
  restore: () => {
    if (!state.minimized) return;
    state = { ...state, minimized: false };
    emit();
  },
  setInPip: (inPip: boolean) => {
    if (state.inPip === inPip) return;
    // Leaving PiP always lands on the full meeting: tapping the PiP window is
    // "return to the meeting".
    state = { minimized: inPip ? state.minimized : false, inPip };
    emit();
  },
  /** The meeting is over: nothing may leak into the next one. */
  reset: () => {
    if (!state.minimized && !state.inPip) return;
    state = { minimized: false, inPip: false };
    emit();
  },
};

export function useMeetingUi(): MeetingUiState {
  return useSyncExternalStore(meetingUi.subscribe, meetingUi.get);
}
