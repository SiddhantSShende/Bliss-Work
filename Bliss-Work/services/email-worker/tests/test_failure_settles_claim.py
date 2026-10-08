"""B-EW-3: a failed mail.outbound attempt must settle its dedup claim.

The SMTP-failure and "transport undecided" paths called `_on_failure` directly,
which counts the failure but never touched the 'pending' claim row. The Kafka
redelivery then found its own attempt's row, answered False WITHOUT counting it
or trying to send, and the partition sat there until the reaper deleted the row
(>= _REAP_SEND_BUDGET_SECONDS, 180 s) — one stalled partition per failed attempt.
A DLQ'd event had the mirror problem: its row stayed 'pending', so the next
rewind of a batch containing it stalled the same way and, once reaped, re-failed
and published it to the DLQ a second time.

The dedup table is modelled faithfully here (a claim conflicts with ANY existing
row; release deletes only pending; mark_sent is terminal) because the old code's
fault is invisible against a claim stub that always succeeds.
"""
from __future__ import annotations

import pytest

from tests.test_provider_transport import MAIL_ID, _consumer, _event


def _with_realistic_dedup(c) -> dict[tuple[str, str], str]:
    rows: dict[tuple[str, str], str] = {}

    async def _claim(event_id, recipient_id):
        if (event_id, recipient_id) in rows:
            return False
        rows[(event_id, recipient_id)] = "pending"
        return True

    async def _is_sent(event_id, recipient_id):
        return rows.get((event_id, recipient_id)) == "sent"

    async def _mark_sent(event_id, recipient_id):
        rows[(event_id, recipient_id)] = "sent"
        return True

    async def _release_claim(event_id, recipient_key):
        if rows.get((event_id, recipient_key)) == "pending":
            del rows[(event_id, recipient_key)]

    async def _touch_claim(*_a):
        return None

    c._claim, c._is_sent, c._mark_sent = _claim, _is_sent, _mark_sent  # noqa: SLF001
    c._release_claim, c._touch_claim = _release_claim, _touch_claim  # noqa: SLF001
    return rows


def _dlq_recorder(c) -> list[dict]:
    routed: list[dict] = []

    async def _to_dlq(event, error):
        routed.append(event)

    c._to_dlq = _to_dlq  # noqa: SLF001
    return routed


class _FailingMailer:
    def __init__(self) -> None:
        self.attempts = 0

    async def send(self, **_kw):
        self.attempts += 1
        raise RuntimeError("smtp connection refused")


@pytest.mark.asyncio
async def test_an_smtp_failure_is_retried_on_redelivery_not_parked_behind_the_reaper():
    c, _m, _t = _consumer()
    _with_realistic_dedup(c)
    dlq = _dlq_recorder(c)
    mailer = _FailingMailer()
    c._mailer = mailer  # noqa: SLF001
    raw = _event("partner@outside.test", primary=False, authorId="")  # no provider route: SMTP

    results = [await c._handle(raw) for _ in range(3)]  # noqa: SLF001

    assert results == [False, False, True]
    assert mailer.attempts == 3, "each redelivery really retried; none stalled on its own pending claim"
    assert len(dlq) == 1


@pytest.mark.asyncio
async def test_a_dead_lettered_event_leaves_a_terminal_claim_not_a_pending_one():
    c, _m, _t = _consumer()
    rows = _with_realistic_dedup(c)
    dlq = _dlq_recorder(c)
    mailer = _FailingMailer()
    c._mailer = mailer  # noqa: SLF001
    raw = _event("partner@outside.test", primary=False, authorId="")

    for _ in range(3):
        await c._handle(raw)  # noqa: SLF001
    (key,) = rows
    assert key[1] == MAIL_ID and rows[key] == "sent", "terminal, so the reaper has nothing to reclaim"

    # A rewound batch re-reading the dead-lettered event is a duplicate: no stall, no re-send, no second DLQ record.
    assert await c._handle(raw) is True  # noqa: SLF001
    assert mailer.attempts == 3 and len(dlq) == 1


@pytest.mark.asyncio
async def test_an_undecided_transport_is_counted_and_releases_its_claim():
    c, mailer, _t = _consumer()  # no transport recorded, and this copy is not the deciding one
    rows = _with_realistic_dedup(c)
    dlq = _dlq_recorder(c)
    raw = _event("blind@outside.test", primary=False)

    first = await c._handle(raw)  # noqa: SLF001
    assert first is False and rows == {}, "claim released so the redelivery can retry"

    assert await c._handle(raw) is False  # noqa: SLF001
    assert await c._handle(raw) is True  # noqa: SLF001
    assert len(dlq) == 1 and list(rows.values()) == ["sent"]
    assert mailer.sends == []
