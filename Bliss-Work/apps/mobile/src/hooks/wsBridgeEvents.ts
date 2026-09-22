import type { QueryClient } from '@tanstack/react-query';
import { EventType, type ServerEvent } from '@taskboard/shared';
import { qk } from './queryKeys';

/**
 * What each server event does to mobile's query cache. Split out of
 * `useWsBridge` (which owns the socket subscription) so it can be exercised
 * without the React Native runtime that hook pulls in.
 */
export function handleEvent(e: ServerEvent, qc: QueryClient) {
  const invalidate = (key: readonly unknown[]) => void qc.invalidateQueries({ queryKey: key as unknown[] });

  switch (e.type) {
    // Patches the same qk.presence cache usePresence's poll reconciles into —
    // an online/offline edge flips a dot immediately instead of waiting up to
    // 20s for the next poll tick.
    case EventType.PresenceOnline:
      qc.setQueryData<string[]>(qk.presence, (prev) => Array.from(new Set([...(prev ?? []), e.userId])));
      break;
    case EventType.PresenceOffline:
      qc.setQueryData<string[]>(qk.presence, (prev) => (prev ?? []).filter((id) => id !== e.userId));
      break;
    case EventType.PresenceSnapshot:
      qc.setQueryData<string[]>(qk.presence, e.online);
      break;
    case EventType.MessageCreated:
      invalidate(qk.messages(e.conversationId));
      invalidate(qk.conversations);
      break;
    case EventType.MessageRead:
    case EventType.MessageDelivered:
    case EventType.MessageDeleted:
    case EventType.MessageDismissed:
      invalidate(qk.messages(e.conversationId));
      break;
    // Reactions live in their own cache (qk.reactions), not qk.messages — see
    // that key's own doc — so a reaction event only needs to clear this.
    case EventType.MessageReaction:
      invalidate(qk.reactions(e.conversationId));
      break;
    case EventType.ConversationIgnored:
    case EventType.ConversationBlocked:
    case EventType.ConversationUnblocked:
      invalidate(qk.conversations);
      break;
    case EventType.ChannelMessageCreated:
    case EventType.ChannelMessageDeleted:
      invalidate(qk.channelMessages(e.channelId));
      invalidate(qk.channels);
      break;
    case EventType.ChannelMessageReaction:
      invalidate(qk.channelReactions(e.channelId));
      break;
    // Pins ride the messages themselves, so the open channel refetches them.
    case EventType.ChannelMessagePinned:
      invalidate(qk.channelMessages(e.channelId));
      break;
    // Membership and moderation. The channel list carries myRole (which gates the
    // manage/settings controls) and is where an added channel appears or a removed
    // one disappears; the directory of joinable channels changes with it; and the
    // roster screen shows the members and their roles.
    case EventType.ChannelMemberJoined:
      invalidate(qk.channels);
      invalidate(qk.openChannels);
      break;
    case EventType.ChannelMemberRemoved:
    case EventType.ChannelBlocked:
    case EventType.ChannelRoleChanged:
    case EventType.ChannelUnblocked:
      invalidate(qk.channelRoster(e.channelId));
      invalidate(qk.channels);
      invalidate(qk.openChannels);
      break;
    case EventType.NotificationCreated:
      invalidate(qk.notifications);
      break;
    case EventType.TaskAssigned:
      invalidate(qk.tasksAssigned);
      break;
    case EventType.TaskAcknowledged:
    case EventType.TaskCompleted:
    case EventType.TaskIgnored:
    case EventType.TaskLeft:
    case EventType.TaskReviewed:
      invalidate(qk.tasksAssigned);
      invalidate(qk.tasksSent);
      break;
    case EventType.CallScheduled:
    case EventType.CallStarted:
    case EventType.CallParticipantAdded:
    case EventType.CallParticipantLeft:
      invalidate(qk.myCalls);
      break;
    case EventType.CallEnded:
      invalidate(qk.myCalls);
      invalidate(qk.callHistory);
      break;
    case EventType.MailDelivered:
      invalidate(qk.mailInbox);
      break;
    default:
      break;
  }
}
