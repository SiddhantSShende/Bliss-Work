import type { ChannelDTO, ConversationDTO, NotificationDTO } from "@taskboard/shared";

/**
 * Who a "New message" notification is from, and — for a channel — where.
 *
 * The record carries ids (`conversationId`, `channelId`) and a `text` that the
 * producer built as "<sender>: <body>" / "<sender> in #<channel>: <body>", falling
 * back to "New message: …" / "New message in a channel: …" when it did not know the
 * sender. Names are resolved from the caches the app already holds, by id, before
 * the text is looked at, so no request is made and a rename shows its new name:
 *
 *   DM       sender  ← the conversation's peer (a DM is always from the peer)
 *   channel  channel ← the channel list, by channelId
 *            sender  ← the producer's snapshot in `text` (the record has no sender id)
 *
 * Whatever cannot be resolved is `null`; the caller picks the wording of the fallback.
 */
export interface MessageNotificationLabel {
  sender: string | null;
  channel: string | null;
}

/** The placeholder the producer writes when it does not know the sender. */
const PLACEHOLDER = "New message";

const clean = (value: string | undefined | null): string | null => value?.trim() || null;

function senderFromText(sender: string): string | null {
  const name = sender.trim();
  return name && name !== PLACEHOLDER ? name : null;
}

/** The sender and channel as the producer wrote them into `text`. */
export function parseMessageNotificationText(kind: string, text: string): MessageNotificationLabel {
  if (kind === "CHANNEL_MESSAGE") {
    const marker = text.indexOf(" in #");
    if (marker > 0) {
      const rest = text.slice(marker + 5);
      const end = rest.indexOf(": ");
      return { sender: senderFromText(text.slice(0, marker)), channel: clean(end >= 0 ? rest.slice(0, end) : rest) };
    }
    // The producer did not know the channel's name.
    const unnamed = text.indexOf(" in a channel: ");
    return { sender: unnamed > 0 ? senderFromText(text.slice(0, unnamed)) : null, channel: null };
  }
  const separator = text.indexOf(": ");
  return { sender: separator > 0 ? senderFromText(text.slice(0, separator)) : null, channel: null };
}

export function resolveMessageNotification(
  n: Pick<NotificationDTO, "kind" | "text" | "conversationId" | "channelId">,
  conversations: ConversationDTO[] = [],
  channels: ChannelDTO[] = [],
): MessageNotificationLabel {
  const parsed = parseMessageNotificationText(n.kind, n.text);
  if (n.kind === "CHANNEL_MESSAGE") {
    const channel = channels.find((c) => c.id === n.channelId);
    return { sender: parsed.sender, channel: clean(channel?.name) ?? parsed.channel };
  }
  const peer = conversations.find((c) => c.id === n.conversationId);
  // peerUsername is the handle (the email's local part): a last resort, after the real name.
  return { sender: clean(peer?.peerDisplayName) ?? parsed.sender ?? clean(peer?.peerUsername), channel: null };
}
