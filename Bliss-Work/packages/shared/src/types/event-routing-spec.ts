/**
 * Cross-language contract spec for event → recipient routing. NOT wired into
 * any runtime path — ws-gateway (Go) owns live routing via
 * services/ws-gateway/internal/contract/contract.go's `RecipientsOf`, which
 * was ported from this file and must stay in lockstep with it.
 *
 * This file's only consumer is events.mention.test.ts (and any future test
 * that pins a routing rule). That is intentional, not neglect: keeping the
 * rule expressed here, in the same language and next to the same Zod schemas
 * as the wire contract, is what lets a test assert "this event routes to
 * exactly these users" in a form a reviewer can read without cross-referencing
 * Go. When you change routing for an event type, update BOTH this function
 * and contract.go's RecipientsOf, and both test suites.
 */
import { z } from "zod";
import {
  EventType,
  CallScheduled,
  CallRing,
  CallParticipantAdded,
  CallEnded,
  MessageCreated,
  ConversationIgnored,
  ConversationBlocked,
  ConversationUnblocked,
  MessageRead,
  MessageDelivered,
  MessageDismissed,
  MessageDeleted,
  MessageReaction,
  MessageForwarded,
  ChannelMessageCreated,
  ChannelMessageDeleted,
  ChannelMessageReaction,
  ChannelMessagePinned,
  ChannelMemberJoined,
  ChannelMemberRemoved,
  ChannelRoleChanged,
  ChannelBlocked,
  ChannelUnblocked,
  TaskAssigned,
  TaskAcknowledged,
  TaskCompleted,
  TaskIgnored,
  TaskLeft,
  TaskReviewed,
  NotificationCreated,
  StickyRefresh,
  MailDelivered,
  UserCreated,
  UserRoleChanged,
  UserDeactivated,
  UserReactivated,
  UserRemoved,
  UserSessionStarted,
  UserSessionEnded,
  UserOrgSwitched,
  OrgDeleteRequested,
  OrgDeleteCancelled,
  OrgDeleted,
  InviteCreated,
  PasswordResetRequested,
  EmailVerificationRequested,
} from "./events";

/** Every domain event on the bus (superset of ServerEvent + internal-only). */
export const DomainEvent = z.discriminatedUnion("type", [
  CallScheduled,
  CallRing,
  CallParticipantAdded,
  CallEnded,
  MessageCreated,
  ConversationIgnored,
  ConversationBlocked,
  ConversationUnblocked,
  MessageRead,
  MessageDelivered,
  MessageDismissed,
  MessageDeleted,
  MessageReaction,
  MessageForwarded,
  ChannelMessageCreated,
  ChannelMessageDeleted,
  ChannelMessageReaction,
  ChannelMessagePinned,
  ChannelMemberJoined,
  ChannelMemberRemoved,
  ChannelRoleChanged,
  ChannelBlocked,
  ChannelUnblocked,
  TaskAssigned,
  TaskAcknowledged,
  TaskCompleted,
  TaskIgnored,
  TaskLeft,
  TaskReviewed,
  NotificationCreated,
  StickyRefresh,
  MailDelivered,
  UserCreated,
  UserRoleChanged,
  UserDeactivated,
  UserReactivated,
  UserRemoved,
  UserSessionStarted,
  UserSessionEnded,
  UserOrgSwitched,
  OrgDeleteRequested,
  OrgDeleteCancelled,
  OrgDeleted,
  InviteCreated,
  PasswordResetRequested,
  EmailVerificationRequested,
]);
export type DomainEvent = z.infer<typeof DomainEvent>;

/**
 * Routing helper — given a domain event, which user IDs should receive it over
 * their live socket? Mirrors ws-gateway's consume-all-and-filter mode.
 *
 * ── Call this on a BUS event, never on a delivered one ──────────────────────
 * `members` is routing metadata: producers put it on the event so this function
 * can answer the question, and the gateway STRIPS it once it has (see
 * ws-gateway/internal/contract/payload.go). It is therefore present on the bus
 * and absent by the time a frame reaches a client — which is why the field is
 * `.optional()` on every schema below, and why every read here tolerates its
 * absence.
 *
 * The strip is not tidiness. messaging-svc ships a channel's full roster inside
 * the event, and the gateway stores one copy per recipient, so an N-member
 * channel cost O(N²) bytes of Redis per message until the field was removed
 * before persistence.
 *
 * An event that has already been stripped routes to nobody, which is correct:
 * it has been routed. The empty list is the honest answer, not a fallback.
 */
export function recipientsOf(e: DomainEvent): string[] {
  switch (e.type) {
    case EventType.MessageCreated:
      return [e.recipientId, e.senderId];
    case EventType.ConversationIgnored:
      return e.members ?? [];
    case EventType.CallScheduled:
    case EventType.CallRing:
    case EventType.CallParticipantAdded:
    case EventType.CallEnded:
      // The roster messaging-svc computed. This is the ONE routing case whose
      // recipients may belong to a different org than the event — a meeting
      // joined by link spans orgs — and it needs no special handling precisely
      // because routing here has never consulted an org.
      //
      // Must stay in lockstep with ws-gateway/internal/contract/contract.go.
      return e.members ?? [];
    case EventType.ConversationBlocked:
    case EventType.ConversationUnblocked:
      // Both members: the blocked peer flips their composer banner live, and
      // the blocker's other devices stay in sync.
      return e.members ?? [];
    case EventType.MessageRead:
      return [e.recipientId];
    case EventType.MessageDelivered:
      // Sender-only echo so the per-message Delivered badge flips.
      return [e.senderId];
    case EventType.MessageDismissed:
      // Multi-device sync for the sender who dismissed; never to the peer.
      return [e.dismissedBy];
    case EventType.MessageDeleted:
    case EventType.MessageReaction:
      // BOTH parties, unlike MessageDismissed. A delete-for-everyone the
      // recipient only learns about at their next refetch is one they may well
      // have screenshotted first, and a reaction nobody sees arrive is not a
      // reaction.
      return e.members ?? [];
    case EventType.MessageForwarded:
      // The forwarder (multi-device sync) and the ORIGINAL author, who is the
      // person entitled to know their message left the workspace. Deliberately
      // NOT `members`: for a channel source that would publish a third party's
      // name to the whole roster, and the pill written into the chat already
      // tells the room as much as it should know.
      return [e.forwardedBy, e.rootAuthorId];
    case EventType.ChannelMessageCreated:
    // The whole channel, for the same reason message.deleted goes to both DM
    // parties: a moderator's delete that members only learn about at their next
    // refetch is one they may well have screenshotted first, and a pin nobody
    // sees appear is not a pin.
    case EventType.ChannelMessageDeleted:
    case EventType.ChannelMessageReaction:
    case EventType.ChannelMessagePinned:
      return e.members ?? [];
    case EventType.ChannelMemberJoined:
      // The person who was added, and only them — one event is emitted PER
      // ADDED MEMBER, so routing to the roster would be added x roster pushes.
      // Must stay in lockstep with ws-gateway/internal/contract/contract.go.
      return [e.userId];
    case EventType.ChannelMemberRemoved:
    case EventType.ChannelRoleChanged:
    case EventType.ChannelBlocked:
    case EventType.ChannelUnblocked:
      // Surviving members refresh the roster; the affected user is appended
      // because they are no longer IN it and would otherwise be left looking at
      // a channel they can no longer post to.
      return [...(e.members ?? []), e.userId];
    case EventType.TaskAssigned:
      return [e.assigneeId];
    case EventType.StickyRefresh:
      // The desktop-note delivery watchdog nudging one person's clients to
      // re-fetch. Must stay in lockstep with
      // ws-gateway/internal/contract/contract.go.
      return [e.assigneeId];
    case EventType.TaskAcknowledged:
    case EventType.TaskCompleted:
      // own-echo to assignee (updates their sticky widget) + notify sender
      return [e.senderId, e.assigneeId];
    case EventType.TaskIgnored:
    case EventType.TaskLeft:
      return [e.senderId, e.assigneeId];
    case EventType.TaskReviewed:
      // Assignee sees the review land live; sender's other devices sync.
      return [e.senderId, e.assigneeId];
    case EventType.NotificationCreated:
      return [e.recipientId];
    case EventType.MailDelivered:
      // Every local recipient plus the author. Must stay in lockstep with
      // ws-gateway/internal/contract/contract.go.
      return e.members ?? [];
    case EventType.UserCreated:
    case EventType.InviteCreated:
    case EventType.PasswordResetRequested:
    case EventType.EmailVerificationRequested:
      return []; // internal-only, never pushed to a socket
    default:
      return [];
  }
}
