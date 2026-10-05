import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

/**
 * JS side of android/.../IncomingCallModule.kt — the phone-style ring for
 * Android (call-style notification + full-screen intent over the lock screen).
 * It only rings and reports which button was pressed; answering/declining is
 * done by the existing call controllers. Absent on iOS and in any build that
 * predates the module, in which case `native` is undefined and callers fall
 * back to the expo-notifications ring.
 */
export type NativeCallAction = 'accept' | 'decline' | 'open';
export interface NativeCallActionEvent {
  action: NativeCallAction;
  callId: string;
  kind: 'direct' | 'room';
}

interface NativeIncomingCall {
  show(callId: string, name: string, media: string, kind: string, context: string | null): void;
  cancel(callId: string): void;
  canUseFullScreenIntent(): Promise<boolean>;
  openFullScreenIntentSettings(): void;
  releaseLockScreen(): void;
  consumeLaunchAction(): Promise<NativeCallActionEvent | null>;
  startRingtone(): void;
  stopRingtone(): void;
}

const native: NativeIncomingCall | undefined =
  Platform.OS === 'android' ? (NativeModules?.IncomingCall as NativeIncomingCall | undefined) : undefined;
const emitter = native ? new NativeEventEmitter(NativeModules.IncomingCall) : undefined;

export const hasNativeIncomingCall = !!native;

export function nativeShowIncomingCall(c: { callId: string; name: string; media: 'audio' | 'video'; kind: 'direct' | 'room'; context?: string }): boolean {
  if (!native) return false;
  native.show(c.callId, c.name, c.media, c.kind, c.context ?? null);
  return true;
}

export function nativeCancelIncomingCall(callId: string): void {
  native?.cancel(callId);
}

/** Stop showing over the lock screen (no-op unless a call launch turned it on). */
export function releaseLockScreen(): void {
  native?.releaseLockScreen();
}

/** Foreground ring only: `show()`'s own sound is the notification's — which JS
 *  deliberately never posts while the app is active — so this is the ONLY
 *  ring while BlissWork is in the foreground. No-op (false) on iOS / a build
 *  without the native module; callers then have nothing to fall back to for
 *  the foreground case (see notifications.ts). */
export function startNativeRingtone(): boolean {
  if (!native) return false;
  native.startRingtone();
  return true;
}

/** Always safe to call, ringing or not. */
export function stopNativeRingtone(): void {
  native?.stopRingtone();
}

export function canUseFullScreenIntent(): Promise<boolean> {
  return native ? native.canUseFullScreenIntent().catch(() => true) : Promise.resolve(true);
}

export function openFullScreenIntentSettings(): void {
  native?.openFullScreenIntentSettings();
}

/** Answer/Decline/tap on the native ring, including one that arrived before JS
 *  was listening (the app was launched by it). */
export function onNativeCallAction(cb: (e: NativeCallActionEvent) => void): () => void {
  if (!native || !emitter) return () => {};
  const sub = emitter.addListener('incomingCallAction', (e: NativeCallActionEvent) => cb(e));
  void native.consumeLaunchAction().then((e) => {
    if (e) cb(e);
  });
  return () => sub.remove();
}
