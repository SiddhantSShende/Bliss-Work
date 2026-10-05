import type { ChannelDTO, ConversationDTO } from '@taskboard/shared';
import { listPreview, withSenderLabel } from '@taskboard/app/chatEnvelope';

/**
 * The Chats/Channels list row preview text. `lastMessage` is the message's
 * RAW body — for a structured message (image/file/location) that is the
 * encoded envelope (a readable prefix + a control character + the JSON
 * itself), so it must go through `listPreview` ("Image sent", "File sent", …)
 * rather than being shown as-is. Plain text keeps reading exactly as before.
 *
 * Kept as its own plain .ts module (not inline in the .tsx screens) so it can
 * be unit-tested: importing a screen component here pulls in react-native and
 * lucide-react-native, which this project's Jest config has no transform for.
 */
export function rowPreview(item: ConversationDTO, meId: string | undefined): string {
  if (!item.lastMessage) return 'No messages yet';
  const isOwn = !!meId && item.lastMessageSenderId === meId;
  return withSenderLabel(listPreview(item.lastMessage, isOwn), isOwn ? 'You' : undefined);
}

/** Same idea for a channel row. No message yet: the member count, unprefixed
 *  (a sender name in front of "24 members" would misread as if someone sent
 *  that). `lastMessageSender` is already a real, server-resolved display
 *  name (ChannelDTO's own doc), never a raw id. */
export function channelRowPreview(channel: ChannelDTO, meId: string | undefined): string {
  if (channel.cleared) return '';
  if (!channel.lastMessage) return `${channel.memberCount} members`;
  const preview = listPreview(channel.lastMessage, !!meId && channel.lastMessageSenderId === meId);
  return channel.lastMessageSender ? `${channel.lastMessageSender}: ${preview}` : preview;
}
