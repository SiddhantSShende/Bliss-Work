import type { ChannelDTO, ConversationDTO } from '@taskboard/shared';
import { encodeMedia, type MediaItem } from '@taskboard/app/chatEnvelope';
import { channelRowPreview, rowPreview } from '../rowPreview';

const ME = 'me-1';
const PEER = 'peer-1';

const convo = (over: Partial<ConversationDTO> = {}): ConversationDTO =>
  ({
    id: 'c1',
    peerId: PEER,
    peerUsername: 'p.nair',
    peerDisplayName: 'Priya Nair',
    lastMessage: 'Hello there',
    lastMessageAt: '2026-09-29T00:00:00Z',
    lastMessageSender: '',
    lastMessageSenderId: PEER,
    cleared: false,
    unread: 0,
    blockedByMe: false,
    blockedByPeer: false,
    ...over,
  }) as ConversationDTO;

const channel = (over: Partial<ChannelDTO> = {}): ChannelDTO =>
  ({
    id: 'ch1',
    name: 'development',
    memberCount: 12,
    lastMessage: 'Build is ready.',
    lastMessageAt: '2026-09-29T00:00:00Z',
    lastMessageSender: 'Mayank Sharma',
    lastMessageSenderId: PEER,
    cleared: false,
    unread: 0,
    isLocked: false,
    iAmMember: true,
    createdBy: '',
    myRole: 'member',
    ...over,
  }) as ChannelDTO;

describe('ChatsTabView.rowPreview', () => {
  it('shows the raw text of a plain message as-is', () => {
    expect(rowPreview(convo(), ME)).toBe('Hello there');
  });

  it('never shows the raw encoded envelope for an image/file message — the real preview instead', () => {
    const image: MediaItem = { id: 'a1', name: 'sunset.jpg', size: 1024, mime: 'image/jpeg' };
    const body = encodeMedia([image]);
    const preview = rowPreview(convo({ lastMessage: body }), ME);
    expect(preview).toBe('Image sent');
    expect(preview).not.toContain('{');
  });

  it('prefixes the viewer\'s own last message with "You", never the peer\'s', () => {
    expect(rowPreview(convo({ lastMessageSenderId: ME }), ME)).toBe('You: Hello there');
    expect(rowPreview(convo({ lastMessageSenderId: PEER }), ME)).toBe('Hello there');
  });

  it('falls back to "No messages yet" with no history', () => {
    expect(rowPreview(convo({ lastMessage: null }), ME)).toBe('No messages yet');
  });
});

describe('ChannelsTabView.channelRowPreview', () => {
  it('prefixes the real server-resolved sender name — never a raw user id', () => {
    expect(channelRowPreview(channel(), ME)).toBe('Mayank Sharma: Build is ready.');
  });

  it('never shows the raw encoded envelope for a channel image/file message', () => {
    const file: MediaItem = { id: 'a2', name: 'report.pdf', size: 2048, mime: 'application/pdf' };
    const preview = channelRowPreview(channel({ lastMessage: encodeMedia([file]) }), ME);
    expect(preview).toBe('Mayank Sharma: File sent');
    expect(preview).not.toContain('{');
  });

  it('shows the member count, unprefixed, when the channel has no messages yet', () => {
    expect(channelRowPreview(channel({ lastMessage: null, lastMessageSender: '' }), ME)).toBe('12 members');
  });

  it('shows nothing once the channel is cleared', () => {
    expect(channelRowPreview(channel({ cleared: true }), ME)).toBe('');
  });
});
