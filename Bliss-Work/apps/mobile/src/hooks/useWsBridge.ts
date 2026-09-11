import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { EventType, type ServerEvent } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
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
  const { ws } = useRuntime();
  const qc = useQueryClient();

  useEffect(() => {
    const off = ws.on((e) => handleEvent(e, qc));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);
}

function handleEvent(e: ServerEvent, qc: QueryClient) {
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
