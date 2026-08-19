"""The routing directory's event contract, and how a received one is applied.

Every site keeps its own copy of the directory and they are kept in step by the
region bridge: a site publishes onto its LOCAL Kafka, the bridge carries it to
every peer, and each peer's consumer upserts locally. The bridge already
guarantees what this needs — same topic name everywhere, at-least-once, deduped
by event id, and loop-guarded — so nothing here re-implements any of it.

── Why these events carry no orgId ──────────────────────────────────────────

Every other event in the platform is org-scoped. These are not: the directory is
infrastructure that answers "where does this key live?" BEFORE any org context
exists, which is the whole reason it can serve an invite redemption that has
only a token hash. An orgId field would be a lie on the invite rows and an
invitation to route by it.

── Ordering ─────────────────────────────────────────────────────────────────

`occurredAt` is the version. An upsert is applied only if it is at least as new
as what is stored, so a replay, a redelivery, or a revoke that overtakes its own
upsert all converge on the same state. That is what makes the consumer safe to
run at-least-once, which is the only delivery the bridge offers.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import uuid6

# The bridged topic these ride on. Its own topic rather than `auth.events`:
# every site consumes every routing event (they are not org-scoped), the
# retention needs are different — this is a directory, not a change feed — and a
# storm of invite churn must not sit in front of the auth events behind it.
TOPIC_ROUTING = "routing.events.v1"

TYPE_UPSERTED = "routing.upserted"
TYPE_REVOKED = "routing.revoked"
TYPE_CAPACITY = "site.capacity.reported"

KEY_ORG = "org"
KEY_INVITE = "invite"


def invite_key(token_hash: bytes) -> str:
    """The directory key for an invite: its token hash, hex-encoded.

    `routing_directory.key_value` is text and `invites.token_hash` is bytea, so
    SOMETHING has to encode. Doing it in one function shared by the writer and
    the reader is the whole point — the two sides disagreeing about hex vs
    base64 would not fail anywhere, it would simply never find a row, and every
    cross-site redemption would answer "retry" until the invite expired.
    """
    return token_hash.hex()


def _now_iso_z() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _envelope(event_type: str) -> dict[str, Any]:
    return {"eventId": str(uuid6.uuid7()), "type": event_type, "occurredAt": _now_iso_z()}


def routing_upserted(
    key_type: str, key_value: str, home_site: str, expires_at: datetime | None = None
) -> dict[str, Any]:
    """A key now lives at `home_site`. Published on org placement and invite creation."""
    event = _envelope(TYPE_UPSERTED)
    event.update(keyType=key_type, keyValue=key_value, homeSite=home_site)
    if expires_at is not None:
        event["expiresAt"] = expires_at.astimezone(timezone.utc).isoformat()
    return event


def routing_revoked(key_value: str, reason: str) -> dict[str, Any]:
    """An invite no longer applies. Orgs are never revoked — they have no expiry
    and no second home, so there is nothing a revoke could mean for one."""
    event = _envelope(TYPE_REVOKED)
    event.update(keyType=KEY_INVITE, keyValue=key_value, reason=reason)
    return event


def site_capacity_reported(site: str, used_bytes: int, ceiling_bytes: int) -> dict[str, Any]:
    """This site's storage position, so every peer can make a placement decision
    from a LOCAL read. Without it, the cascade would need a cross-site query on
    the signup path, which is the one thing the design rules out."""
    event = _envelope(TYPE_CAPACITY)
    event.update(site=site, usedBytes=used_bytes, ceilingBytes=ceiling_bytes)
    return event


# ── receiving ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DirectoryUpsert:
    key_type: str
    key_value: str
    home_site: str
    expires_at: datetime | None
    occurred_at: datetime
    revoked: bool


@dataclass(frozen=True)
class CapacityReport:
    site: str
    used_bytes: int
    ceiling_bytes: int
    occurred_at: datetime


def parse(event: dict[str, Any]) -> DirectoryUpsert | CapacityReport | None:
    """Decode one routing event, or None if it is not one we act on.

    Tolerant by design: an unknown type is ignored rather than fatal, because
    this topic is bridged to every site and a newer site may publish something an
    older one has never heard of. Malformed events are dropped for the same
    reason — one bad row must not stop the directory converging.
    """
    kind = event.get("type")
    occurred = _parse_ts(event.get("occurredAt"))
    if occurred is None:
        return None

    if kind == TYPE_CAPACITY:
        site = event.get("site")
        used, ceiling = event.get("usedBytes"), event.get("ceilingBytes")
        if not isinstance(site, str) or not site:
            return None
        if not isinstance(used, int) or not isinstance(ceiling, int):
            return None
        return CapacityReport(site, used, ceiling, occurred)

    if kind in (TYPE_UPSERTED, TYPE_REVOKED):
        key_type, key_value = event.get("keyType"), event.get("keyValue")
        if key_type not in (KEY_ORG, KEY_INVITE) or not isinstance(key_value, str) or not key_value:
            return None
        if kind == TYPE_REVOKED:
            # A revoke names no site; the stored row keeps whichever it had.
            return DirectoryUpsert(key_type, key_value, "", None, occurred, revoked=True)
        home = event.get("homeSite")
        if not isinstance(home, str) or not home:
            return None
        return DirectoryUpsert(
            key_type, key_value, home, _parse_ts(event.get("expiresAt")), occurred, revoked=False
        )

    return None


def _parse_ts(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
