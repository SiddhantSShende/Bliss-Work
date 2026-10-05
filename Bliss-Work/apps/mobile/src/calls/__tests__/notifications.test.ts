const mockSetChannel = jest.fn((..._a: unknown[]): Promise<unknown> | undefined => undefined);
const mockSetCategory = jest.fn((..._a: unknown[]) => undefined);
const mockSetHandler = jest.fn((..._a: unknown[]) => undefined);
const mockSchedule = jest.fn(async (..._a: unknown[]) => 'id');

jest.mock('expo-notifications', () => ({
  AndroidImportance: { MAX: 5, DEFAULT: 3 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  AndroidAudioUsage: { NOTIFICATION_COMMUNICATION_REQUEST: 7 },
  AndroidAudioContentType: { SONIFICATION: 4 },
  setNotificationHandler: (...a: unknown[]) => mockSetHandler(...a),
  setNotificationChannelAsync: (...a: unknown[]) => mockSetChannel(...a),
  setNotificationCategoryAsync: (...a: unknown[]) => mockSetCategory(...a),
  scheduleNotificationAsync: (...a: unknown[]) => mockSchedule(...a),
  getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  dismissNotificationAsync: async () => undefined,
}));

jest.mock('react-native', () => ({
  AppState: { currentState: 'background' },
  Platform: { OS: 'android' },
}));

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import { initCallNotifications, showIncomingCallNotification } from '../notifications';

describe('incoming-call notifications', () => {
  it('waits for the channel before posting (no fallback to a silent default channel)', async () => {
    let release!: () => void;
    mockSetChannel.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const posted = showIncomingCallNotification({ callId: 'c1', name: 'Priya', media: 'audio', kind: 'direct' });
    await new Promise((r) => setImmediate(r));
    expect(mockSchedule).not.toHaveBeenCalled();
    release();
    await posted;
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const arg = mockSchedule.mock.calls[0]![0] as { trigger: { channelId: string }; content: { categoryIdentifier: string } };
    expect(arg.trigger).toEqual({ channelId: 'incoming-calls' });
    expect(arg.content.categoryIdentifier).toBe('incoming_call');
    expect(mockSetChannel.mock.calls.find((c) => c[0] === 'incoming-calls')![1]).toMatchObject({ importance: 5 });
  });

  it('sets up once for any number of callers', async () => {
    await Promise.all([initCallNotifications(), initCallNotifications()]);
    expect(mockSetHandler).toHaveBeenCalledTimes(1);
    expect(mockSetCategory).toHaveBeenCalledTimes(1);
  });
});

describe('a failed setup is retried, not remembered', () => {
  it('re-runs after a rejection', async () => {
    jest.resetModules();
    mockSetChannel.mockReset();
    mockSetChannel.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const mod = require('../notifications') as typeof import('../notifications');
    await expect(mod.initCallNotifications()).rejects.toThrow('boom');
    await expect(mod.initCallNotifications()).resolves.toBeUndefined();
  });
});
