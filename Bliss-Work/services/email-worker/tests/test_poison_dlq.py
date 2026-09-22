"""Pure-logic tests for the poison-failure counter / DLQ threshold.

Both consumers keep an in-memory ``self._failures: dict[event_id, int]`` and run
the SAME ``_on_failure`` policy:

  * each consecutive failure for an ``event_id`` increments its counter;
  * BELOW ``poison_max_failures`` it returns ``False`` -> caller leaves the
    Kafka offset uncommitted so the event is redelivered and retried;
  * AT/ABOVE the threshold it publishes the event to the DLQ, clears the
    counter, and returns ``True`` -> the offset commits and the poison message
    stops looping.

This is the resilience invariant that prevents a single bad event from pinning
the consumer forever, so it is worth pinning with focused tests.

These tests drive the REAL ``_on_failure`` coroutine. To avoid any Kafka I/O we
replace ``_to_dlq`` on the instance with an in-memory recorder; everything else
(the counter map, the threshold comparison, the return value, the pop-on-DLQ) is
the genuine production code. ``conftest.py`` stubs the absent runtime deps so the
classes import and construct (the ``Mailer`` built in ``__init__`` only stores
config; no socket is opened).
"""
from __future__ import annotations

import asyncio
import types

import pytest

from app.relay_consumer import RelayConsumer
from app.worker import EmailWorker


def _settings(poison_max_failures: int) -> types.SimpleNamespace:
    """Minimal settings duck-type covering everything the two __init__'s read."""
    return types.SimpleNamespace(
        smtp_host="mailpit",
        smtp_port=1025,
        smtp_from="no-reply@test.local",
        smtp_username="",
        smtp_password="",
        smtp_starttls=False,
        redis_url="redis://localhost:6379/0",
        relay_max_concurrency=4,
        poison_max_failures=poison_max_failures,
    )


class _DlqRecorder:
    """Stand-in for ``_to_dlq`` that records calls instead of touching Kafka."""

    def __init__(self) -> None:
        self.calls: list[tuple[dict, str]] = []

    async def __call__(self, event: dict, error: str) -> None:
        self.calls.append((event, error))


def _make(consumer_cls, threshold: int):
    inst = consumer_cls(_settings(threshold))
    dlq = _DlqRecorder()
    inst._to_dlq = dlq  # type: ignore[method-assign]
    return inst, dlq


def _run(coro):
    return asyncio.run(coro)


# Both consumers share the identical _on_failure policy -> parametrize over both.
CONSUMERS = [RelayConsumer, EmailWorker]


@pytest.mark.parametrize("consumer_cls", CONSUMERS)
def test_below_threshold_returns_false_and_no_dlq(consumer_cls) -> None:
    inst, dlq = _make(consumer_cls, threshold=3)

    async def scenario() -> list[bool]:
        return [
            await inst._on_failure("evt-1", {"eventId": "evt-1"}, "boom"),
            await inst._on_failure("evt-1", {"eventId": "evt-1"}, "boom"),
        ]

    results = _run(scenario())
    assert results == [False, False]          # offset stays uncommitted -> retry
    assert inst._failures["evt-1"] == 2       # counter advanced
    assert dlq.calls == []                    # not poisoned yet


@pytest.mark.parametrize("consumer_cls", CONSUMERS)
def test_reaching_threshold_routes_to_dlq_and_returns_true(consumer_cls) -> None:
    inst, dlq = _make(consumer_cls, threshold=3)
    event = {"eventId": "evt-poison"}

    async def scenario() -> list[bool]:
        return [await inst._on_failure("evt-poison", event, "boom") for _ in range(3)]

    results = _run(scenario())
    assert results == [False, False, True]    # 3rd hit trips the DLQ + commit
    assert len(dlq.calls) == 1
    routed_event, routed_error = dlq.calls[0]
    assert routed_event is event
    assert routed_error == "boom"
    # Counter is cleared once the message is DLQ'd so a later same-id event
    # starts from a clean slate.
    assert "evt-poison" not in inst._failures


@pytest.mark.parametrize("consumer_cls", CONSUMERS)
def test_threshold_of_one_dlqs_on_first_failure(consumer_cls) -> None:
    inst, dlq = _make(consumer_cls, threshold=1)

    result = _run(inst._on_failure("evt-x", {"eventId": "evt-x"}, "boom"))
    assert result is True
    assert len(dlq.calls) == 1
    assert "evt-x" not in inst._failures


@pytest.mark.parametrize("consumer_cls", CONSUMERS)
def test_counters_are_independent_per_event_id(consumer_cls) -> None:
    inst, dlq = _make(consumer_cls, threshold=3)

    async def scenario() -> None:
        # Interleave failures for two different ids; neither should leak into
        # the other's counter or prematurely DLQ.
        await inst._on_failure("a", {"eventId": "a"}, "e")
        await inst._on_failure("b", {"eventId": "b"}, "e")
        await inst._on_failure("a", {"eventId": "a"}, "e")

    _run(scenario())
    assert inst._failures == {"a": 2, "b": 1}
    assert dlq.calls == []


@pytest.mark.parametrize("consumer_cls", CONSUMERS)
def test_failure_then_dlq_resets_so_redelivery_starts_fresh(consumer_cls) -> None:
    inst, dlq = _make(consumer_cls, threshold=2)
    event = {"eventId": "evt-r"}

    async def scenario() -> list[bool]:
        out = []
        out.append(await inst._on_failure("evt-r", event, "e"))  # 1 -> False
        out.append(await inst._on_failure("evt-r", event, "e"))  # 2 -> DLQ, True
        # Counter cleared; a brand-new failure for the same id starts at 1 again.
        out.append(await inst._on_failure("evt-r", event, "e"))  # 1 -> False
        return out

    results = _run(scenario())
    assert results == [False, True, False]
    assert len(dlq.calls) == 1                # only the threshold hit DLQ'd
    assert inst._failures["evt-r"] == 1
