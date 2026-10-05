import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { useSyncExternalStore } from 'react';

/**
 * App-wide screenshot/screen-recording protection (native side:
 * android/.../ScreenSecurityModule.kt), plus tracking of which chat/channel is
 * on screen so an actual attempt reports into the right conversation.
 *
 *  - Blocking: `FLAG_SECURE` on the Activity window, set once at MainActivity
 *    startup (see its own onCreate) — every screen is protected by default,
 *    not just chats/channels, and not dependent on any React screen
 *    remembering to call in. `screenSecurity.setProtected` exists only for the
 *    one legitimate exception: lifting it for the duration of a live "share my
 *    screen" in a meeting (see roomController.ts) — FLAG_SECURE blocks
 *    MediaProjection capture of this window regardless of who's capturing it,
 *    including the app's own screen-share feature, so protected-by-default and
 *    "can share your own screen" cannot both hold at the same instant.
 *  - `protectThread(thread)` no longer toggles FLAG_SECURE (protection is
 *    already on everywhere) — it only records which conversation is the
 *    active target for `ScreenSecurityHost`'s attempt report, exactly as
 *    before for that part.
 *  - `ScreenSecurityHost` listens for the OS's screenshot callback and reports
 *    it against the thread registered HERE (never a stale closure) — and, since
 *    the callback now fires on every screen, only actually sends a report when
 *    a thread is registered (chat/channel on screen), same as before.
 *
 * Desktop protects unconditionally and there is no server-side toggle for it
 * (see packages/app/src/features/ScreenshotNotice.tsx), so neither is there one
 * here. iOS exposes no equivalent switch, so everything is a no-op there.
 */
export type SecureThread =
  | { kind: 'chat'; conversationId: string; peerId: string }
  | { kind: 'channel'; channelId: string };

interface NativeScreenSecurity {
  setProtected(on: boolean): void;
  isDetectionSupported(): Promise<boolean>;
}

const native: NativeScreenSecurity | undefined =
  Platform.OS === 'android' ? (NativeModules.ScreenSecurity as NativeScreenSecurity | undefined) : undefined;
const emitter = native ? new NativeEventEmitter(NativeModules.ScreenSecurity) : undefined;

let active: SecureThread | null = null;
const listeners = new Set<() => void>();

/** Mark `thread` as the one to report a screenshot attempt against. Returns the matching release. */
export function protectThread(thread: SecureThread): () => void {
  active = thread;
  listeners.forEach((l) => l());
  return () => {
    // Only release if a newer screen has not already taken over.
    if (active === thread) {
      active = null;
      listeners.forEach((l) => l());
    }
  };
}

export const activeSecureThread = (): SecureThread | null => active;

export const screenSecurity = {
  available: !!native,
  /**
   * The app-wide FLAG_SECURE toggle. MainActivity already turns this on at
   * startup — the only caller besides that is roomController's screen-share
   * start/stop, to lift protection for exactly the window a live share needs
   * it lifted. Anything else calling this would reopen the gap MainActivity's
   * default exists to close, so nothing else should.
   */
  setProtected(on: boolean): void {
    try {
      native?.setProtected(on);
    } catch {
      /* module missing (older binary): nothing to protect with */
    }
  },
  /** Android 14+ only; earlier versions still block, but cannot report attempts. */
  isDetectionSupported: async (): Promise<boolean> => (native ? await native.isDetectionSupported().catch(() => false) : false),
  onAttempt: (cb: () => void): (() => void) => {
    if (!emitter) return () => {};
    const sub = emitter.addListener('screenshotAttempt', cb);
    return () => sub.remove();
  },
};

export function useSecureThread(): SecureThread | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => active,
  );
}
