import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

/**
 * Android Picture-in-Picture for a live meeting (native side:
 * android/.../MeetingPipModule.kt). While a meeting is armed, leaving the app
 * shrinks it into the system PiP window and the call keeps its microphone and
 * connection. iOS has no equivalent wired up here, so everything is a no-op.
 */
interface NativePip {
  isSupported(): Promise<boolean>;
  setArmed(on: boolean, w: number, h: number): void;
  enter(): Promise<boolean>;
}

const native: NativePip | undefined = Platform.OS === 'android' ? (NativeModules.MeetingPip as NativePip | undefined) : undefined;
const emitter = native ? new NativeEventEmitter(NativeModules.MeetingPip) : undefined;

export const pip = {
  available: !!native,
  isSupported: async (): Promise<boolean> => (native ? await native.isSupported().catch(() => false) : false),
  /** Arm/disarm auto-PiP. `w:h` is the aspect ratio of the PiP window. */
  setArmed: (on: boolean, w = 9, h = 16): void => {
    try {
      native?.setArmed(on, w, h);
    } catch {
      /* module missing (older binary): PiP is simply unavailable */
    }
  },
  /** Enter PiP now. Resolves false if the device/user does not allow it. */
  enter: async (): Promise<boolean> => (native ? await native.enter().catch(() => false) : false),
  /** PiP window entered/left (`true` = now in PiP). Returns unsubscribe. */
  onChange: (cb: (inPip: boolean) => void): (() => void) => {
    if (!emitter) return () => {};
    const sub = emitter.addListener('meetingPipChanged', (v: unknown) => cb(v === true));
    return () => sub.remove();
  },
};
