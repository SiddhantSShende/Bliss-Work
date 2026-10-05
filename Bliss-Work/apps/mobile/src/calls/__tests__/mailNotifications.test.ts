const mockSchedule = jest.fn(async (..._a: unknown[]) => 'id');

jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: async () => undefined,
  setNotificationCategoryAsync: async () => undefined,
  scheduleNotificationAsync: (...a: unknown[]) => mockSchedule(...a),
  addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
  getLastNotificationResponseAsync: async () => null,
}));

const appState = { currentState: 'background' as string };
jest.mock('react-native', () => ({
  AppState: appState,
  Platform: { OS: 'android' },
}));

import { showMailNotification } from '../mailNotifications';

beforeEach(() => {
  mockSchedule.mockClear();
  appState.currentState = 'background';
});

describe('showMailNotification', () => {
  it('posts a real "New Mail" notification with the real sender, subject and preview', async () => {
    await showMailNotification({ mailId: 'm1', from: 'Rahul Sharma', subject: 'APK review', preview: 'Please check the latest APK.' });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const call = mockSchedule.mock.calls[0]![0] as { identifier: string; content: Record<string, unknown> };
    expect(call.content.subtitle).toBe('New Mail');
    expect(call.content.body).toBe('Rahul Sharma\nAPK review — Please check the latest APK.');
    expect(call.content.data).toEqual({ type: 'mail', mailId: 'm1' });
    // Same mailId reuses the same notification identifier — a duplicate WS
    // redelivery replaces it rather than stacking a second one.
    expect(call.identifier).toBe('mail-m1');
  });

  it('omits the preview cleanly when there is none, rather than a trailing dash', async () => {
    await showMailNotification({ mailId: 'm2', from: 'Priya Singh', subject: '(no subject)' });
    const call = mockSchedule.mock.calls[0]![0] as { content: Record<string, unknown> };
    expect(call.content.body).toBe('Priya Singh\n(no subject)');
  });

  it('says nothing while BlissWork is in the foreground — the inbox refreshes live instead', async () => {
    appState.currentState = 'active';
    await showMailNotification({ mailId: 'm1', from: 'x', subject: 'y' });
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});
