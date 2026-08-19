"""Placing a new organisation, and telling somebody when a site is filling up.

The decision itself is in policy.py and is pure. This is the shell around it:
read the capacity snapshot, apply the policy, write the directory row and the
outbox event in the caller's transaction, and hand back the alerts for someone
else to dispatch.

── Why the notification is not sent here ────────────────────────────────────

A site crossing 80% is an operational fact, not part of creating an account. If
the alert were sent inside the placement transaction, an SMTP timeout or a Slack
outage would hold a database transaction open and then fail a signup that had
already succeeded in every way that matters. So `place_org` RETURNS the alerts
and the caller fires them after the transaction commits, on a task nobody
awaits. A notification that never arrives costs an operator a dashboard glance;
a notification that blocks a signup costs a customer.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from ..events.outbox import enqueue_event
from . import directory
from .events import KEY_ORG, TOPIC_ROUTING, routing_upserted
from .policy import REASON_NO_CAPACITY, REASON_UNKNOWN_CAPACITY, Placement, SiteCapacity, choose_site


class NoCapacityError(RuntimeError):
    """Every site is at its hard ceiling, or none of them is reporting.

    Deliberately distinct from every other signup failure. It is not a bad
    request and not a transient fault — it means the deployment has run out of
    somewhere to put an organisation, which no retry and no user action fixes.
    The signup flow turns it into a 503 that says so, and ops gets paged.
    """

    def __init__(self, reason: str, worst: SiteCapacity | None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.worst = worst


@dataclass(frozen=True)
class PlacementResult:
    site: str
    reason: str
    # Sites at or over the warning threshold, for the caller to announce AFTER
    # the transaction commits. Never dispatched from inside placement.
    alerts: tuple[SiteCapacity, ...]


async def place_org(
    conn: AsyncConnection,
    org_id: str,
    *,
    local_site: str,
    candidates: list[str],
    now: datetime | None = None,
    max_report_age: timedelta = timedelta(minutes=15),
) -> PlacementResult:
    """Decide this org's home site and record it, in the caller's transaction.

    `candidates` is nearest-first for the signing-up user. The local site is
    appended if missing, so a deployment that cannot geolocate a request still
    has somewhere sensible to start rather than no candidates at all.

    The directory row and the outbox event are written HERE, next to each other
    and inside the caller's transaction, so a placement is never visible locally
    without also being on its way to every peer.
    """
    moment = now or datetime.now(timezone.utc)
    order = list(candidates) or []
    if local_site not in order:
        order.append(local_site)

    capacity = await directory.load_capacity(conn)
    decision = choose_site(order, capacity, now=moment, max_report_age=max_report_age)

    if not decision.placed:
        worst = _least_filled(capacity)
        raise NoCapacityError(decision.reason, worst)

    site = decision.site
    assert site is not None  # placed is True

    await directory.upsert_local(
        conn,
        key_type=KEY_ORG,
        key_value=org_id,
        home_site=site,
        expires_at=None,  # orgs never expire and are never revoked
        occurred_at=moment,
    )
    # Every peer needs this row before it can route anything for the org. Keyed
    # by the org id so a later event for the same key stays behind this one on
    # the same partition.
    await enqueue_event(
        conn,
        topic=TOPIC_ROUTING,
        kafka_key=org_id,
        event=routing_upserted(KEY_ORG, org_id, site),
    )
    return PlacementResult(site=site, reason=decision.reason, alerts=decision.alerts)


async def record_invite_placement(
    conn: AsyncConnection,
    token_hash: str,
    *,
    home_site: str,
    expires_at: datetime,
    now: datetime | None = None,
) -> None:
    """Make an invite routable from any site, in the invite's own transaction.

    An invite is redeemed by token hash ALONE — it has to work before its
    recipient belongs to anything — so the token is the only routing key there
    is. Without this row a redemption at another site has nothing to look up and
    would answer "retry" until the invite expired.
    """
    moment = now or datetime.now(timezone.utc)
    await directory.upsert_local(
        conn,
        key_type="invite",
        key_value=token_hash,
        home_site=home_site,
        expires_at=expires_at,
        occurred_at=moment,
    )
    await enqueue_event(
        conn,
        topic=TOPIC_ROUTING,
        kafka_key=token_hash,
        event=routing_upserted("invite", token_hash, home_site, expires_at),
    )


async def home_site_of_org(conn: AsyncConnection, org_id: str) -> str | None:
    """This org's home site, for callers that need it without a full decision —
    minting an invite, which must be stamped with the ORG's site rather than
    whichever site happened to serve the request."""
    entry = await directory.lookup(conn, KEY_ORG, org_id)
    return entry.home_site if entry else None


def alert_message(cap: SiteCapacity) -> str:
    """The line an operator reads. States the number, because "a site is nearly
    full" without one cannot be triaged."""
    return (
        f"Site {cap.site} is at {cap.pct:.1f}% of its storage ceiling "
        f"({cap.used_bytes / (1 << 30):.0f} GB of {cap.ceiling_bytes / (1 << 30):.0f} GB). "
        f"New organisations are being routed to other sites."
    )


def no_capacity_message(reason: str, worst: SiteCapacity | None) -> str:
    """The page. This one is not a warning — signups are being refused."""
    if reason == REASON_UNKNOWN_CAPACITY:
        return (
            "No site is reporting storage capacity, so no organisation can be placed. "
            "Signups are being refused. Check the routing event bridge and the capacity reporters."
        )
    if worst is None:
        return "Every site is at its storage ceiling. Signups are being refused."
    return (
        f"Every site is at its storage ceiling — the emptiest is {worst.site} at "
        f"{worst.pct:.1f}%. Signups are being refused until capacity is added."
    )


def _least_filled(capacity: dict[str, SiteCapacity]) -> SiteCapacity | None:
    if not capacity:
        return None
    return min(capacity.values(), key=lambda c: (c.pct, c.site))


async def backfill_local_orgs(conn: AsyncConnection, *, site: str, limit: int = 500) -> int:
    """Give orgs that predate the directory a home, and tell every peer.

    Without this, every organisation created before this feature shipped has no
    routing row — so a request for one arriving at any site reads "not
    replicated yet" and retries forever. The rows cannot be inferred remotely
    either: only the site actually holding the data knows it holds it.

    Idempotent and bounded, so it can run on every boot until it has nothing
    left to do. `ON CONFLICT DO NOTHING` rather than an upsert: a row that
    already exists may have been placed deliberately, and a backfill must never
    overwrite a real placement with a local guess.
    """
    rows = (
        await conn.execute(
            text(
                """
                INSERT INTO routing_directory (key_type, key_value, home_site, updated_at)
                SELECT 'org', o.id::text, :site, now()
                  FROM orgs o
                  LEFT JOIN routing_directory rd
                         ON rd.key_type = 'org' AND rd.key_value = o.id::text
                 WHERE rd.key_value IS NULL
                 LIMIT :lim
                ON CONFLICT (key_type, key_value) DO NOTHING
                RETURNING key_value
                """
            ),
            {"site": site, "lim": limit},
        )
    ).all()
    for row in rows:
        await enqueue_event(
            conn,
            topic=TOPIC_ROUTING,
            kafka_key=row.key_value,
            event=routing_upserted(KEY_ORG, row.key_value, site),
        )
    return len(rows)


async def sweep_expired_invites(conn: AsyncConnection, *, limit: int = 500) -> int:
    """Publish a revoke for invites whose directory row has expired, and drop it.

    Without this the directory grows one row per invite ever minted, at every
    site, forever. Bounded per run so the sweep cannot become a long transaction
    that blocks the writes it shares tables with.
    """
    rows = (
        await conn.execute(
            text(
                """
                DELETE FROM routing_directory
                 WHERE (key_type, key_value) IN (
                       SELECT key_type, key_value FROM routing_directory
                        WHERE key_type = 'invite'
                          AND expires_at IS NOT NULL
                          AND expires_at < now()
                        LIMIT :lim
                 )
                RETURNING key_value
                """
            ),
            {"lim": limit},
        )
    ).all()
    for row in rows:
        from .events import routing_revoked

        await enqueue_event(
            conn,
            topic=TOPIC_ROUTING,
            kafka_key=row.key_value,
            event=routing_revoked(row.key_value, "expired"),
        )
    return len(rows)
