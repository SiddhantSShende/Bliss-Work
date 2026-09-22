"""The offline gate: check presence, wait only if needed, check again.

It used to compare the event's age to the threshold and, for anything younger,
mark the email 'sent' without sending it. Events reach the consumer within
milliseconds of occurring, so nearly every one was skipped for good: offline
notification email went out only when the consumer was already a minute behind.

The window is waited out (inside the in-flight guard, so the reaper leaves the
claim alone) — but ONLY when presence, checked FIRST, says the recipient is
offline right now. An already-online recipient used to pay the same wait
before this fix, which throttled this (the highest-volume) topic's batch
processing for everyone behind it regardless of whether they were even the
one being waited for. Presence is checked again after the wait, since the
recipient may have reconnected during it.

Runs the real `_handle`; only the database, presence, mailer and clock-sleep are faked.
"""
from __future__ import annotations

import json
import types
from datetime import datetime, timedelta, timezone

import pytest

from app.relay_consumer import RelayConsumer

THRESHOLD = 60


def _settings() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit", smtp_port=1025, smtp_from="no-reply@test.local",
        smtp_username="", smtp_password="", smtp_starttls=False,
        redis_url="redis://localhost:6379/0", relay_max_concurrency=4,
        poison_max_failures=3, dlq_topic="email-worker-dlq",
        offline_threshold_seconds=THRESHOLD,
    )


def _iso(seconds_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).isoformat()


def _event(seconds_ago: float) -> bytes:
    return json.dumps({
        "type": "message.created", "eventId": "evt-1", "senderId": "sender",
        "recipientId": "alice", "occurredAt": _iso(seconds_ago),
    }).encode()


class _Presence:
    def __init__(self, online: bool = False):
        self.online = online
        self.checks = 0

    async def is_online(self, _user):
        self.checks += 1
        return self.online


class _Harness:
    """A RelayConsumer whose edges are recorded instead of performed."""

    def __init__(self, *, online=False):
        self.c = RelayConsumer(_settings())
        self.presence = _Presence(online)
        self.sent: list[str] = []
        self.marked_sent: list[str] = []
        self.released: list[str] = []
        self.touched: list[str] = []
        self.waits: list[float] = []
        self.on_wait = None
        c = self.c
        c._presence = self.presence

        async def _claim(*_a):
            return True

        async def _send_for_event(_event, recipient, _etype):
            self.sent.append(recipient)

        async def _mark_sent(_event_id, recipient):
            self.marked_sent.append(recipient)
            return True

        async def _release_claim(_event_id, recipient):
            self.released.append(recipient)

        async def _touch_claim(_event_id, recipient):
            self.touched.append(recipient)

        async def _sleep_or_stop(seconds):
            self.waits.append(seconds)
            if self.on_wait:
                self.on_wait()

        c._claim = _claim
        c._send_for_event = _send_for_event
        c._mark_sent = _mark_sent
        c._release_claim = _release_claim
        c._touch_claim = _touch_claim
        c._sleep_or_stop = _sleep_or_stop


async def test_a_fresh_event_for_an_offline_user_is_emailed_after_the_grace_window():
    h = _Harness(online=False)

    ok = await h.c._handle(_event(seconds_ago=1))

    assert ok is True
    assert len(h.waits) == 1 and THRESHOLD - 5 < h.waits[0] <= THRESHOLD, "waited out what was left of the window"
    assert h.sent == ["alice"], "and then sent — not skipped"
    assert h.marked_sent == ["alice"]


async def test_a_user_who_comes_online_during_the_window_is_not_emailed():
    h = _Harness(online=False)
    h.on_wait = lambda: setattr(h.presence, "online", True)  # they open the app while we wait

    ok = await h.c._handle(_event(seconds_ago=1))

    assert ok is True
    assert h.sent == []
    assert h.marked_sent == ["alice"], "skipped for good: they saw it live"


async def test_an_event_already_older_than_the_window_goes_out_without_waiting():
    h = _Harness(online=False)

    await h.c._handle(_event(seconds_ago=THRESHOLD * 5))  # e.g. a consumer catching up on a backlog

    assert h.waits == []
    assert h.sent == ["alice"]


async def test_a_user_who_is_online_is_never_emailed_and_the_event_is_not_retried():
    h = _Harness(online=True)

    ok = await h.c._handle(_event(seconds_ago=THRESHOLD * 5))

    assert ok is True and h.sent == [] and h.marked_sent == ["alice"]


async def test_an_online_recipient_skips_the_wait_entirely_even_for_a_fresh_event():
    """The presence-ordering fix, proven where it actually matters: with an OLD
    event wait=0 anyway (see the test above), so that case alone can't tell
    "checked first" apart from "waited then checked and it just happened to be
    zero". A FRESH event is the one that used to pay the full grace window
    regardless of presence — checking first must skip it entirely here."""
    h = _Harness(online=True)

    ok = await h.c._handle(_event(seconds_ago=1))

    assert ok is True
    assert h.waits == [], "an already-online recipient must never wait"
    assert h.sent == []
    assert h.marked_sent == ["alice"]
    assert h.presence.checks == 1, "one check is enough to know they're already online"


async def test_presence_is_checked_again_after_the_wait_not_assumed_from_before():
    h = _Harness(online=False)

    await h.c._handle(_event(seconds_ago=1))

    assert h.presence.checks == 2, "once up front, once more after the wait — not reused"


async def test_the_claim_is_touched_after_a_real_wait_so_the_reaper_measures_from_there():
    h = _Harness(online=False)

    await h.c._handle(_event(seconds_ago=1))

    assert h.touched == ["alice"], (
        "resets the reaper's abandonment clock once the wait — the one phase "
        "not otherwise covered by _REAP_SEND_BUDGET_SECONDS — is over"
    )


async def test_no_wait_means_no_touch_needed():
    h = _Harness(online=False)

    await h.c._handle(_event(seconds_ago=THRESHOLD * 5))  # window already used up

    assert h.touched == [], "the original claim timestamp is still fresh; nothing to refresh"


async def test_shutdown_during_the_wait_releases_the_claim_and_does_not_skip_the_email():
    h = _Harness(online=False)
    h.on_wait = h.c._stop.set

    ok = await h.c._handle(_event(seconds_ago=1))

    assert ok is False, "not done: the offset must not advance past an unsent email"
    assert h.sent == [] and h.marked_sent == []
    assert h.released == ["alice"], "so the redelivery after the restart can claim and send it"


@pytest.mark.parametrize(
    "occurred_at, expected",
    [
        (_iso(0), (THRESHOLD - 1, THRESHOLD)),
        (_iso(20), (THRESHOLD - 21, THRESHOLD - 19)),
        (_iso(THRESHOLD), (0, 0)),
        (_iso(THRESHOLD * 10), (0, 0)),
        ("", (0, 0)),
        ("not a timestamp", (0, 0)),
        (_iso(-3600), (THRESHOLD, THRESHOLD)),  # stamped an hour in the future: clock skew
    ],
)
def test_grace_remaining(occurred_at, expected):
    remaining = RelayConsumer(_settings())._grace_remaining(occurred_at)

    assert expected[0] <= remaining <= expected[1]
