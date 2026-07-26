"""Per-provider @-mention extraction.

Runs on the RAW provider payload — Slack's ``<@U0123>`` markup, Graph's
``chatMessage.mentions[]``, an RFC-5322 header block — and NEVER on the body we
persist: by then the markup has been flattened away and ``body_enc`` is
ciphertext anyway.

Every function here is pure (dict in, MentionScan out — no I/O, no db, no clock)
so the noisy real-world cases each get a cheap unit test. Turning a handle into a
Bliss-Work ``user_id`` is the db half and lives in app/identities.py.

What counts as "tagged" is deliberately conservative. The whole point of the hub
is to replace a firehose of every message on a connected account with "someone
asked for me", so broadcast pings (Slack ``@channel``, a Teams @team mention),
bot chatter and bulk mail are all treated as noise. An excluded message is still
recorded as ordinary activity for audit — it just never becomes a mention.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from email.utils import getaddresses
from typing import Any

# Slack encodes a user mention as <@U0123ABCD> or <@U0123ABCD|display-name>.
# Member ids start with U (user) or W (enterprise-grid user).
_SLACK_MENTION_RE = re.compile(r"<@([UW][A-Z0-9]{2,})(?:\|[^>]*)?>")

# Slack message subtypes that are noise rather than someone talking to you.
_SLACK_NOISE_SUBTYPES = frozenset(
    {
        "bot_message",
        "channel_join",
        "channel_leave",
        "channel_topic",
        "channel_purpose",
        "channel_name",
        "channel_archive",
        "channel_unarchive",
        "group_join",
        "group_leave",
        "message_changed",
        "message_deleted",
        "thread_broadcast",
        "file_share",
        "tombstone",
    }
)

# Headers that mark mail as bulk/automated. Being in the To: of a newsletter is
# not someone tagging you.
_BULK_HEADERS = ("list-id", "list-unsubscribe", "list-post")


@dataclass(frozen=True)
class MentionScan:
    """Result of scanning one raw provider payload.

    ``handles`` are EXTERNAL identifiers (Slack member id, e-mail address, AAD
    object id) in payload order with duplicates removed — resolving them to
    Bliss-Work users is identities.resolve_users()'s job. Empty means "not a
    mention"; the activity row is still written, just not flagged.
    """

    handles: tuple[str, ...] = ()
    #: Stable provider locator for the conversation, e.g. "C123/1712.0001".
    thread_ref: str | None = None
    #: Deep link back to the message, when the provider gives us one.
    permalink: str | None = None


def detect_mentions(
    provider: str,
    raw: dict[str, Any],
    *,
    connected_account: str | None = None,
    owner_handle: str | None = None,
) -> MentionScan:
    """Extract the handles tagged in one inbound message.

    ``connected_account`` is the connection's own identity (a mailbox address);
    it is used to drop self-echoes. ``owner_handle`` opts a WhatsApp connection
    into treating direct messages as tagging its owner — see _whatsapp_scan.
    An unknown provider yields an empty scan rather than raising, so a new
    provider can start recording activity before its parser exists.
    """
    scanner = _SCANNERS.get(provider)
    if scanner is None:
        return MentionScan()
    return scanner(raw, connected_account, owner_handle)


def _dedupe(values: list[str]) -> tuple[str, ...]:
    """Order-preserving dedupe, dropping empties. Being tagged twice in one
    message is one mention, and payload order is the closest thing to intent."""
    seen: set[str] = set()
    out: list[str] = []
    for v in values:
        v = v.strip()
        if not v or v in seen:
            continue
        seen.add(v)
        out.append(v)
    return tuple(out)


# ── Slack ─────────────────────────────────────────────────────────────────────
def _slack_scan(
    ev: dict[str, Any], _connected: str | None, _owner: str | None
) -> MentionScan:
    """Scan a Slack Events-API `event` object.

    <!here>, <!channel> and <!everyone> are deliberately NOT mentions: they are
    broadcasts to a room, and treating them as personal would put us straight
    back to the firehose the hub exists to replace.
    """
    if ev.get("type") != "message":
        return MentionScan()
    # Bot posts and membership/edit churn are not someone tagging you.
    if ev.get("bot_id") or ev.get("subtype") in _SLACK_NOISE_SUBTYPES:
        return MentionScan()

    text = ev.get("text") or ""
    handles = _dedupe(_SLACK_MENTION_RE.findall(text))
    channel = ev.get("channel") or ""
    ts = ev.get("thread_ts") or ev.get("ts") or ""
    return MentionScan(
        handles=handles,
        thread_ref=f"{channel}/{ts}" if channel or ts else None,
        # The Events API doesn't include a permalink; chat.getPermalink is a
        # separate call and belongs in the provider layer, not this pure module.
        permalink=None,
    )


# ── WhatsApp ──────────────────────────────────────────────────────────────────
def _whatsapp_scan(
    msg: dict[str, Any], _connected: str | None, owner_handle: str | None
) -> MentionScan:
    """Scan one flattened WhatsApp Cloud API message.

    WhatsApp exposes NO mention markup, so there is no honest "you were tagged"
    signal and WhatsApp yields nothing by default. A connection may opt in by
    setting `mentionOwnerUserId`, which the caller passes as ``owner_handle``:
    then every inbound 1:1 message counts as tagging that owner, which is
    truthful for a personal business number but would be noise on a shared one.
    """
    if not owner_handle:
        return MentionScan()
    return MentionScan(
        handles=(owner_handle,),
        thread_ref=msg.get("external_id") or None,
        permalink=None,
    )


# ── Mail (Gmail + Outlook share the To/Cc rule) ────────────────────────────────
def _is_bulk(headers: dict[str, str]) -> bool:
    """True for newsletters, mailing lists and auto-replies."""
    if any(h in headers for h in _BULK_HEADERS):
        return True
    if headers.get("precedence", "").lower() in {"bulk", "list", "junk"}:
        return True
    # RFC 3834: auto-replied / auto-generated / auto-notified.
    return headers.get("auto-submitted", "no").lower() != "no"


def _gmail_scan(
    msg: dict[str, Any], connected_account: str | None, _owner: str | None
) -> MentionScan:
    """Scan a Gmail `users.messages.get?format=metadata` response.

    Both To and Cc count: being copied on a thread that names you is still being
    addressed. Every recipient is returned, not just the connected mailbox, so a
    shared inbox can tag several teammates in one pass — the identity table then
    decides which of them actually exist in this org.
    """
    payload = msg.get("payload") or {}
    headers = {
        str(h.get("name", "")).lower(): str(h.get("value", ""))
        for h in (payload.get("headers") or [])
    }
    if _is_bulk(headers):
        return MentionScan()

    from_addrs = [a.lower() for _, a in getaddresses([headers.get("from", "")]) if a]
    if connected_account and connected_account.lower() in from_addrs:
        return MentionScan()  # our own sent mail echoing back

    recipients = getaddresses([headers.get("to", ""), headers.get("cc", "")])
    handles = _dedupe([addr.lower() for _, addr in recipients if addr])
    msg_id = msg.get("id") or ""
    return MentionScan(
        handles=handles,
        thread_ref=msg.get("threadId") or None,
        permalink=f"https://mail.google.com/mail/u/0/#all/{msg_id}" if msg_id else None,
    )


def _outlook_scan(
    msg: dict[str, Any], connected_account: str | None, _owner: str | None
) -> MentionScan:
    """Scan a Graph `message` resource (Outlook mail). Same rule as Gmail."""
    sender = (
        ((msg.get("from") or {}).get("emailAddress") or {}).get("address") or ""
    ).lower()
    if connected_account and sender == connected_account.lower():
        return MentionScan()

    addrs: list[str] = []
    for key in ("toRecipients", "ccRecipients"):
        for entry in msg.get(key) or []:
            addr = ((entry or {}).get("emailAddress") or {}).get("address") or ""
            if addr:
                addrs.append(addr.lower())

    return MentionScan(
        handles=_dedupe(addrs),
        thread_ref=msg.get("conversationId") or None,
        permalink=msg.get("webLink") or None,
    )


# ── Teams ─────────────────────────────────────────────────────────────────────
def _teams_scan(
    msg: dict[str, Any], _connected: str | None, _owner: str | None
) -> MentionScan:
    """Scan a Graph `chatMessage`.

    Only USER mentions count — `mentioned.conversation` is an @team/@channel
    broadcast, excluded for the same reason as Slack's <!channel>. Handles are
    AAD object ids, which is what an OAuth-derived identity stores for Teams.
    """
    if msg.get("messageType") != "message":
        return MentionScan()
    # Bots/connectors post as an application rather than a user.
    if (msg.get("from") or {}).get("application"):
        return MentionScan()

    handles: list[str] = []
    for m in msg.get("mentions") or []:
        user = ((m or {}).get("mentioned") or {}).get("user") or {}
        if user.get("id"):
            handles.append(str(user["id"]))

    chat_id = msg.get("chatId") or ""
    msg_id = msg.get("id") or ""
    return MentionScan(
        handles=_dedupe(handles),
        thread_ref=f"{chat_id}/{msg_id}" if chat_id or msg_id else None,
        permalink=msg.get("webUrl") or None,
    )


_SCANNERS = {
    "slack": _slack_scan,
    "whatsapp": _whatsapp_scan,
    "gmail": _gmail_scan,
    "outlook": _outlook_scan,
    "teams": _teams_scan,
}
