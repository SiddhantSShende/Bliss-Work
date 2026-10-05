import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { EventType, type ChannelDTO, type ConversationDTO, type ServerEvent, type UserDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { onMessageNotificationResponse, showMessageNotification, type IncomingMessage } from '../calls/messageNotifications';
import { onMailNotificationResponse, showMailNotification } from '../calls/mailNotifications';
import { onTaskNotificationResponse, showTaskAssignedNotification } from '../calls/taskNotifications';
import { navigationRef } from '../navigation/navigationRef';
import { qk } from './queryKeys';
import { handleEvent } from './wsBridgeEvents';

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
  const meIdRef = useRef(meId);
  meIdRef.current = meId;

  // The socket is authenticated as ONE org membership, so it follows the active
  // org like web's WsEventBridge: re-dialled under the new token on an org switch,
  // and closed when this unmounts (sign-out). Before, nothing ever closed it —
  // a signed-out user kept showing as Online, and the next user's connect() was a
  // no-op on the previous user's live socket.
  const orgId = useSession((s) => s.user?.orgId);

  useEffect(() => {
    void ws.connect(); // a no-op when useConnectEventBridge already opened it
    // Both handlers live in this one effect so they are (re)registered with every
    // connect/close cycle: `handleEvent` is the shared cache layer (wsBridgeEvents.ts);
    // `handleLocalEvent` is mobile's own layer — OS notifications and call-range refreshes.
    const offCache = ws.on((e) => handleEvent(e, qc));
    const offLocal = ws.on((e) => handleLocalEvent(e, qc, meIdRef.current, api));
    return () => {
      offCache();
      offLocal();
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, orgId]);

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

/**
 * Mobile-only reactions to server events, on top of the shared cache layer in
 * `wsBridgeEvents.ts`: a local OS notification for something that is not ours
 * (a message, a channel message, a task assigned to us, a mail), and refreshing
 * the meetings calendar ranges when a call changes.
 */
function handleLocalEvent(e: ServerEvent, qc: QueryClient, meId: string | undefined, api: ReturnType<typeof useRuntime>['api']) {
  switch (e.type) {
    case EventType.MessageCreated:
      // Not our own message (echoed back to our own other device/session).
      if (e.senderId !== meId) void notifyNewChatMessage(e.conversationId, e.senderId, e.body, qc);
      break;
    case EventType.ChannelMessageCreated:
      if (e.senderId !== meId) void notifyNewChannelMessage(e.channelId, e.senderDisplayName ?? e.senderUsername, e.body, qc);
      break;
    case EventType.TaskAssigned:
      if (e.senderId !== meId) void notifyTaskAssigned(e.taskId, e.title, e.senderId, e.senderUsername, qc);
      break;
    case EventType.CallScheduled:
    case EventType.CallStarted:
    case EventType.CallParticipantAdded:
    case EventType.CallParticipantLeft:
    case EventType.CallEnded:
      void qc.invalidateQueries({ queryKey: qk.callsRangePrefix });
      break;
    case EventType.MailDelivered:
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
