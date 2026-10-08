const mockSchedule = jest.fn(async (..._a: unknown[]) => 'id');
const mockGetItem = jest.fn(async (_key: string) => null as string | null);

jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  setNotificationChannelAsync: async () => undefined,
  setNotificationCategoryAsync: async () => undefined,
  scheduleNotificationAsync: (...a: unknown[]) => mockSchedule(...a),
  addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
  getLastNotificationResponseAsync: async () => null,
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: (...a: [string]) => mockGetItem(...a), setItem: async () => undefined },
}));

const appState = { currentState: 'active' as string };
jest.mock('react-native', () => ({
  AppState: appState,
  Platform: { OS: 'android' },
}));

import { encodeMedia, type MediaItem } from '@taskboard/app/chatEnvelope';
import {
  clearThreadFocused,
  setThreadFocused,
  showMessageNotification,
  type IncomingMessage,
} from '../messageNotifications';

const chatMsg: IncomingMessage = {
  ref: { kind: 'chat', id: 'c1' },
  senderName: 'Priya Singh',
  body: 'Can you share the Figma link?',
  nav: { kind: 'chat', conversationId: 'c1', peerId: 'u2', peerName: 'Priya Singh' },
};

beforeEach(() => {
  mockSchedule.mockClear();
  mockGetItem.mockReset();
  mockGetItem.mockResolvedValue(null);
  appState.currentState = 'active';
});

describe('showMessageNotification', () => {
  it('posts a notification with the real sender name and message text — never hardcoded', async () => {
    await showMessageNotification(chatMsg);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const content = (mockSchedule.mock.calls[0]![0] as { content: Record<string, unknown> }).content;
    expect(content.title).toBe('BlissWork');
    expect(content.body).toBe('Priya Singh: Can you share the Figma link?');
    expect(content.data).toEqual({ type: 'message', nav: chatMsg.nav });
  });

  it('a channel message is prefixed with "#channelName"', async () => {
    await showMessageNotification({
      ref: { kind: 'channel', id: 'ch1' },
      senderName: 'Mayank Sharma',
      body: 'Build is ready.',
      channelName: 'development',
      nav: { kind: 'channel', channelId: 'ch1', channelName: 'development' },
    });
    const content = (mockSchedule.mock.calls[0]![0] as { content: Record<string, unknown> }).content;
    expect(content.subtitle).toBe('#development');
    expect(content.body).toBe('Mayank Sharma: Build is ready.');
  });

  it('an image message never shows the raw encoded body (readable prefix + JSON) — real "Image sent" preview instead', async () => {
    const image: MediaItem = { id: 'a1', name: 'sunset.jpg', size: 204_800, mime: 'image/jpeg' };
    const body = encodeMedia([image]);
    expect(body).toContain('{'); // sanity: this really is the raw encoded envelope, not plain text
    await showMessageNotification({ ...chatMsg, body });
    const content = (mockSchedule.mock.calls[0]![0] as { content: Record<string, unknown> }).content;
    expect(content.body).toBe('Priya Singh: Image sent');
    expect(content.body).not.toContain('{');
    expect(content.body).not.toContain('"mime"');
  });

  it('a file message reads "File sent", never the raw JSON', async () => {
    const file: MediaItem = { id: 'a2', name: 'report.pdf', size: 51_200, mime: 'application/pdf' };
    await showMessageNotification({ ...chatMsg, body: encodeMedia([file]) });
    const content = (mockSchedule.mock.calls[0]![0] as { content: Record<string, unknown> }).content;
    expect(content.body).toBe('Priya Singh: File sent');
  });

  it('says nothing while the user is already looking at that exact conversation', async () => {
    setThreadFocused({ kind: 'chat', id: 'c1' });
    try {
      await showMessageNotification(chatMsg);
      expect(mockSchedule).not.toHaveBeenCalled();
    } finally {
      clearThreadFocused({ kind: 'chat', id: 'c1' });
    }
  });

  it('still notifies for that conversation while the user is on a different screen', async () => {
    setThreadFocused({ kind: 'chat', id: 'SOME-OTHER-CONVERSATION' });
    try {
      await showMessageNotification(chatMsg);
      expect(mockSchedule).toHaveBeenCalledTimes(1);
    } finally {
      clearThreadFocused({ kind: 'chat', id: 'SOME-OTHER-CONVERSATION' });
    }
  });

  it('still notifies for the focused screen once the app is backgrounded', async () => {
    setThreadFocused({ kind: 'chat', id: 'c1' });
    appState.currentState = 'background';
    try {
      await showMessageNotification(chatMsg);
      expect(mockSchedule).toHaveBeenCalledTimes(1);
    } finally {
      clearThreadFocused({ kind: 'chat', id: 'c1' });
    }
  });

  it('does not notify for a conversation muted in persisted device preferences', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify(['c1']));
    await showMessageNotification(chatMsg);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('still notifies when a different conversation is muted', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify(['another-conversation']));
    await showMessageNotification(chatMsg);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });
});
