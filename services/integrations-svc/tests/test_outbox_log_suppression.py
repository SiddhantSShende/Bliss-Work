"""A broker outage must not produce one traceback per backoff tick.

Observed in prod during a Kafka-down drill: the poller retried correctly but
logged a full multi-line ERROR traceback on every attempt. The backoff exists
to keep an outage quiet; the logging undid that. First failure keeps its
traceback (that's the diagnostic), repeats collapse to a one-line warning every
_FAILURE_LOG_EVERY-th attempt, and recovery is stated once.
"""
from __future__ import annotations

import pytest

outbox = pytest.importorskip(
    "app.outbox",
    reason="integrations-svc deps not installed locally; CI installs requirements.txt.",
)


class _RecordingLog:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def _record(self, level):
        def inner(event, **kw):
            self.calls.append((level, event))

        return inner

    def __getattr__(self, name):
        return self._record(name)

    def counts(self, level: str) -> int:
        return sum(1 for lvl, _ in self.calls if lvl == level)


@pytest.fixture
def rec(monkeypatch):
    r = _RecordingLog()
    monkeypatch.setattr(outbox, "log", r)
    return r


async def _run_failing(poller, monkeypatch, failures: int):
    """Drive _run through `failures` failed drains, then one that succeeds."""
    state = {"n": 0}

    async def _drain_once():
        state["n"] += 1
        if state["n"] <= failures:
            raise OSError("broker not up yet")
        poller._stop.set()  # one success, then fall out of the loop
        return 0

    monkeypatch.setattr(poller, "_drain_once", _drain_once)

    # Collapse the backoff sleeps so the test doesn't wait the real ~minutes.
    # Close the coroutine we're not awaiting, or asyncio warns about it.
    async def _instant(aw, timeout):
        aw.close()

    monkeypatch.setattr(outbox.asyncio, "wait_for", _instant)
    await poller._run()


async def test_first_failure_logs_a_traceback_then_suppresses(rec, monkeypatch):
    poller = outbox.OutboxPoller()
    await _run_failing(poller, monkeypatch, failures=9)

    # 9 consecutive failures: 1 traceback (exception) + 0 warnings — the second
    # line only lands on the 10th.
    assert rec.counts("exception") == 1, rec.calls
    assert rec.counts("warning") == 0, rec.calls


async def test_tenth_failure_logs_one_warning_not_a_traceback(rec, monkeypatch):
    poller = outbox.OutboxPoller()
    await _run_failing(poller, monkeypatch, failures=25)

    # 25 failures → 1 traceback, plus warnings at #10 and #20. Not 25 tracebacks.
    assert rec.counts("exception") == 1, rec.calls
    assert rec.counts("warning") == 2, rec.calls


async def test_recovery_is_logged_once(rec, monkeypatch):
    poller = outbox.OutboxPoller()
    await _run_failing(poller, monkeypatch, failures=3)

    recovered = [e for lvl, e in rec.calls if e == "outbox_poll_recovered"]
    assert recovered == ["outbox_poll_recovered"], rec.calls
