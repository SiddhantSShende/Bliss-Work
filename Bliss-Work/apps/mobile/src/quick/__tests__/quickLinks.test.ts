import { quickModeFromActionId, quickModeFromUrl, shouldProcessForegroundLaunchUrl } from '../quickLinks';
import { quickActions } from '../quickActionStore';

describe('quickModeFromUrl', () => {
  it('maps the three launcher shortcut links', () => {
    expect(quickModeFromUrl('blisswork://quick/chat')).toBe('chat');
    expect(quickModeFromUrl('blisswork://quick/channel')).toBe('channel');
    expect(quickModeFromUrl('blisswork://quick/task')).toBe('task');
  });
  it('tolerates a trailing slash, query, hash and case', () => {
    expect(quickModeFromUrl('blisswork://quick/task/')).toBe('task');
    expect(quickModeFromUrl('BlissWork://Quick/Chat?x=1')).toBe('chat');
    expect(quickModeFromUrl('blisswork://quick/channel#a')).toBe('channel');
  });
  it('ignores everything else, including the normal deep links', () => {
    for (const u of ['blisswork://chats', 'blisswork://quick', 'blisswork://quick/other', 'https://x.com/quick/chat', '', null, undefined]) {
      expect(quickModeFromUrl(u as string)).toBeNull();
    }
  });
});

describe('shouldProcessForegroundLaunchUrl', () => {
  it('does not replay the cached cold-start URL on foreground', () => {
    expect(shouldProcessForegroundLaunchUrl('blisswork://quick/chat', 'blisswork://quick/chat')).toBe(false);
  });

  it('processes a newly delivered launch URL if the activity was recreated without a url event', () => {
    expect(shouldProcessForegroundLaunchUrl('blisswork://quick/task', 'blisswork://quick/chat')).toBe(true);
  });

  it('ignores a missing URL', () => {
    expect(shouldProcessForegroundLaunchUrl(null, 'blisswork://quick/chat')).toBe(false);
  });
});

describe('quickModeFromActionId', () => {
  it('maps the iOS/native action ids', () => {
    expect(quickModeFromActionId('chats')).toBe('chat');
    expect(quickModeFromActionId('blisswork_channels')).toBe('channel');
    expect(quickModeFromActionId('assign-task')).toBe('task');
    expect(quickModeFromActionId('nope')).toBeNull();
  });
});

describe('quickActions store', () => {
  it('opens, notifies, and closes', () => {
    const seen: (string | null)[] = [];
    const off = quickActions.subscribe(() => seen.push(quickActions.get().mode));
    quickActions.open('task', true);
    expect(quickActions.get()).toEqual({ mode: 'task', cold: true });
    quickActions.close();
    expect(quickActions.get()).toEqual({ mode: null, cold: false });
    expect(seen).toEqual(['task', null]);
    off();
  });

  it('marks the normal app as shown once, and never forgets it', () => {
    // A fresh module instance per test file run — but this store is a
    // process-lifetime singleton by design (see its own doc comment), so
    // assert the one-way latch behaviour rather than an initial value.
    expect(quickActions.hasShownNormalApp()).toBe(false);
    quickActions.markNormalAppShown();
    expect(quickActions.hasShownNormalApp()).toBe(true);
    quickActions.open('chat', true);
    quickActions.close();
    expect(quickActions.hasShownNormalApp()).toBe(true);
  });
});
