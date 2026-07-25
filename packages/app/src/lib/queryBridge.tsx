import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  EventType,
  type ServerEvent,
  type StickyTaskDTO,
  type ConversationDTO,
  type MessageDTO,
  type ChannelMessageDTO,
  type UserDTO,
  actionsFor,
} from "@taskboard/shared";
import { useRuntime } from "./runtime";
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
  inbox: ["tasks", "inbox"] as const,
  sent: ["tasks", "sent"] as const,
  sticky: ["tasks", "sticky"] as const,
  assigned: ["tasks", "assigned"] as const,
  directory: ["directory"] as const,
  invites: ["invites"] as const,
  presence: ["presence"] as const,
  notifications: ["notifications"] as const,
  channels: ["channels"] as const,
  openChannels: ["channels", "open"] as const,
  channelMessages: (id: string) => ["channelMessages", id] as const,
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
  /** Forward-tracking: the downstream forward tree of one original message. The
   *  bare ["forwardActivity"] prefix is the "my originals that got forwarded" list. */
  forwardActivity: (rootMessageId: string) => ["forwardActivity", rootMessageId] as const,
  /** "Who forwarded my messages" feed. Kept under the ["forwardActivity"] prefix
   *  so the message.forwarded handler's prefix-invalidation refreshes it too. */
  forwardActivityFeed: ["forwardActivity", "feed"] as const,
  /** Connected external accounts (integrations-svc). */
  integrations: ["integrations"] as const,
  /** Unified hub activity timeline (inbound + outbound external messages). */
  integrationActivity: ["integrationActivity"] as const,
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

  useEffect(() => {
    // Electron relays events from the utilityProcess; web opens its own socket.
    const source = config.eventSource;
    if (source) source.connect();
    else void ws.connect();

    const handle = (e: ServerEvent) => {
      const me = useSession.getState().user?.id;
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
          void qc.invalidateQueries({ queryKey: qk.conversations });
          // People sidebar + open per-person feed (all-feed already patched).
          refreshInboxSidebars(qc);
          break;
        }
        case EventType.ConversationIgnored: {
          qc.setQueryData<ConversationDTO[]>(qk.conversations, (prev) =>
            (prev ?? []).filter((c) => c.id !== e.conversationId),
          );
          patchInboxOnIgnored(qc, e);
          refreshInboxSidebars(qc);
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
          void qc.invalidateQueries({ queryKey: qk.conversations });
          break;
        }
        case EventType.MessageRead: {
          void qc.invalidateQueries({ queryKey: qk.conversations });
          if (me) patchThreadOnRead(qc, e, me);
          break;
        }
        case EventType.MessageDelivered: {
          patchThreadOnDelivered(qc, e);
          break;
        }
        case EventType.MessageDismissed: {
          patchOnDismissed(qc, e);
          refreshInboxSidebars(qc);
          break;
        }
        case EventType.MessageForwarded: {
          // The message the recipient actually receives rides its own
          // MessageCreated (handled above). This event exists ONLY to tell the
          // ORIGINAL author their message was forwarded — so react solely when
          // I am the root author and someone else did the forwarding.
          if (e.rootAuthorId === me && e.forwardedBy !== me) {
            const dir = qc.getQueryData<UserDTO[]>(qk.directory) ?? [];
            const nameOf = (id?: string) =>
              dir.find((u) => u.id === id)?.displayName ?? "someone";
            const to = e.forwardedTo
              ? nameOf(e.forwardedTo)
              : e.forwardedToExternal ?? "someone";
            const via = e.platform === "blisswork" ? "" : ` via ${e.platform}`;
            toast(`Your message was forwarded to ${to}`, {
              description: `${nameOf(e.forwardedBy)} forwarded "${e.bodyPreview}"${via}`,
            });
            // Refresh this original's tree + the "my forwarding activity" list.
            void qc.invalidateQueries({ queryKey: qk.forwardActivity(e.rootMessageId) });
            void qc.invalidateQueries({ queryKey: ["forwardActivity"] });
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
                  body: e.body,
                  createdAt: e.occurredAt,
                });
              return next.sort((a, b) => a.seq - b.seq);
            });
          }
          void qc.invalidateQueries({ queryKey: qk.channels });
          break;
        }
        case EventType.TaskAssigned: {
          if (e.assigneeId === me) {
            void qc.invalidateQueries({ queryKey: qk.inbox });
            void qc.invalidateQueries({ queryKey: qk.sticky });
            // New TASK row lands in the unified inbox / People sidebar.
            void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
            refreshInboxSidebars(qc);
            toast(`New task: ${e.title}`, { description: `from ${e.senderUsername}` });
          }
          break;
        }
        case EventType.TaskAcknowledged: {
          if (e.senderId === me)
            toast.success(`Task acknowledged by ${e.assigneeUsername}`);
          if (e.assigneeId === me) {
            patchStickyStatus(qc, e.taskId, "ACKNOWLEDGED", e.statusVersion);
            // Auto-pin to the desktop on acknowledge (Electron only; absent on
            // web ⇒ no-op, the task simply lands in the Tasks section). Single
            // chokepoint covering every acknowledge surface (inbox row, task
            // detail, sticky). Locked-until-Complete is enforced by StickyWidget.
            autoPinOnAcknowledge(qc, config, e.taskId);
            void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
            refreshInboxSidebars(qc);
          }
          void qc.invalidateQueries({ queryKey: qk.sent });
          void qc.invalidateQueries({ queryKey: qk.notifications });
          break;
        }
        case EventType.TaskCompleted: {
          if (e.senderId === me) {
            toast.success(`Task completed by ${e.assigneeUsername}`);
            // Sender's inbox row needs to refresh so the row reflects the
            // completion (status badge / hidden state). Without this the
            // allocator only learns via the toast and a stale row stays put.
            void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
            refreshInboxSidebars(qc);
          }
          if (e.assigneeId === me) {
            clearTaskForMe(qc, e.taskId);
            void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
            refreshInboxSidebars(qc);
          }
          void qc.invalidateQueries({ queryKey: qk.sent });
          void qc.invalidateQueries({ queryKey: qk.notifications });
          break;
        }
        case EventType.TaskIgnored:
        case EventType.TaskLeft: {
          // Allocator gets a live toast + inbox refresh for EVERY outcome (the
          // durable notification arrives separately via NotificationCreated).
          if (e.senderId === me) {
            const verb = e.type === EventType.TaskLeft ? "left" : "ignored";
            toast(`Task ${verb} by ${e.assigneeUsername}`);
            void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
            refreshInboxSidebars(qc);
          }
          if (e.assigneeId === me) {
            clearTaskForMe(qc, e.taskId);
            void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
            refreshInboxSidebars(qc);
          }
          void qc.invalidateQueries({ queryKey: qk.sent });
          void qc.invalidateQueries({ queryKey: qk.notifications });
          break;
        }
        case EventType.TaskReviewed: {
          // Sender's other devices see the review they left; the assignee sees
          // a review land on their completed task. Refetch the affected surfaces.
          if (e.senderId === me) void qc.invalidateQueries({ queryKey: qk.sent });
          if (e.assigneeId === me) {
            void qc.invalidateQueries({ queryKey: qk.assigned });
            void qc.invalidateQueries({ queryKey: qk.sticky });
            toast(`${e.reviewerUsername} reviewed your task`);
          }
          break;
        }
        case EventType.NotificationCreated: {
          if (e.recipientId === me) void qc.invalidateQueries({ queryKey: qk.notifications });
          break;
        }
        case EventType.IntegrationActivityCreated: {
          // New inbound/outbound activity on a connected account → refresh the hub
          // feed live, and toast inbound messages (signal-only; body is refetched).
          if (e.recipientId === me) {
            void qc.invalidateQueries({ queryKey: qk.integrationActivity });
            if (e.direction === "inbound") toast(`New ${e.provider} message`);
          }
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
      if (!source) ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

/**
 * Refresh the inbox People sidebar (`qk.inboxPeers`) and any open per-person
 * feed (`["inboxPeerFeed", …]`). The all-feed (`qk.unifiedInbox`) is patched
 * optimistically by the inboxPatch helpers, so it is intentionally left
 * untouched here for message events; task events invalidate it explicitly at
 * their call sites.
 */
function refreshInboxSidebars(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: qk.inboxPeers });
  void qc.invalidateQueries({ queryKey: ["inboxPeerFeed"] });
}

/**
 * Auto-pin a just-acknowledged task to the desktop (Electron only). Mirrors the
 * manual pin flow in InboxTask: writes the authoritative pinned set back into
 * `qk.taskPins` and surfaces the max-5 limit refusal. No-op on web (config.pinTask
 * absent) and idempotent on redelivered events (already-pinned ⇒ same set).
 */
function autoPinOnAcknowledge(
  qc: ReturnType<typeof useQueryClient>,
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
    .catch(() => void qc.invalidateQueries({ queryKey: qk.taskPins }));
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
function clearTaskForMe(qc: ReturnType<typeof useQueryClient>, taskId: string) {
  removeSticky(qc, taskId);
  void qc.invalidateQueries({ queryKey: qk.assigned });
  qc.setQueryData<string[]>(qk.taskPins, (prev) =>
    prev ? prev.filter((id) => id !== taskId) : prev,
  );
}
