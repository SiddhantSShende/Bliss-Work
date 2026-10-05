import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { EventType, type ChannelDTO, type ConversationDTO, type ServerEvent, type UserDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { onMessageNotificationResponse, showMessageNotification, type IncomingMessage } from '../calls/messageNotifications';
import { onMailNotificationResponse, showMailNotification } from '../calls/mailNotifications';
import { onTaskNotificationResponse, showTaskAssignedNotification } from '../calls/taskNotifications';
import { navigationRef } from '../navigation/navigationRef';
import { qk } from './queryKeys';

/**
 * Mobile's own live-update bridge: subscribes to the already-connected `ws`
 * (see `useConnectEventBridge`, called alongside this from `AppTabs`) via a
 * single `ws.on(handler)` — same entry point web's `WsEventBridge` uses — and
 * invalidates the matching query key per event, so screens refetch instead of
 * polling.
 *
 * Deliberately NOT a port of `WsEventBridge` itself
 * (packages/app/src/lib/queryBridge.tsx): that component imports
 * `react-router-dom`'s `useNavigate` at module scope (for call-ring
 * navigation) and reads `window.location`, neither of which exists in React
 * Native. This covers the events mobile's own screens actually render;
 * `WsEventBridge` covers strictly more (full call-lifecycle navigation, the
 * unified inbox) because it backs strictly more surfaces.
 */
export function useWsBridge(): void {
  const { ws, api } = useRuntime();
  const qc = useQueryClient();
  const meId = useSession((s) => s.user?.id);

  useEffect(() => {
    const off = ws.on((e) => handleEvent(e, qc, meId, api));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, meId]);

  // Tapping a message notification — including one that launched the app from
  // a killed state — opens the real conversation/channel it was for. Same
  // dedupe-by-key shape as CallProvider's own notification-response handler.
  useEffect(() => {
    return onMessageNotificationResponse((nav) => {
      if (!navigationRef.isReady()) return;
      if (nav.kind === 'chat') {
        navigationRef.navigate('Chats', { screen: 'ChatConversation', params: { conversationId: nav.conversationId, peerId: nav.peerId, peerName: nav.peerName } });
      } else {
        navigationRef.navigate('Chats', { screen: 'ChannelConversation', params: { channelId: nav.channelId, channelName: nav.channelName } });
      }
    });
  }, []);

  // A tapped mail notification opens that mail inside the app.
  useEffect(() => {
    return onMailNotificationResponse((mailId) => {
      if (!navigationRef.isReady()) return;
      navigationRef.navigate('Chats', { screen: 'MailDetail', params: { mailId } });
    });
  }, []);

  // Same for a tapped task notification: the real TaskDetail, real taskId.
  useEffect(() => {
    return onTaskNotificationResponse((taskId) => {
      if (!navigationRef.isReady()) return;
      navigationRef.navigate('Tasks', { screen: 'TaskDetail', params: { taskId } });
    });
  }, []);
}

function handleEvent(e: ServerEvent, qc: QueryClient, meId: string | undefined, api: ReturnType<typeof useRuntime>['api']) {
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
      // Not our own message (echoed back to our own other device/session).
      if (e.senderId !== meId) void notifyNewChatMessage(e.conversationId, e.senderId, e.body, qc);
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
      invalidate(qk.channelMessages(e.channelId));
      invalidate(qk.channels);
      if (e.senderId !== meId) void notifyNewChannelMessage(e.channelId, e.senderDisplayName ?? e.senderUsername, e.body, qc);
      break;
    case EventType.ChannelMessageDeleted:
      invalidate(qk.channelMessages(e.channelId));
      invalidate(qk.channels);
      break;
    case EventType.ChannelMessageReaction:
      invalidate(qk.channelReactions(e.channelId));
      break;
    case EventType.NotificationCreated:
      invalidate(qk.notifications);
      break;
    case EventType.TaskAssigned:
      invalidate(qk.tasksAssigned);
      if (e.senderId !== meId) void notifyTaskAssigned(e.taskId, e.title, e.senderId, e.senderUsername, qc);
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
      invalidate(qk.callsRangePrefix);
      break;
    case EventType.CallEnded:
      invalidate(qk.myCalls);
      invalidate(qk.callHistory);
      invalidate(qk.callsRangePrefix);
      break;
    case EventType.MailDelivered:
      invalidate(qk.mailInbox);
      if (e.senderId !== meId) {
        void api
          .mail(e.mailId)
          .then((m) =>
            showMailNotification({
              mailId: e.mailId,
              from: m.fromName || m.fromAddress,
              subject: m.subject,
              preview: m.bodyText.trim().slice(0, 120),
            }),
          )
          .catch(() => undefined);
      }
      break;
    default:
      break;
  }
}

/** Real sender name + real peer id, from the conversations list already in
 *  cache (it is what the Chats list itself renders from) — never hardcoded,
 *  and no extra request: MessageCreated does not carry the sender's display
 *  name, but the conversation row does. Silently skipped if that row hasn't
 *  synced yet (a first-ever message from a brand-new conversation, still
 *  racing the invalidate above) — same "best effort" the meeting reminders
 *  already accept for a stale local cache. */
function notifyNewChatMessage(conversationId: string, senderId: string, body: string, qc: QueryClient): Promise<void> | void {
  const convo = qc.getQueryData<ConversationDTO[]>(qk.conversations)?.find((c) => c.id === conversationId);
  if (!convo) return;
  const peerName = convo.peerDisplayName ?? convo.peerUsername;
  const nav: IncomingMessage['nav'] = { kind: 'chat', conversationId, peerId: senderId, peerName };
  return showMessageNotification({ ref: { kind: 'chat', id: conversationId }, senderName: peerName, body, nav });
}

/** ChannelMessageCreated already carries the sender's name; only the channel's
 *  own name needs resolving, from the channels list already in cache. */
function notifyNewChannelMessage(channelId: string, senderName: string, body: string, qc: QueryClient): Promise<void> | void {
  const channel = qc.getQueryData<ChannelDTO[]>(qk.channels)?.find((c) => c.id === channelId);
  if (!channel) return;
  const nav: IncomingMessage['nav'] = { kind: 'channel', channelId, channelName: channel.name };
  return showMessageNotification({ ref: { kind: 'channel', id: channelId }, senderName, body, channelName: channel.name, nav });
}

/** TaskAssigned only carries the assigner's username (the email local-part —
 *  see ConversationDTO.peerUsername's own doc for why that isn't shown as a
 *  name); the directory cache has their real display name, same lookup
 *  CallProvider's own `cachedName` already uses. Falls back to the username
 *  rather than skipping the notification outright — unlike a chat message,
 *  a task assignment is worth surfacing even if the assigner's name hasn't
 *  synced to this device's directory cache yet. */
function notifyTaskAssigned(taskId: string, title: string, senderId: string, senderUsername: string, qc: QueryClient): Promise<void> {
  const senderName = qc.getQueryData<UserDTO[]>(qk.directory)?.find((u) => u.id === senderId)?.displayName ?? senderUsername;
  return showTaskAssignedNotification({ taskId, title, senderName });
}
