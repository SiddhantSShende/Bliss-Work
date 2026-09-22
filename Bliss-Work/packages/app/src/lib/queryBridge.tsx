import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  EventType,
  type ServerEvent,
  type CallLifecycle,
  type StickyTaskDTO,
  type ConversationDTO,
  type MessageDTO,
  type ChannelDTO,
  type ChannelMessageDTO,
  type UserDTO,
  type WsEventMeta,
  actionsFor,
} from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { announceIncomingMeeting, dismissIncomingMeeting } from "./MeetingSession";
import i18n from "../i18n";
import {
  createCoalescedInvalidator,
  type CoalescedInvalidator,
} from "./coalesceInvalidations";
import type { PlatformConfig } from "../platform";
import { useSession } from "../store/session";
import { qk } from "./queryKeys";
// Re-exported for back-compat: every existing web import site pulls `qk`
// from here (queryBridge used to define it locally). queryKeys.ts is the
// canonical, platform-neutral source now (apps/mobile imports it directly,
// since it cannot depend on this file's React Router import) — this keeps
// both without migrating every web call site.
export { qk };
import {
  patchInboxOnIgnored,
  patchInboxOnMessage,
  patchOnDismissed,
  patchThreadOnDelivered,
  patchThreadOnMessage,
  patchThreadOnRead,
} from "./inboxPatch";

/** qk: canonical query keys. NOTE: `qk.inbox` stays task-only for back-compat
 *  with sticky-widget code; the unified inbox uses `qk.unifiedInbox`. */


/** "Meeting" for a MEETING/DIRECT call, "Channel call" for a CHANNEL one — the
 *  same fallback CallRoom.tsx uses once you're actually in the room, so the
 *  incoming-meeting popup (announceIncomingMeeting) never shows a blank or
 *  undefined title. */
function meetingTitle(e: { title?: string; kind: "DIRECT" | "CHANNEL" | "MEETING" }): string {
  return e.title || (e.kind === "CHANNEL" ? "Channel call" : "Meeting");
}

/**
 * Connects the WebSocket and maps every inbound ServerEvent to a TanStack Query
 * cache patch so all open screens update live. Also mirrors the actionable task
 * list to the Electron sticky bridge when present.
 */
export function WsEventBridge() {
  const qc = useQueryClient();
  const { ws, config } = useRuntime();
  // Held in a ref, not a dependency: the effect below is deliberately keyed on
  // orgId alone (it opens the socket), and adding navigate would tear the
  // connection down and back up on every navigation.
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;
  // Re-run the connect/subscribe effect when the active org changes (org switch)
  // so the socket reconnects under the new token and re-subscribes for that org.
  const orgId = useSession((s) => s.user?.orgId);

  useEffect(() => {
    // A burst of events touching the same list costs ONE refetch, not one per
    // event. Created per subscription so it is torn down with the socket.
    const invalidate = createCoalescedInvalidator(qc);

    // Electron relays events from the utilityProcess; web opens its own socket.
    const source = config.eventSource;
    if (source) source.connect();
    else void ws.connect();

    const handle = (e: ServerEvent, meta?: WsEventMeta) => {
      const me = useSession.getState().user?.id;
      /**
       * Everything below still patches the caches from a replayed event — the
       * screens must be correct after a reconnect. What must NOT happen is
       * ANNOUNCING it. The gateway replays up to 200 events on every connect,
       * so without this gate each launch, reload, wake-from-sleep and org
       * switch fired the same wall of "New task: …" toasts and re-pinned the
       * same desktop notes, for things the user dealt with days ago.
       */
      const live = !meta?.replayed;
      const ctx: EventHandlerContext = {
        qc,
        invalidate,
        me,
        live,
        config,
        navigate: navRef.current,
      };
      // Pure dispatch: every domain's actual cache-patch/toast/side-effect
      // logic lives in its handler function below (grouped by what the event
      // is ABOUT, not by wire-format similarity), so this switch only routes.
      switch (e.type) {
        case EventType.CallScheduled:
        case EventType.CallParticipantAdded:
        case EventType.CallParticipantLeft:
        case EventType.CallEnded:
        case EventType.CallStarted:
        case EventType.CallWaiting:
        case EventType.CallRing:
        case EventType.CallShareStarted:
        case EventType.CallShareStopped:
          handleCallEvent(e, ctx);
          break;
        case EventType.MessageCreated:
        case EventType.ConversationIgnored:
        case EventType.ConversationBlocked:
        case EventType.ConversationUnblocked:
        case EventType.MessageRead:
        case EventType.MessageDelivered:
        case EventType.MessageDismissed:
        case EventType.MessageDeleted:
        case EventType.MessageReaction:
          handleMessageEvent(e, ctx);
          break;
        case EventType.ChannelMemberJoined:
        case EventType.ChannelMemberRemoved:
        case EventType.ChannelBlocked:
        case EventType.ChannelRoleChanged:
        case EventType.ChannelUnblocked:
        case EventType.ChannelMessageCreated:
        case EventType.ChannelMessageDeleted:
        case EventType.ChannelMessagePinned:
        case EventType.ChannelMessageReaction:
          handleChannelEvent(e, ctx);
          break;
        case EventType.TaskAssigned:
        case EventType.TaskAcknowledged:
        case EventType.TaskCompleted:
        case EventType.TaskIgnored:
        case EventType.TaskLeft:
        case EventType.TaskReviewed:
          handleTaskEvent(e, ctx);
          break;
        case EventType.NotificationCreated:
        case EventType.StickyRefresh:
          handleNotificationEvent(e, ctx);
          break;
        case EventType.MailDelivered:
          handleMailEvent(e, ctx);
          break;
        case EventType.PresenceSnapshot:
        case EventType.PresenceOnline:
        case EventType.PresenceOffline:
          handlePresenceEvent(e, ctx);
          break;
      }
    };

    const off = source ? source.subscribe(handle) : ws.on(handle);

    return () => {
      off();
      // Queued invalidations belong to a subscription that no longer exists.
      invalidate.cancel();
      if (!source) ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  return null;
}

/**
 * Everything a per-domain event handler below needs out of the `handle`
 * closure: the query client, the coalesced invalidator, the caller's own id,
 * whether this event is live vs. a reconnect replay, the platform config
 * (desktop pin bridge), and the router's navigate function.
 */
interface EventHandlerContext {
  qc: ReturnType<typeof useQueryClient>;
  invalidate: CoalescedInvalidator;
  me: string | undefined;
  live: boolean;
  config: PlatformConfig;
  navigate: ReturnType<typeof useNavigate>;
}

// ── Calls ─────────────────────────────────────────────────────────────────
// Notifications only — media rides the SFU, not this socket. All five land
// here for anyone on the roster, INCLUDING a participant in another org who
// joined a meeting by link.
function handleCallEvent(e: CallLifecycle, ctx: EventHandlerContext) {
  const { invalidate, me, live } = ctx;
  switch (e.type) {
    case EventType.CallScheduled:
    case EventType.CallParticipantAdded:
    case EventType.CallParticipantLeft:
    case EventType.CallEnded: {
      // Someone joined, left, or the call finished, so who is Busy just
      // changed.
      //
      // Invalidated rather than patched: the event names one call, and the
      // question is "is this person in ANY live call" — which only the
      // server can answer without the client tracking every call it has
      // ever heard about.
      //
      // CallParticipantLeft is what makes an ordinary leave (one that does
      // NOT end the call) flip promptly here too, instead of waiting on
      // the 20s poll in useOnCall — that poll still runs as a
      // reconciliation fallback (same belt-and-suspenders pattern as
      // presence), it just stops being the only mechanism for this case.
      invalidate(qk.onCall);
      invalidate(qk.calls);
      invalidate(qk.call(e.callId));
      // A call that has ENDED has just moved into the Past list, which is a
      // separate paged read that the ["calls"] prefix deliberately does not
      // reach (see qk.callHistory). Only on the end: scheduling one or
      // adding somebody to one changes nothing about what is already over.
      if (e.type === EventType.CallEnded) invalidate(qk.callHistory);
      if (e.channelId) {
        invalidate(qk.channelCalls(e.channelId));
      }
      // Only announce a scheduling someone ELSE did, and never from the
      // reconnect replay — otherwise every launch re-toasts old meetings.
      if (live && e.type === EventType.CallScheduled && e.actorId !== me) {
        toast(e.title ? `Call scheduled: ${e.title}` : "A call was scheduled");
      }
      // The call this event is about just ended, or gained a new
      // participant — either way, if IncomingMeetingNotice is still
      // showing an invite for it, that invite is stale: the organizer
      // cancelled, or it was answered on another device/tab/window. A
      // no-op if nothing is currently showing this callId — see
      // onIncomingMeetingDismissed. Not gated on `live`: a popup somehow
      // still open across a reconnect is exactly the case worth clearing.
      if (e.type === EventType.CallEnded || e.type === EventType.CallParticipantAdded) {
        dismissIncomingMeeting(e.callId);
      }
      break;
    }
    // The host opened a call. Fanned out to the WHOLE roster on purpose —
    // the people in its waiting room need to come in, and the people who
    // have not opened it yet need to know it is under way. Without this the
    // Meetings list went on showing a live meeting under "Upcoming", and
    // its Join button went on asking the server to START a call that was
    // already running, which comes back 403 for everyone but the organiser.
    case EventType.CallStarted: {
      invalidate(qk.onCall);
      invalidate(qk.calls);
      invalidate(qk.call(e.callId));
      if (e.channelId) {
        invalidate(qk.channelCalls(e.channelId));
      }
      // Worth interrupting for: it is starting NOW, and the popup is the
      // only thing that reaches someone who is not looking at Meetings.
      // Never from the reconnect replay — that would announce a meeting
      // that started (and ended) hours ago.
      if (live && e.actorId !== me) {
        announceIncomingMeeting(e.callId, meetingTitle(e));
      }
      break;
    }
    // Somebody is sitting in the waiting room. Addressed by the server to
    // the people who could let them in and to nobody else, so this needs no
    // recipient check of its own — but it IS pointless replayed, because the
    // wait it describes is long over.
    case EventType.CallWaiting: {
      invalidate(qk.call(e.callId));
      if (live && e.actorId !== me) {
        announceIncomingMeeting(e.callId, meetingTitle(e));
      }
      break;
    }
    case EventType.CallRing: {
      invalidate(qk.calls);
      // A ring is only meaningful live. Replaying it would ring the user
      // for a call that was answered or abandoned hours ago.
      if (live && e.actorId !== me) {
        // With somewhere to go: this is how someone pulled into a call in
        // progress gets there, and "you were added to a call" with no way
        // to join it is a dead end.
        announceIncomingMeeting(e.callId, meetingTitle(e));
      }
      break;
    }
    // The room's record of who is sharing. The picture itself arrives on the
    // media connection; this is what a client reads to know a share is in
    // progress before any track of it turns up.
    //
    // Also invalidates the LIST, not just this one call: a row rendered
    // from qk.calls (the Meetings page) or qk.channelCalls (a channel's
    // call history) would read `activeShares` off its own list-query row,
    // which is not the same cache entry as qk.call. Without this, a share
    // that ended could keep showing as active on any such list-built view —
    // a stale "sharing their screen" that no amount of the room's own
    // cleanup could touch, because it was never where that view was
    // reading from.
    case EventType.CallShareStarted:
    case EventType.CallShareStopped: {
      invalidate(qk.calls);
      invalidate(qk.call(e.callId));
      if (e.channelId) {
        invalidate(qk.channelCalls(e.channelId));
      }
      break;
    }
  }
}

// ── DM messaging ─────────────────────────────────────────────────────────
function handleMessageEvent(e: ServerEvent, ctx: EventHandlerContext) {
  const { qc, invalidate, me } = ctx;
  switch (e.type) {
    case EventType.MessageCreated: {
      // Own messages are rendered optimistically by the open thread, so skip
      // the echo here to avoid a duplicate; still refresh the conversation list.
      if (e.senderId !== me) {
        qc.setQueryData<MessageDTO[]>(qk.messages(e.conversationId), (prev) => {
          const next = prev ? [...prev] : [];
          if (!next.some((m) => m.id === e.messageId))
            next.push({
              id: e.messageId,
              conversationId: e.conversationId,
              seq: e.seq,
              senderId: e.senderId,
              body: e.body,
              kind: e.kind,
              isForward: e.isForward,
              forwardPlatform: e.forwardPlatform,
              createdAt: e.occurredAt,
            });
          return next.sort((a, b) => a.seq - b.seq);
        });
      }
      // Unified Inbox + open thread page-1 patches (Phase 4).
      if (me) {
        patchInboxOnMessage(qc, e, me);
        patchThreadOnMessage(qc, e);
      }
      // Patch the list row's own preview straight from the event — instant,
      // no refetch round-trip — rather than waiting on the coalesced
      // invalidate below. Runs for BOTH a live-received message and the
      // sender's own echo (this event reaches the sender too, per the skip
      // above), so "You: …" appears the moment a send completes.
      qc.setQueryData<ConversationDTO[]>(qk.conversations, (prev) =>
        (prev ?? []).map((c) =>
          c.id !== e.conversationId
            ? c
            : { ...c, lastMessage: e.body, lastMessageAt: e.occurredAt, lastMessageSenderId: e.senderId, cleared: false },
        ),
      );
      // conversation list refreshes (revive + reorder + unread)
      invalidate(qk.conversations);
      invalidate(qk.unreadCounts);
      // People sidebar + open per-person feed (all-feed already patched).
      refreshInboxSidebars(invalidate);
      break;
    }
    case EventType.ConversationIgnored: {
      qc.setQueryData<ConversationDTO[]>(qk.conversations, (prev) =>
        (prev ?? []).filter((c) => c.id !== e.conversationId),
      );
      patchInboxOnIgnored(qc, e);
      refreshInboxSidebars(invalidate);
      break;
    }
    case EventType.ConversationBlocked:
    case EventType.ConversationUnblocked: {
      // Fanned out to BOTH members. Patch the block flags on the affected
      // conversation so the composer banner flips instantly (blocker →
      // blockedByMe, peer → blockedByPeer), then reconcile from the server.
      const blocked = e.type === EventType.ConversationBlocked;
      const actor =
        e.type === EventType.ConversationBlocked ? e.blockedBy : e.unblockedBy;
      if (me) {
        qc.setQueryData<ConversationDTO[]>(qk.conversations, (prev) =>
          (prev ?? []).map((c) =>
            c.id !== e.conversationId
              ? c
              : actor === me
                ? { ...c, blockedByMe: blocked }
                : { ...c, blockedByPeer: blocked },
          ),
        );
      }
      invalidate(qk.conversations);
      invalidate(qk.unreadCounts);
      break;
    }
    case EventType.MessageRead: {
      invalidate(qk.conversations);
      invalidate(qk.unreadCounts);
      if (me) patchThreadOnRead(qc, e, me);
      break;
    }
    case EventType.MessageDelivered: {
      patchThreadOnDelivered(qc, e);
      break;
    }
    case EventType.MessageDismissed: {
      patchOnDismissed(qc, e);
      refreshInboxSidebars(invalidate);
      break;
    }
    case EventType.MessageDeleted: {
      // Swap the bubble for a tombstone in place rather than refetching:
      // the body is already gone server-side, so there is nothing to fetch,
      // and a delete the recipient watches happen is the point.
      qc.setQueryData<MessageDTO[]>(qk.messages(e.conversationId), (prev) =>
        (prev ?? []).map((m) =>
          m.id === e.messageId ? { ...m, body: "", deletedForAll: true } : m,
        ),
      );
      // The thread view paginates, so its cache shape differs — let it refetch.
      if (e.threadId) invalidate(qk.threadMessages(e.threadId));
      refreshInboxSidebars(invalidate);
      break;
    }
    case EventType.MessageReaction: {
      // Refetch rather than patch: the tally is per-viewer (`mine` differs
      // between the parties), so the actor's numbers are not ours. Skip our
      // own echo — the mutation already invalidated on success.
      if (e.actorId !== me) {
        invalidate(qk.reactions(e.conversationId));
      }
      break;
    }
  }
}

// ── Channels (membership + channel messages) ────────────────────────────
function handleChannelEvent(e: ServerEvent, ctx: EventHandlerContext) {
  const { qc, invalidate, me, live, navigate } = ctx;
  switch (e.type) {
    case EventType.ChannelMemberJoined: {
      // Routed to the added user only, so this is always about me — but a
      // replayed event from another session's socket is cheap to guard.
      if (e.userId !== me) break;
      // The channel is new to my sidebar; nothing in cache has it yet.
      invalidate(qk.channels);
      invalidate(qk.unreadCounts);
      // It also just left the "channels I could join" directory.
      invalidate(qk.openChannels);
      // `actorId === userId` is an open-channel self-join: I clicked Join,
      // and announcing my own click back at me is noise. An ABSENT actorId
      // is a server older than the field — stay quiet there too rather than
      // risk telling someone they were added to a channel they joined.
      // The durable copy in the bell is notification-svc's job and applies
      // the same rule; this is only the live toast.
      if (live && e.actorId && e.actorId !== e.userId) {
        toast(e.channelName ? `You were added to #${e.channelName}` : "You were added to a channel");
      }
      break;
    }
    case EventType.ChannelMemberRemoved:
    case EventType.ChannelBlocked: {
      invalidate(qk.channelRoster(e.channelId));
      if (e.userId === me) {
        // It was ME. Drop the channel from my list immediately rather than
        // waiting for a refetch, and if I am standing in it, leave — a
        // channel I can no longer read should not keep rendering as if I
        // could, and the next send would 403 with no explanation.
        qc.setQueryData<ChannelDTO[]>(qk.channels, (prev) =>
          (prev ?? []).filter((c) => c.id !== e.channelId),
        );
        if (live) {
          toast.info(
            e.type === EventType.ChannelBlocked
              ? "You were blocked from a channel"
              : "You were removed from a channel",
          );
        }
        if (window.location.pathname.includes(e.channelId)) {
          navigate("/app/channels");
        }
      }
      invalidate(qk.channels);
      invalidate(qk.unreadCounts);
      invalidate(qk.openChannels);
      break;
    }
    case EventType.ChannelRoleChanged:
    case EventType.ChannelUnblocked: {
      invalidate(qk.channelRoster(e.channelId));
      // myRole rides ChannelDTO, so the channel list has to refetch for the
      // moderation controls to appear or disappear.
      invalidate(qk.channels);
      invalidate(qk.unreadCounts);
      invalidate(qk.openChannels);
      break;
    }
    case EventType.ChannelMessageCreated: {
      // Skip own echo (optimistically rendered by the open channel). For
      // everyone else, patch the message straight into the cache so it
      // appears instantly (no refetch round-trip) — the event already
      // carries every field ChannelMessageDTO needs.
      if (e.senderId !== me) {
        qc.setQueryData<ChannelMessageDTO[]>(qk.channelMessages(e.channelId), (prev) => {
          const next = prev ? [...prev] : [];
          if (!next.some((m) => m.id === e.messageId))
            next.push({
              id: e.messageId,
              channelId: e.channelId,
              seq: e.seq,
              senderId: e.senderId,
              senderUsername: e.senderUsername,
              senderDisplayName: e.senderDisplayName,
              body: e.body,
              kind: e.kind,
              isForward: e.isForward,
              forwardPlatform: e.forwardPlatform,
              replyToId: e.replyToId,
              createdAt: e.occurredAt,
            });
          return next.sort((a, b) => a.seq - b.seq);
        });
      }
      // Patch the channel list row's preview straight from the event —
      // same reason as MessageCreated above: instant "<Name>: …", and it
      // covers the sender's own echo too. senderDisplayName/senderUsername
      // mirrors how the server itself resolves lastMessageSender.
      qc.setQueryData<ChannelDTO[]>(qk.channels, (prev) =>
        (prev ?? []).map((c) =>
          c.id !== e.channelId
            ? c
            : {
                ...c,
                lastMessage: e.body,
                lastMessageAt: e.occurredAt,
                lastMessageSenderId: e.senderId,
                lastMessageSender: e.senderDisplayName || e.senderUsername,
                cleared: false,
              },
        ),
      );
      invalidate(qk.channels);
      invalidate(qk.unreadCounts);
      break;
    }
    case EventType.ChannelMessageDeleted: {
      // Patched, not invalidated. A moderator's delete that members only
      // see after their next refetch is one they may well have
      // screenshotted first; swapping the bubble for a tombstone here makes
      // it immediate. The body is dropped locally too — the server has
      // already stopped sending it, and leaving it in this cache would keep
      // the text on screen until something else evicted it.
      qc.setQueryData<ChannelMessageDTO[]>(qk.channelMessages(e.channelId), (prev) =>
        (prev ?? []).map((m) =>
          m.id === e.messageId ? { ...m, body: "", deletedForAll: true, pinned: false } : m,
        ),
      );
      break;
    }
    case EventType.ChannelMessagePinned: {
      qc.setQueryData<ChannelMessageDTO[]>(qk.channelMessages(e.channelId), (prev) =>
        (prev ?? []).map((m) => (m.id === e.messageId ? { ...m, pinned: e.pinned } : m)),
      );
      break;
    }
    case EventType.ChannelMessageReaction: {
      // Refetch rather than patch: the event carries no counts on purpose
      // (the tally is per-viewer), so there is nothing here to apply. The
      // actor already has the authoritative tally from their own PUT/DELETE
      // response, so skipping their echo avoids a redundant round-trip.
      if (e.actorId !== me) {
        invalidate(qk.channelReactions(e.channelId));
      }
      break;
    }
  }
}

// ── Task lifecycle ───────────────────────────────────────────────────────
function handleTaskEvent(e: ServerEvent, ctx: EventHandlerContext) {
  const { qc, invalidate, me, live, config } = ctx;
  switch (e.type) {
    case EventType.TaskAssigned: {
      if (e.assigneeId === me) {
        invalidate(qk.inbox);
        invalidate(qk.sticky);
        // New TASK row lands in the unified inbox / People sidebar.
        invalidate(qk.unifiedInbox);
        refreshInboxSidebars(invalidate);
        if (live)
          toast(i18n.t("tasks:liveEvents.newTask", { title: e.title }), {
            description: i18n.t("tasks:liveEvents.newTaskFrom", { sender: e.senderUsername }),
          });
      }
      // Availability roster: task.* events reach only the sender + assignee
      // (ws-gateway contract.RecipientsOf), so this invalidation is instant
      // feedback for THOSE TWO only. Every other member of the org converges
      // via the 30s poll in useAvailability — that poll is the actual
      // correctness mechanism. Left unguarded so it stays right if routing
      // ever widens.
      invalidate(qk.availability);
      break;
    }
    case EventType.TaskAcknowledged: {
      if (e.senderId === me && live)
        toast.success(i18n.t("tasks:liveEvents.taskAcknowledgedBy", { assignee: e.assigneeUsername }));
      if (e.assigneeId === me) {
        patchStickyStatus(qc, e.taskId, "ACKNOWLEDGED", e.statusVersion);
        // Auto-pin to the desktop on acknowledge (Electron only; absent on
        // web ⇒ no-op, the task simply lands in the Tasks section). Single
        // chokepoint covering every acknowledge surface (inbox row, task
        // detail, sticky). Locked-until-Complete is enforced by StickyWidget.
        //
        // Gated on `live`: a replayed acknowledge is one the user already
        // dealt with, and re-pinning it made every relaunch repopulate the
        // desktop with notes they had already cleared.
        if (live) autoPinOnAcknowledge(qc, invalidate, config, e.taskId);
        invalidate(qk.unifiedInbox);
        refreshInboxSidebars(invalidate);
      }
      invalidate(qk.sent);
      invalidate(qk.notifications);
      invalidate(qk.notificationsUnreadCount);
      // A status change moves this assignee into or out of the Available
      // roster (see the note on TaskAssigned — push reaches only the two
      // parties; everyone else converges on the poll).
      invalidate(qk.availability);
      break;
    }
    case EventType.TaskCompleted: {
      if (e.senderId === me) {
        if (live) toast.success(i18n.t("tasks:liveEvents.taskCompletedBy", { assignee: e.assigneeUsername }));
        // Sender's inbox row needs to refresh so the row reflects the
        // completion (status badge / hidden state). Without this the
        // allocator only learns via the toast and a stale row stays put.
        invalidate(qk.unifiedInbox);
        refreshInboxSidebars(invalidate);
      }
      if (e.assigneeId === me) {
        clearTaskForMe(qc, invalidate, e.taskId);
        invalidate(qk.unifiedInbox);
        refreshInboxSidebars(invalidate);
      }
      invalidate(qk.sent);
      invalidate(qk.notifications);
      invalidate(qk.notificationsUnreadCount);
      // A status change moves this assignee into or out of the Available
      // roster (see the note on TaskAssigned — push reaches only the two
      // parties; everyone else converges on the poll).
      invalidate(qk.availability);
      break;
    }
    case EventType.TaskIgnored:
    case EventType.TaskLeft: {
      // Allocator gets a live toast + inbox refresh for EVERY outcome (the
      // durable notification arrives separately via NotificationCreated).
      if (e.senderId === me) {
        if (live) {
          const key = e.type === EventType.TaskLeft ? "liveEvents.taskLeftBy" : "liveEvents.taskIgnoredBy";
          toast(i18n.t(`tasks:${key}`, { assignee: e.assigneeUsername }));
        }
        invalidate(qk.unifiedInbox);
        refreshInboxSidebars(invalidate);
      }
      if (e.assigneeId === me) {
        clearTaskForMe(qc, invalidate, e.taskId);
        invalidate(qk.unifiedInbox);
        refreshInboxSidebars(invalidate);
      }
      invalidate(qk.sent);
      invalidate(qk.notifications);
      invalidate(qk.notificationsUnreadCount);
      // A status change moves this assignee into or out of the Available
      // roster (see the note on TaskAssigned — push reaches only the two
      // parties; everyone else converges on the poll).
      invalidate(qk.availability);
      break;
    }
    case EventType.TaskReviewed: {
      // Sender's other devices see the review they left; the assignee sees
      // a review land on their completed task. Refetch the affected surfaces.
      if (e.senderId === me) invalidate(qk.sent);
      if (e.assigneeId === me) {
        invalidate(qk.assigned);
        invalidate(qk.sticky);
        if (live) toast(i18n.t("tasks:liveEvents.taskReviewed", { reviewer: e.reviewerUsername }));
      }
      break;
    }
  }
}

// ── Notifications + desktop-note repair ──────────────────────────────────
function handleNotificationEvent(e: ServerEvent, ctx: EventHandlerContext) {
  const { invalidate, me } = ctx;
  switch (e.type) {
    case EventType.NotificationCreated: {
      if (e.recipientId === me) {
        invalidate(qk.notifications);
        invalidate(qk.notificationsUnreadCount);
      }
      break;
    }
    case EventType.StickyRefresh: {
      // A repair signal from the desktop-note watchdog, not news: the
      // server believes this user has notes they may never have received,
      // usually because a task.assigned frame was lost to a reconnect or
      // to the gateway's replay window expiring.
      //
      // Deliberately NO toast. The user is not being told anything new —
      // the point is that they should already have seen these — so this
      // refetches quietly and lets the notes appear the way they would
      // have in the first place.
      if (e.assigneeId === me) {
        invalidate(qk.sticky);
        invalidate(qk.inbox);
        invalidate(qk.unifiedInbox);
      }
      break;
    }
  }
}

// ── Mail ──────────────────────────────────────────────────────────────────
function handleMailEvent(e: ServerEvent, ctx: EventHandlerContext) {
  const { invalidate, me, live } = ctx;
  switch (e.type) {
    case EventType.MailDelivered: {
      // Signal-only by design: the event carries no subject or body (see
      // MailDelivered in the shared contract), so there is nothing to patch
      // optimistically — the feed is refetched and renders the new row.
      //
      // Routed to the author too, whose Sent copy needs to appear on their
      // other devices, so this fires for mail the user sent themselves.
      // That is why only the toast is gated on not being the sender: the
      // refetch is wanted in both cases.
      invalidate(qk.unifiedInbox);
      invalidate(qk.inboxPeers);
      invalidate(["inboxPeerFeed"]);
      // Never from the reconnect replay — announcing mail that arrived
      // hours ago as if it just landed is worse than not announcing it.
      if (live && e.senderId !== me) toast(i18n.t("mail:liveEvents.newMailInInbox"));
      break;
    }
  }
}

// ── Live presence ─────────────────────────────────────────────────────────
// Patch the `qk.presence` online-set directly so a teammate's avatar flips
// the instant they connect/disconnect, instead of waiting up to 20s for the
// next poll (which remains as a reconciliation fallback).
function handlePresenceEvent(e: ServerEvent, ctx: EventHandlerContext) {
  const { qc } = ctx;
  switch (e.type) {
    case EventType.PresenceSnapshot: {
      qc.setQueryData<string[]>(qk.presence, e.online);
      break;
    }
    case EventType.PresenceOnline: {
      qc.setQueryData<string[]>(qk.presence, (prev) =>
        prev?.includes(e.userId) ? prev : [...(prev ?? []), e.userId],
      );
      break;
    }
    case EventType.PresenceOffline: {
      qc.setQueryData<string[]>(qk.presence, (prev) =>
        (prev ?? []).filter((id) => id !== e.userId),
      );
      break;
    }
  }
}

/**
 * Refresh the inbox People sidebar (`qk.inboxPeers`) and any open per-person
 * feed (`["inboxPeerFeed", …]`). The all-feed (`qk.unifiedInbox`) is patched
 * optimistically by the inboxPatch helpers, so it is intentionally left
 * untouched here for message events; task events invalidate it explicitly at
 * their call sites.
 */
function refreshInboxSidebars(invalidate: CoalescedInvalidator) {
  invalidate(qk.inboxPeers);
  invalidate(["inboxPeerFeed"]);
  invalidate(qk.unreadCounts);
}

/**
 * Auto-pin a just-acknowledged task to the desktop (Electron only). Mirrors the
 * manual pin flow in MailTask: writes the authoritative pinned set back into
 * `qk.taskPins` and surfaces the max-5 limit refusal. No-op on web (config.pinTask
 * absent) and idempotent on redelivered events (already-pinned ⇒ same set).
 */
function autoPinOnAcknowledge(
  qc: ReturnType<typeof useQueryClient>,
  invalidate: CoalescedInvalidator,
  config: PlatformConfig,
  taskId: string,
) {
  if (!config.pinTask) return;
  void config
    .pinTask(taskId)
    .then((res) => {
      qc.setQueryData<string[]>(qk.taskPins, () => res.pinned);
      if (!res.ok && res.reason === "limit") toast(i18n.t("stickies:toasts.desktopFull"));
    })
    .catch(() => invalidate(qk.taskPins));
}

function patchStickyStatus(
  qc: ReturnType<typeof useQueryClient>,
  taskId: string,
  status: StickyTaskDTO["myStatus"],
  version: number,
) {
  for (const key of [qk.sticky, qk.inbox]) {
    qc.setQueryData<StickyTaskDTO[]>(key, (prev) =>
      (prev ?? []).map((t) =>
        t.taskId === taskId && version >= t.statusVersion
          ? { ...t, myStatus: status, actions: actionsFor(status), statusVersion: version }
          : t,
      ),
    );
  }
}

function removeSticky(qc: ReturnType<typeof useQueryClient>, taskId: string) {
  for (const key of [qk.sticky, qk.inbox]) {
    qc.setQueryData<StickyTaskDTO[]>(key, (prev) =>
      (prev ?? []).filter((t) => t.taskId !== taskId),
    );
  }
}

/**
 * A task assigned to me reached a terminal state (completed/left/ignored). Drop
 * it from the sticky/inbox caches and refresh the assigned-tasks bucket so the
 * in-app card clears even when the action happened on another surface (e.g.
 * completing from a different device). Also optimistically drops the id from the
 * desktop pin set — a plain refetch could race (and lose to) the main-process
 * prune, leaving a stale "Pinned" state.
 */
function clearTaskForMe(
  qc: ReturnType<typeof useQueryClient>,
  invalidate: CoalescedInvalidator,
  taskId: string,
) {
  removeSticky(qc, taskId);
  invalidate(qk.assigned);
  qc.setQueryData<string[]>(qk.taskPins, (prev) =>
    prev ? prev.filter((id) => id !== taskId) : prev,
  );
}
