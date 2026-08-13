"""Kafka domain events → activity rows.

This is the SERVER-OBSERVED half of the activity record, and the more valuable
half: it is derived from events the services emitted while doing the work, so a
client cannot forge, suppress or inflate it. It also needs no client cooperation
at all, which is why it ships before the beacon does.

Three rules decide what is mapped:

  1. There must be an unambiguous HUMAN actor. `notification.created` has a
     recipient but nobody performed it; it is a consequence, not an act.
  2. It must be a deliberate act. `message.read` and `message.delivered` fire
     from scrolling and from a socket connecting — including them would bury a
     day's real work under thousands of rows that say nothing about intent.
  3. The event must already carry what we need. Nothing here calls back to
     another service; a consumer that makes network calls per message becomes a
     bottleneck the moment traffic spikes.

Membership-lifecycle events (user.role_changed, user.removed, …) are deliberately
absent: auth-svc's hash-chained audit_log is the record for who administered
whom, and duplicating it here would create a second, weaker copy of the same
facts.
"""
from __future__ import annotations

from dataclasses import dataclass

# Message bodies use the structured-payload encoding from
# packages/app/src/lib/chatEnvelope.ts:
#     "{readable prefix}" + U+001F + JSON.stringify(envelope)
# Splitting on the separator yields exactly the human-readable prefix the rest of
# the product shows ("🖼️ 3 photos", "📍 Shared a location") and never the JSON
# behind it — so attachment ids and shared coordinates cannot leak into telemetry
# even though the raw body rides the Kafka event in the clear.
ENVELOPE_SENTINEL = "\x1f"
PREVIEW_MAX_CHARS = 120


@dataclass(frozen=True)
class Mapping:
    """How one event type becomes one activity row."""

    actor_field: str          # event key holding the acting user's id
    category: str             # 'auth' | 'engagement' | 'moderation'
    action: str               # stable verb stored on the row
    surface: str | None = None
    target_kind: str | None = None
    target_field: str | None = None
    # Event key whose value becomes the encrypted preview. Only message bodies
    # qualify; task titles are already reachable from the target id.
    preview_field: str | None = None


MAPPINGS: dict[str, Mapping] = {
    # ── messaging ──────────────────────────────────────────────────────────────
    "message.created": Mapping(
        "senderId", "engagement", "message.sent", "chats", "conversation",
        "conversationId", preview_field="body",
    ),
    "channel.message.created": Mapping(
        "senderId", "engagement", "channel.message.sent", "channels", "channel",
        "channelId", preview_field="body",
    ),
    "message.forwarded": Mapping(
        "forwardedBy", "engagement", "message.forwarded", "chats", "message", "messageId",
    ),
    "conversation.ignored": Mapping(
        "ignoredBy", "moderation", "conversation.ignored", "chats", "conversation",
        "conversationId",
    ),
    "conversation.blocked": Mapping(
        "blockedBy", "moderation", "user.blocked", "chats", "conversation", "conversationId",
    ),
    "conversation.unblocked": Mapping(
        "unblockedBy", "moderation", "user.unblocked", "chats", "conversation", "conversationId",
    ),
    # ── tasks ──────────────────────────────────────────────────────────────────
    # task.assigned is attributed to the ALLOCATOR (senderId) — they performed it.
    # Every other transition is attributed to the assignee, who performed that.
    "task.assigned": Mapping(
        "senderId", "engagement", "task.allocated", "tasks", "task", "taskId",
    ),
    "task.acknowledged": Mapping(
        "assigneeId", "engagement", "task.acknowledged", "tasks", "task", "taskId",
    ),
    "task.completed": Mapping(
        "assigneeId", "engagement", "task.completed", "tasks", "task", "taskId",
    ),
    "task.ignored": Mapping(
        "assigneeId", "engagement", "task.ignored", "tasks", "task", "taskId",
    ),
    "task.left": Mapping(
        "assigneeId", "engagement", "task.left", "tasks", "task", "taskId",
    ),
    "task.reviewed": Mapping(
        "senderId", "engagement", "task.reviewed", "tasks", "task", "taskId",
    ),
    # ── auth (emitted by auth-svc in the same tx as the state change) ──────────
    "user.session.started": Mapping("userId", "auth", "login"),
    "user.session.ended": Mapping("userId", "auth", "logout"),
    "user.org_switched": Mapping("userId", "auth", "org.switched"),
}


def preview_of(body: object) -> str | None:
    """The human-readable prefix of a message body, bounded.

    Returns None for an empty body so a system entry (a missed-call marker) does
    not produce a blank preview row.
    """
    if not isinstance(body, str) or not body:
        return None
    readable = body.split(ENVELOPE_SENTINEL, 1)[0].strip()
    if not readable:
        return None
    if len(readable) <= PREVIEW_MAX_CHARS:
        return readable
    return readable[: PREVIEW_MAX_CHARS - 1].rstrip() + "…"
