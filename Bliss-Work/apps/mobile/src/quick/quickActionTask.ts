import { NativeModules, Platform } from 'react-native';

interface NativeQuickActionTask {
  finishAndRemoveTask(): Promise<boolean>;
}

const native: NativeQuickActionTask | undefined =
  Platform.OS === 'android' ? (NativeModules?.QuickActionTask as NativeQuickActionTask | undefined) : undefined;

/**
 * JS side of android/.../QuickActionTaskModule.kt. Android-only: iOS launcher
 * quick actions never create a separate task/Activity in the first place, so
 * there is nothing here for them to clean up.
 *
 * Fire-and-forget by design — the caller (QuickActionHost) is unmounting
 * either way, and the native side runs on the UI thread regardless. Returns
 * whether this build/platform can do it at all, so the caller knows whether
 * to fall back to its old exit behaviour instead of waiting on the promise.
 */
export function finishAndRemoveQuickActionTask(): boolean {
  if (!native) return false;
  native.finishAndRemoveTask().catch(() => undefined);
  return true;
}
