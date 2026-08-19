"""Publishing this site's storage position so every peer can place orgs.

Placement compares sites. Comparing them by querying them would put a cross-site
round trip on the signup path — and make signup fail whenever a remote site is
unreachable — which is the one thing the design rules out. So each site reports
its own position onto the bridged routing topic, every site keeps a local copy,
and placement is always a local read.

Reports go through the OUTBOX, not straight to Kafka: the outbox poller already
owns delivery, retries and dead-lettering, and a second producer here would be a
second thing to get wrong.
"""
from __future__ import annotations

import asyncio

from sqlalchemy import text

from ..config import settings
from ..db import engine
from ..events.outbox import enqueue_event
from ..logging_config import log
from . import directory
from .events import TOPIC_ROUTING, CapacityReport, site_capacity_reported

GB = 1 << 30


class CapacityReporter:
    """Periodically measures local storage and publishes it."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="capacity-reporter")
        log.info("capacity_reporter_started", site=settings.site_id)

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self) -> None:
        # Orgs that predate the directory have no routing row and would be
        # unroutable at every site — including their own. Only the site holding
        # the data can say so, so each site backfills its own on the way up.
        # Idempotent and bounded, so it drains over a few ticks on a large
        # deployment rather than in one long transaction.
        try:
            await self.backfill_once()
        except Exception as err:  # noqa: BLE001 — never block the reporter
            log.warning("routing_backfill_failed", err=str(err))

        # Report IMMEDIATELY at startup, then on the interval. Placement fails
        # closed when no site is reporting, so a fresh deployment must publish
        # its own row within seconds of boot rather than after the first
        # interval — otherwise the very first signup is refused.
        while not self._stop.is_set():
            try:
                await self.report_once()
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 — a failed report is not fatal
                log.warning("capacity_report_failed", err=str(err))
            try:
                await asyncio.wait_for(
                    self._stop.wait(), timeout=settings.site_capacity_report_seconds
                )
            except asyncio.TimeoutError:
                continue

    async def backfill_once(self) -> int:
        """One bounded pass of the pre-directory org backfill."""
        from .placement import backfill_local_orgs

        async with engine.begin() as conn:
            from .. import service

            await service.set_bypass_rls(conn)
            placed = await backfill_local_orgs(conn, site=settings.site_id)
        if placed:
            log.info("routing_backfill", orgs=placed, site=settings.site_id)
        return placed

    async def report_once(self) -> None:
        """Measure, record locally, and enqueue the event for every peer."""
        ceiling = settings.site_storage_ceiling_gb * GB
        async with engine.begin() as conn:
            from .. import service

            await service.set_bypass_rls(conn)
            used = await _measure_bytes(conn)
            event = site_capacity_reported(settings.site_id, used, ceiling)
            # Written locally as well as published: this site's placement
            # decisions must not depend on its own event making the round trip
            # through Kafka and back.
            await directory.apply_capacity(
                conn,
                CapacityReport(
                    site=settings.site_id,
                    used_bytes=used,
                    ceiling_bytes=ceiling,
                    occurred_at=_parsed(event["occurredAt"]),
                ),
            )
            await enqueue_event(
                conn, topic=TOPIC_ROUTING, kafka_key=settings.site_id, event=event
            )
        pct = (used / ceiling * 100) if ceiling > 0 else 100.0
        log.info("capacity_reported", site=settings.site_id, used_gb=round(used / GB, 1), pct=round(pct, 1))


async def _measure_bytes(conn) -> int:
    """How much storage this site is using.

    `pg_database_size` of the connected database is a PROXY, and an honest one
    to name: it measures this service's own database, not the site's total
    footprint across every service and every volume. It is the number this
    process can actually see without new infrastructure, it moves in the right
    direction, and it is what the ceiling is compared against.

    A deployment with a real infrastructure metric should feed that in instead —
    the shape of the event is already right, and only this function changes.
    """
    row = (
        await conn.execute(text("SELECT pg_database_size(current_database()) AS bytes"))
    ).first()
    return int(row.bytes) if row is not None else 0


def _parsed(iso: str):
    from datetime import datetime, timezone

    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)
