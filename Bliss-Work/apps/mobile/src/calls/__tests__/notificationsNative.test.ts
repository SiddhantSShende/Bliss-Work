const mockSchedule = jest.fn(async (..._a: unknown[]) => 'id');
const mockNativeShow = jest.fn((..._a: unknown[]) => true);
const mockNativeCancel = jest.fn((..._a: unknown[]) => undefined);
const mockStartRingtone = jest.fn((..._a: unknown[]) => true);
const mockStopRingtone = jest.fn((..._a: unknown[]) => undefined);

jest.mock('expo-notifications', () => ({
  AndroidImportance: { MAX: 5, DEFAULT: 3 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  AndroidAudioUsage: { NOTIFICATION_COMMUNICATION_REQUEST: 7 },
  AndroidAudioContentType: { SONIFICATION: 4 },
  setNotificationHandler: () => undefined,
  setNotificationChannelAsync: async () => undefined,
  setNotificationCategoryAsync: async () => undefined,
  scheduleNotificationAsync: (...a: unknown[]) => mockSchedule(...a),
  getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  dismissNotificationAsync: async () => undefined,
}));

jest.mock('react-native', () => ({
  AppState: { currentState: 'background' },
  Platform: { OS: 'android' },
}));

// The Android native ring is present: it must be the ONLY incoming-call notification.
jest.mock('../incomingCallNative', () => ({
  nativeShowIncomingCall: (...a: unknown[]) => mockNativeShow(...a),
  nativeCancelIncomingCall: (...a: unknown[]) => mockNativeCancel(...a),
  startNativeRingtone: (...a: unknown[]) => mockStartRingtone(...a),
  stopNativeRingtone: (...a: unknown[]) => mockStopRingtone(...a),
  onNativeCallAction: () => () => undefined,
}));

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import { AppState } from 'react-native';
import { dismissIncomingCallNotification, showIncomingCallNotification } from '../notifications';

describe('incoming-call ring with the native Android module', () => {
  it('posts the native ring and NOT a second expo notification', async () => {
    await showIncomingCallNotification({ callId: 'c1', name: 'Mayank', media: 'video', kind: 'direct' });
    expect(mockNativeShow).toHaveBeenCalledWith({ callId: 'c1', name: 'Mayank', media: 'video', kind: 'direct', context: undefined });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('cancels the native ring when the call no longer rings', async () => {
    await dismissIncomingCallNotification('c1');
    expect(mockNativeCancel).toHaveBeenCalledWith('c1');
    expect(mockStopRingtone).toHaveBeenCalled();
  });

  it('foreground: plays the ringtone directly instead of a notification (the in-app ring screen is the UI)', async () => {
    (AppState as { currentState: string }).currentState = 'active';
    try {
      await showIncomingCallNotification({ callId: 'c2', name: 'Priya', media: 'audio', kind: 'direct' });
      expect(mockStartRingtone).toHaveBeenCalled();
      expect(mockNativeShow).not.toHaveBeenCalledWith(expect.objectContaining({ callId: 'c2' }));
      expect(mockSchedule).not.toHaveBeenCalled();
    } finally {
      (AppState as { currentState: string }).currentState = 'background';
    }
  });
});
