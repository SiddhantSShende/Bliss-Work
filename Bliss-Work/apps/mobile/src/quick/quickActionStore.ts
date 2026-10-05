import { useSyncExternalStore } from 'react';
import type { QuickMode } from './quickLinks';

/**
 * Which quick-action flow (if any) is on screen. Lives outside React state so a
 * launcher-shortcut tap can set it from a Linking listener, and so it survives
 * a session expiry: while signed out the app shows login, and once signed in
 * again the same quick flow is still here to resume.
 */
export interface QuickState {
  mode: QuickMode | null;
  /** Launched from a cold start by the shortcut: finishing should return to the launcher. */
  cold: boolean;
}

let state: QuickState = { mode: null, cold: false };
const listeners = new Set<() => void>();

/**
 * Set once true (never back to false) the first time the NORMAL app UI
 * (AppTabs) renders in this JS session — see RootNavigator.tsx. It is the
 * one thing that tells a cold quick-action launch's exit path whether its
 * Android task might now hold real navigation state: if the user has never
 * once seen AppTabs, nothing of value lives there and the task launched
 * purely to host the shortcut can be torn down outright when it closes; if
 * they have, it must be left alone like any other running app task.
 */
let shownNormalApp = false;

function set(next: QuickState) {
  state = next;
  listeners.forEach((l) => l());
}

export const quickActions = {
  get: (): QuickState => state,
  open(mode: QuickMode, cold: boolean): void {
    set({ mode, cold });
  },
  /** Leave the quick flow (back to the normal app, or — for a cold start — the launcher). */
  close(): void {
    set({ mode: null, cold: false });
  },
  /** AppTabs has rendered at least once this session — see `shownNormalApp`. */
  markNormalAppShown(): void {
    shownNormalApp = true;
  },
  hasShownNormalApp(): boolean {
    return shownNormalApp;
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useQuickState(): QuickState {
  return useSyncExternalStore(quickActions.subscribe, quickActions.get, quickActions.get);
}
