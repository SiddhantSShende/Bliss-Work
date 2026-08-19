"""Telling somebody a site is filling up — always out of band.

Every function here is fire-and-forget by construction. A capacity warning is an
operational fact about the deployment; it is not part of creating an account,
and it must never be able to delay or fail one. The placement policy therefore
NAMES who should be told and this module dispatches it after the transaction has
committed, on a task nobody awaits.

The failure mode this rules out is specific and has happened to everyone: an
alert path wired synchronously into a write path, an SMTP server that stops
answering rather than refusing, and a signup endpoint that now takes 30 seconds
and times out — because a site was 81% full.
"""
from __future__ import annotations

import asyncio
from typing import Iterable

from ..logging_config import log
from .placement import NoCapacityError, alert_message, no_capacity_message
from .policy import SiteCapacity

# Alerts are deduplicated in-process for this long. A busy site would otherwise
# produce one notification per signup — which is a pager nobody reads by the
# second hour, and the fastest way to make a real warning invisible.
_ALERT_COOLDOWN_SECONDS = 900.0
_last_sent: dict[str, float] = {}


def notify_capacity_alerts(alerts: Iterable[SiteCapacity]) -> None:
    """Announce every site over the warning threshold. Returns immediately.

    Safe to call from a request handler AFTER its transaction has committed:
    nothing here awaits, nothing here raises into the caller, and a dispatch
    failure is logged rather than propagated.
    """
    for cap in alerts:
        if not _should_send(cap.site):
            continue
        _dispatch("capacity_warning", cap.site, alert_message(cap), pct=cap.pct)


def notify_ops_no_capacity(exhausted: NoCapacityError) -> None:
    """Page: signups are being refused because there is nowhere to place an org.

    Not rate-limited by site — there is no site — but still deduplicated, on a
    fixed key, so a burst of signups against a full deployment produces a page
    rather than a flood.
    """
    if not _should_send("__no_capacity__"):
        return
    _dispatch(
        "no_capacity",
        exhausted.worst.site if exhausted.worst else "none",
        no_capacity_message(exhausted.reason, exhausted.worst),
        pct=exhausted.worst.pct if exhausted.worst else 100.0,
    )


def _should_send(key: str) -> bool:
    now = asyncio.get_event_loop().time() if _loop_running() else 0.0
    last = _last_sent.get(key)
    if last is not None and (now - last) < _ALERT_COOLDOWN_SECONDS:
        return False
    _last_sent[key] = now
    return True


def _loop_running() -> bool:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def _dispatch(kind: str, site: str, message: str, *, pct: float) -> None:
    """Hand the alert to whatever this deployment uses.

    Logged at ERROR unconditionally, which is the one delivery mechanism that
    cannot itself fail: structured logs are already scraped and alertable, so a
    deployment with no webhook configured is still not silent. An outbound
    webhook (Slack/PagerDuty) rides on top as a background task whose failure is
    swallowed — it is a nicety, and the log line is the record.
    """
    log.error("site_capacity_alert", kind=kind, site=site, pct=round(pct, 1), detail=message)
    if not _loop_running():
        return
    # Fire-and-forget. The reference is dropped deliberately: awaiting it, or
    # holding it to await later, would put an external call back on the request
    # path — which is exactly what this module exists to prevent.
    task = asyncio.ensure_future(_deliver(kind, site, message))
    task.add_done_callback(_swallow)


async def _deliver(kind: str, site: str, message: str) -> None:
    """Outbound webhook, when one is configured.

    Deliberately minimal and deliberately last: the log line above is the
    guaranteed record, and this is the convenience on top of it.
    """
    from ..config import settings

    url = getattr(settings, "ops_alert_webhook_url", "")
    if not url:
        return
    import httpx

    async with httpx.AsyncClient(timeout=5.0) as client:
        await client.post(url, json={"kind": kind, "site": site, "text": message})


def _swallow(task: "asyncio.Future[None]") -> None:
    """Consume the task's exception so a failed webhook is not an unhandled
    rejection in the logs of a request that succeeded."""
    if task.cancelled():
        return
    err = task.exception()
    if err is not None:
        log.warning("site_capacity_alert_delivery_failed", err=str(err))
