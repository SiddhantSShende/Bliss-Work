import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  EventType,
  type ServerEvent,
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
import { requestMeetingJoin } from "./MeetingSession";
import {
  createCoalescedInvalidator,
  type CoalescedInvalidator,
} from "./coalesceInvalidations";
import type { PlatformConfig } from "../platform";
import { useSession } from "../store/session";
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
export const qk = {
  conversations: ["conversations"] as const,
  messages: (id: string) => ["messages", id] as const,
  /** Reaction tallies for a conversation. Kept OFF the message list: the tally
   *  is per-viewer and changes far more often than the messages do, so folding
   *  it in would invalidate the whole thread on every tap. */
  reactions: (id: string) => ["reactions", id] as const,
  inbox: ["tasks", "inbox"] as const,
  sent: ["tasks", "sent"] as const,
  sticky: ["tasks", "sticky"] as const,
  assigned: ["tasks", "assigned"] as const,
  /** Inputs for the "Available" bucket (open-task counts + admin-hidden set).
   *  POLLED, not pushed — see the note in useAvailability. */
  availability: ["tasks", "availability"] as const,
  /** Calls the caller is expected at, including cross-org meetings. */
  calls: ["calls"] as const,
  call: (id: string) => ["calls", id] as const,
  /** The signed playback link for one call's recording. Its own key, not part
   *  of the call, because the link EXPIRES and is refetched on a timer while
   *  the call row itself does not change. */
  callRecording: (callId: string) => ["calls", callId, "recording"] as const,
  /** Calls scheduled or live in one channel. */
  channelCalls: (channelId: string) => ["channelCalls", channelId] as const,
  directory: ["directory"] as const,
  /** Specific people, resolved by id through the GraphQL gateway. Deliberately
   *  NOT under ["directory"]: that key holds "everyone in the org" and a
   *  partial result written there would be read as the whole directory by the
   *  pickers and mention lists that share it. */
  usersByIds: (ids: readonly string[]) => ["usersByIds", ids.join(",")] as const,
  /** Admin roster: every membership INCLUDING suspended/removed ones. Kept off
   *  the ["directory"] key so the admin screen's inactive rows can never leak
   *  into the pickers and mention lists that read the plain directory. */
  members: ["members"] as const,
  /** The org's tamper-evident audit trail. `targetId` scopes it to one member's
   *  Security tab; the bare prefix is the org-wide log. */
  audit: (targetId?: string) => ["audit", targetId ?? "all"] as const,
  // ── Member activity record (telemetry-svc) ───────────────────────────────
  // `userId` is part of every key, and "me" is a valid value the server
  // resolves to the caller — so a member's own view and an admin's view of
  // that member never share a cache entry, and the two can never bleed.
  activityRoster: ["activity", "roster"] as const,
  activityTimeline: (userId: string) => ["activity", "timeline", userId] as const,
  activitySessions: (userId: string) => ["activity", "sessions", userId] as const,
  /** The CORRELATED desktop+browser records (activity_sessions), distinct
   *  from `activitySessions` above (user_sessions — login presence). See
   *  ActivitySessionDTO's doc comment in packages/shared for the naming
   *  collision this key name is deliberately distinct from. */
  activitySessionEntries: (userId: string) => ["activity", "session-entries", userId] as const,
  activitySummary: (userId: string, from: string, to: string) =>
    ["activity", "summary", userId, from, to] as const,
  orgActivitySummary: (from: string, to: string) =>
    ["activity", "org", from, to] as const,
  /** This person's paired agents (desktop app / browser extension). */
  agentTokens: ["activity", "agents"] as const,
  invites: ["invites"] as const,
  presence: ["presence"] as const,
  /** Who is in a live call right now — the "Busy" half of a person's status.
   *  Separate from `presence` because it has a different source (messaging-svc,
   *  from the call rows) and a different lifetime. */
  onCall: ["onCall"] as const,
  notifications: ["notifications"] as const,
  channels: ["channels"] as const,
  openChannels: ["channels", "open"] as const,
  channelMessages: (id: string) => ["channelMessages", id] as const,
  channelReadReceipts: (id: string) => ["channelReadReceipts", id] as const,
  /** Reaction tallies for one channel. Kept OFF the message list for the same
   *  reason `reactions` is: the tally is per-viewer and changes far more often
   *  than the messages, so folding it in would invalidate the whole channel on
   *  every tap. */
  channelReactions: (id: string) => ["channelReactions", id] as const,
  /** Members of ONE channel WITH their roles. Separate from the bare member-id
   *  list the task dialog reads, which must keep its string[] shape. */
  channelRoster: (id: string) => ["channelRoster", id] as const,
  // ── Phase 4: unified inbox + email-style threads ─────────────────────────
  unifiedInbox: ["unifiedInbox"] as const,
  unifiedInboxUnread: ["unifiedInbox", "unread"] as const,
  /** People sidebar of the inbox: distinct counterparties + rollups. */
  inboxPeers: ["inboxPeers"] as const,
  /** Per-person filtered inbox feed. Kept in a namespace separate from
   *  `unifiedInbox` so the all-feed's optimistic patches (which target the
   *  exact `unifiedInbox` key) are never disturbed by peer drill-downs. */
  inboxPeerFeed: (peerId: string) => ["inboxPeerFeed", peerId] as const,
  thread: (id: string) => ["thread", id] as const,
  threadMessages: (id: string) => ["threadMessages", id] as const,
  /** One complete email. Fetched only when a MAIL row is opened — the feed row
   *  itself comes from `unifiedInbox` and carries no body. */
  mail: (id: string) => ["mail", id] as const,
  /** Deleted Items: the same feed as `unifiedInbox`, read with its visibility
   *  predicate inverted. Its OWN namespace rather than a suffix on
   *  `unifiedInbox`, because lib/inboxPatch writes that key with an exact-key
   *  setQueryData and a deleted row landing in those patches would put mail
   *  back in the mailbox it was just removed from. */
  deletedMail: ["deletedMail"] as const,
  /** The Drafts folder — unsent mail, from its own listing rather than the
   *  feed. A draft is in nobody's inbox_items, so there is no feed row to
   *  patch and nothing here shares a namespace with one. */
  mailDrafts: ["mailDrafts"] as const,
  /** Connected external accounts (integrations-svc). */
  integrations: ["integrations"] as const,
  /** Organizations the signed-in identity belongs to (org switcher). */
  myOrgs: ["myOrgs"] as const,
  /** The current org plus any pending deletion (admin-only). */
  org: ["org"] as const,
  /** The org's mandatory-MFA-for-admins policy + grace-period deadline (admin-only). */
  orgMfaSettings: ["orgMfaSettings"] as const,
  /** Unified hub activity timeline (inbound + outbound external messages).
   *  Audit surface — the Hub renders `mentions` instead. */
  integrationActivity: ["integrationActivity"] as const,
  /** "Someone tagged me" feed, per state tab. The bare ["mentions"] prefix
   *  invalidates every tab at once, which is what a claim/ignore needs (a row
   *  moves BETWEEN tabs, so refreshing only the source tab leaves the
   *  destination stale). */
  mentions: (state: string) => ["mentions", state] as const,
  /** My declared/derived handles on external platforms. */
  providerIdentities: ["providerIdentities"] as const,
  appCredentials: ["appCredentials"] as const,
  inboxPins: ["inboxPins"] as const,
  /** Task ids pinned to the desktop (Electron-only; empty on web). */
  taskPins: ["taskPins"] as const,
};

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
      switch (e.type) {
        // ── Calls ────────────────────────────────────────────────────────
        // Notifications only — media rides the SFU, not this socket. All four
        // land here for anyone on the roster, INCLUDING a participant in
        // another org who joined a meeting by link.
        case EventType.CallScheduled:
        case EventType.CallParticipantAdded:
        case EventType.CallEnded: {
          // Someone joined or the call finished, so who is Busy just changed.
          //
          // Invalidated rather than patched: the event names one call, and the
          // question is "is this person in ANY live call" — which only the
          // server can answer without the client tracking every call it has
          // ever heard about.
          //
          // Not complete on its own, deliberately. One participant leaving a
          // call that CONTINUES emits nothing (see store.LeaveCall — only the
          // leave that ends the call produces call.ended), so the 20s poll in
          // useOnCall remains the correctness path. This is what makes the
          // common transitions flip promptly rather than eventually.
          invalidate(qk.onCall);
          invalidate(qk.calls);
          invalidate(qk.call(e.callId));
          if (e.channelId) {
            invalidate(qk.channelCalls(e.channelId));
          }
          // Only announce a scheduling someone ELSE did, and never from the
          // reconnect replay — otherwise every launch re-toasts old meetings.
          if (live && e.type === EventType.CallScheduled && e.actorId !== me) {
            toast(e.title ? `Call scheduled: ${e.title}` : "A call was scheduled");
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
          // Worth interrupting for: it is starting NOW, and the toast is the
          // only thing that reaches someone who is not looking at Meetings.
          // Never from the reconnect replay — that would announce a meeting
          // that started (and ended) hours ago.
          if (live && e.actorId !== me) {
            toast(e.title ? `${e.title} has started` : "A call has started", {
              action: { label: "Join", onClick: () => requestMeetingJoin(e.callId) },
              duration: 20_000,
            });
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
            toast(
              e.title ? `Someone is waiting for ${e.title}` : "Someone is waiting for your call",
              {
                description: "They can't get in until you start it.",
                action: { label: "Open", onClick: () => requestMeetingJoin(e.callId) },
                duration: 20_000,
              },
            );
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
            toast(e.title ? `Incoming call: ${e.title}` : "You were added to a call", {
              action: { label: "Join", onClick: () => requestMeetingJoin(e.callId) },
              duration: 20_000,
            });
          }
          break;
        }
        // The room's record of who is sharing. The picture itself arrives on the
        // media connection; this is what a client reads to know a share is in
        // progress before any track of it turns up.
        //
        // Also invalidates the LIST, not just this one call: MeetingCard reads
        // `activeShares` off the row it was handed by qk.calls (the Meetings
        // page) or qk.channelCalls (a channel's call history), and neither of
        // those is the same cache entry as qk.call. Without this, a share that
        // ended kept showing as active on every card built from a list query —
        // a stale "sharing their screen" that no amount of the room's own
        // cleanup could touch, because the room was never where it was reading
        // that from.
        case EventType.CallShareStarted:
        case EventType.CallShareStopped: {
          invalidate(qk.calls);
          invalidate(qk.call(e.callId));
          if (e.channelId) {
            invalidate(qk.channelCalls(e.channelId));
          }
          break;
        }
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
          // conversation list refreshes (revive + reorder + unread)
          invalidate(qk.conversations);
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
          break;
        }
        case EventType.ChannelMemberJoined: {
          // Routed to the added user only, so this is always about me — but a
          // replayed event from another session's socket is cheap to guard.
          if (e.userId !== me) break;
          // The channel is new to my sidebar; nothing in cache has it yet.
          invalidate(qk.channels);
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
              navRef.current("/app/channels");
            }
          }
          invalidate(qk.channels);
          invalidate(qk.openChannels);
          break;
        }
        case EventType.ChannelRoleChanged:
        case EventType.ChannelUnblocked: {
          invalidate(qk.channelRoster(e.channelId));
          // myRole rides ChannelDTO, so the channel list has to refetch for the
          // moderation controls to appear or disappear.
          invalidate(qk.channels);
          invalidate(qk.openChannels);
          break;
        }
        case EventType.MessageRead: {
          invalidate(qk.conversations);
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
                  createdAt: e.occurredAt,
                });
              return next.sort((a, b) => a.seq - b.seq);
            });
          }
          invalidate(qk.channels);
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
        case EventType.TaskAssigned: {
          if (e.assigneeId === me) {
            invalidate(qk.inbox);
            invalidate(qk.sticky);
            // New TASK row lands in the unified inbox / People sidebar.
            invalidate(qk.unifiedInbox);
            refreshInboxSidebars(invalidate);
            if (live) toast(`New task: ${e.title}`, { description: `from ${e.senderUsername}` });
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
            toast.success(`Task acknowledged by ${e.assigneeUsername}`);
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
          // A status change moves this assignee into or out of the Available
          // roster (see the note on TaskAssigned — push reaches only the two
          // parties; everyone else converges on the poll).
          invalidate(qk.availability);
          break;
        }
        case EventType.TaskCompleted: {
          if (e.senderId === me) {
            if (live) toast.success(`Task completed by ${e.assigneeUsername}`);
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
            const verb = e.type === EventType.TaskLeft ? "left" : "ignored";
            if (live) toast(`Task ${verb} by ${e.assigneeUsername}`);
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
            if (live) toast(`${e.reviewerUsername} reviewed your task`);
          }
          break;
        }
        case EventType.NotificationCreated: {
          if (e.recipientId === me) invalidate(qk.notifications);
          break;
        }
        case EventType.IntegrationActivityCreated: {
          // Every message on a connected account lands here. Refresh the audit
          // timeline but do NOT notify — a connected mailbox or Slack workspace
          // produces constant traffic, and toasting all of it is the firehose
          // the mentions feed exists to replace. Notification is the mention
          // event's job, below.
          if (e.recipientId === me) {
            invalidate(qk.integrationActivity);
          }
          break;
        }
        case EventType.IntegrationMentionCreated: {
          // Someone actually tagged me — this one is worth interrupting for.
          if (e.recipientId === me) {
            invalidate(["mentions"]);
            if (live) toast(`You were mentioned on ${e.provider}`);
          }
          break;
        }
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
          if (live && e.senderId !== me) toast("New mail in your Inbox");
          break;
        }
        // ── Live presence ────────────────────────────────────────────────────
        // Patch the `qk.presence` online-set directly so a teammate's avatar
        // flips the instant they connect/disconnect, instead of waiting up to
        // 20s for the next poll (which remains as a reconciliation fallback).
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
 * Refresh the inbox People sidebar (`qk.inboxPeers`) and any open per-person
 * feed (`["inboxPeerFeed", …]`). The all-feed (`qk.unifiedInbox`) is patched
 * optimistically by the inboxPatch helpers, so it is intentionally left
 * untouched here for message events; task events invalidate it explicitly at
 * their call sites.
 */
function refreshInboxSidebars(invalidate: CoalescedInvalidator) {
  invalidate(qk.inboxPeers);
  invalidate(["inboxPeerFeed"]);
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
      if (!res.ok && res.reason === "limit")
        toast("Desktop is full — complete or unpin a note first (max 5 pinned).");
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
