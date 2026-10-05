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

import { showTaskAssignedNotification } from '../taskNotifications';

beforeEach(() => {
  mockSchedule.mockClear();
  appState.currentState = 'background';
});

describe('showTaskAssignedNotification', () => {
  it('posts a real "New Task Assigned" notification with the real title and assigner name', async () => {
    await showTaskAssignedNotification({ taskId: 't1', title: 'Fix mobile camera issue', senderName: 'Mayank Sharma' });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const call = mockSchedule.mock.calls[0]![0] as { identifier: string; content: Record<string, unknown> };
    expect(call.content.subtitle).toBe('New Task Assigned');
    expect(call.content.body).toBe('Fix mobile camera issue\nAssigned by: Mayank Sharma');
    expect(call.content.data).toEqual({ type: 'task', taskId: 't1' });
    // Same taskId reuses the same notification identifier — a duplicate WS
    // redelivery replaces it rather than stacking a second one.
    expect(call.identifier).toBe('task-assigned-t1');
  });

  it('says nothing while BlissWork is in the foreground — the task list refreshes live instead', async () => {
    appState.currentState = 'active';
    await showTaskAssignedNotification({ taskId: 't1', title: 'x', senderName: 'y' });
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});
