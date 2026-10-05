/**
 * Mobile's screens render a channel's membership, the viewer's role in it
 * (myRole on the channel list), its roster and its pinned messages — but the
 * bridge only reacted to messages and reactions. Being added to, removed from,
 * blocked in or promoted within a channel, or a message being pinned, left the
 * screens on stale data until something else happened to refetch.
 *
 * Uses a real QueryClient and only jest/vitest globals (no imports of either), so
 * it reads the same under both runners. It checks which caches an event marks
 * stale; nothing is fetched because no query here has an observer.
 */
import { QueryClient } from '@tanstack/react-query';
import { EventType, type ServerEvent } from '@taskboard/shared';
import { qk } from './queryKeys';
import { handleEvent } from './wsBridgeEvents';

const CHANNEL = '11111111-1111-4111-8111-111111111111';
const OTHER_CHANNEL = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const event = (type: string) => ({ type, channelId: CHANNEL, userId: USER, messageId: 'm1', pinned: true }) as unknown as ServerEvent;

/** Seeds every channel-related cache, fires the event, and returns which ones went stale. */
function staleAfter(type: string): string[] {
  const qc = new QueryClient();
  const keys: Record<string, readonly unknown[]> = {
    channels: qk.channels,
    openChannels: qk.openChannels,
    roster: qk.channelRoster(CHANNEL),
    messages: qk.channelMessages(CHANNEL),
    otherRoster: qk.channelRoster(OTHER_CHANNEL),
    otherMessages: qk.channelMessages(OTHER_CHANNEL),
  };
  for (const key of Object.values(keys)) qc.setQueryData(key, []);

  handleEvent(event(type), qc);

  return Object.entries(keys)
    .filter(([, key]) => qc.getQueryState(key)?.isInvalidated)
    .map(([name]) => name)
    .sort();
}

describe('handleEvent: channel membership and moderation', () => {
  it('refreshes the channel list when I am added to a channel', () => {
    expect(staleAfter(EventType.ChannelMemberJoined)).toEqual(['channels', 'openChannels']);
  });

  it.each([EventType.ChannelMemberRemoved, EventType.ChannelBlocked])(
    'refreshes that channel roster and the lists when %s',
    (type) => {
      expect(staleAfter(type)).toEqual(['channels', 'openChannels', 'roster']);
    },
  );

  it.each([EventType.ChannelRoleChanged, EventType.ChannelUnblocked])(
    'refreshes that channel roster and the lists (myRole rides the channel) when %s',
    (type) => {
      expect(staleAfter(type)).toEqual(['channels', 'openChannels', 'roster']);
    },
  );

  it('refreshes only that channel messages when a message is pinned', () => {
    expect(staleAfter(EventType.ChannelMessagePinned)).toEqual(['messages']);
  });

  it('never touches another channel', () => {
    for (const type of [
      EventType.ChannelMemberJoined,
      EventType.ChannelMemberRemoved,
      EventType.ChannelBlocked,
      EventType.ChannelRoleChanged,
      EventType.ChannelUnblocked,
      EventType.ChannelMessagePinned,
    ]) {
      const stale = staleAfter(type);
      expect(stale).not.toContain('otherRoster');
      expect(stale).not.toContain('otherMessages');
    }
  });
});

describe('handleEvent: what already worked still does', () => {
  it('refreshes messages and the list for a new channel message', () => {
    expect(staleAfter(EventType.ChannelMessageCreated)).toEqual(['channels', 'messages']);
  });
});
