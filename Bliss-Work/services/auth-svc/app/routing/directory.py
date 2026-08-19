"""Reading and writing the local routing directory.

Thin on purpose: the decisions live in policy.py and decision.py, and this is
the SQL that feeds them. Every read here is local and keyed on the primary key —
the request path is not allowed to be slower than one index lookup, and it is
never allowed to leave the site.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .decision import DirectoryEntry
from .events import CapacityReport, DirectoryUpsert
from .policy import SiteCapacity


async def lookup(conn: AsyncConnection, key_type: str, key_value: str) -> DirectoryEntry | None:
    """The one read on the request path.

    Caller must have set the RLS bypass (routing_directory has no org policy —
    see 0012 — but the connection may still be pinned to an org from an earlier
    statement, and this lookup is deliberately cross-org).
    """
    row = (
        await conn.execute(
            text(
                """
                SELECT key_type, key_value, home_site, expires_at, revoked_at
                FROM routing_directory
                WHERE key_type = :kt AND key_value = :kv
                """
            ),
            {"kt": key_type, "kv": key_value},
        )
    ).first()
    if row is None:
        return None
    return DirectoryEntry(
        key_type=row.key_type,
        key_value=row.key_value,
        home_site=row.home_site,
        expires_at=_utc(row.expires_at),
        revoked_at=_utc(row.revoked_at),
    )


async def upsert_local(
    conn: AsyncConnection,
    *,
    key_type: str,
    key_value: str,
    home_site: str,
    expires_at: datetime | None,
    occurred_at: datetime,
) -> None:
    """Write the row this site is authoritative for.

    Called in the SAME transaction as the placement or the invite insert, next to
    the outbox row that publishes it. Local write and remote publish are then
    atomic together: there is no state where an org exists with no directory
    entry, or where peers were told about a placement this site did not make.
    """
    await _apply_upsert(conn, key_type, key_value, home_site, expires_at, occurred_at)


async def apply_event(conn: AsyncConnection, upsert: DirectoryUpsert) -> None:
    """Apply one replicated routing event from a peer site.

    Idempotent and order-insensitive: `updated_at` carries the event's
    occurredAt and an older event never overwrites a newer one, so a replay, a
    redelivery, or a revoke that arrives before its own upsert all converge.
    """
    if upsert.revoked:
        # A revoke names no site — it says only "this key no longer applies" —
        # so the row keeps whichever home it had. Written as an insert too, in
        # case the revoke overtakes the upsert it belongs to: the row is then
        # created already-revoked and the late upsert is rejected as older.
        await conn.execute(
            text(
                """
                INSERT INTO routing_directory
                    (key_type, key_value, home_site, revoked_at, updated_at)
                VALUES (:kt, :kv, '', :at, :at)
                ON CONFLICT (key_type, key_value) DO UPDATE
                   SET revoked_at = EXCLUDED.revoked_at,
                       updated_at = EXCLUDED.updated_at
                 WHERE routing_directory.updated_at <= EXCLUDED.updated_at
                """
            ),
            {"kt": upsert.key_type, "kv": upsert.key_value, "at": upsert.occurred_at},
        )
        return
    await _apply_upsert(
        conn,
        upsert.key_type,
        upsert.key_value,
        upsert.home_site,
        upsert.expires_at,
        upsert.occurred_at,
    )


async def _apply_upsert(
    conn: AsyncConnection,
    key_type: str,
    key_value: str,
    home_site: str,
    expires_at: datetime | None,
    occurred_at: datetime,
) -> None:
    await conn.execute(
        text(
            """
            INSERT INTO routing_directory
                (key_type, key_value, home_site, expires_at, updated_at)
            VALUES (:kt, :kv, :site, :exp, :at)
            ON CONFLICT (key_type, key_value) DO UPDATE
               SET home_site  = EXCLUDED.home_site,
                   expires_at = EXCLUDED.expires_at,
                   updated_at = EXCLUDED.updated_at
             WHERE routing_directory.updated_at <= EXCLUDED.updated_at
            """
        ),
        {"kt": key_type, "kv": key_value, "site": home_site, "exp": expires_at, "at": occurred_at},
    )


# ── capacity ─────────────────────────────────────────────────────────────────


async def load_capacity(conn: AsyncConnection) -> dict[str, SiteCapacity]:
    """Every site's last reported position. One small local read on the signup
    path — deliberately not a cross-site query."""
    rows = (
        await conn.execute(
            text("SELECT site, used_bytes, ceiling_bytes, reported_at FROM site_capacity")
        )
    ).all()
    return {
        r.site: SiteCapacity(
            site=r.site,
            used_bytes=int(r.used_bytes),
            ceiling_bytes=int(r.ceiling_bytes),
            reported_at=_utc(r.reported_at) or datetime.fromtimestamp(0, timezone.utc),
        )
        for r in rows
    }


async def apply_capacity(conn: AsyncConnection, report: CapacityReport) -> None:
    """Record a site's report, ignoring one that is older than what we hold."""
    await conn.execute(
        text(
            """
            INSERT INTO site_capacity (site, used_bytes, ceiling_bytes, reported_at)
            VALUES (:site, :used, :ceiling, :at)
            ON CONFLICT (site) DO UPDATE
               SET used_bytes    = EXCLUDED.used_bytes,
                   ceiling_bytes = EXCLUDED.ceiling_bytes,
                   reported_at   = EXCLUDED.reported_at,
                   updated_at    = now()
             WHERE site_capacity.reported_at <= EXCLUDED.reported_at
            """
        ),
        {
            "site": report.site,
            "used": report.used_bytes,
            "ceiling": report.ceiling_bytes,
            "at": report.occurred_at,
        },
    )


def _utc(value: datetime | None) -> datetime | None:
    """Postgres hands back naive datetimes on some drivers; the decision layer
    compares against an aware `now`, and mixing the two raises."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
