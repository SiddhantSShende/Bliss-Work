"""B-AUTH-14: the routing consumer must never commit past an event it failed to apply.

It used to log `routing_event_skipped` on ANY exception — including a transient
database error — and then `commit()`, so one blip permanently lost an org/invite
routing row (an invite redemption then answered 503 until the invite expired).

Now: a malformed event, or one the database rejects outright, is skipped (logged
and counted); a transient failure is retried with backoff until it is written;
and a shutdown mid-retry returns without committing.

Pure logic: the engine and `directory` are stubbed, the consumer is a fake async
iterator. No Kafka or Postgres.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

consumer_mod = pytest.importorskip(
    "app.routing.consumer",
    reason="auth-svc deps (aiokafka) not installed locally; CI installs requirements.txt.",
)
from sqlalchemy.exc import DataError, DBAPIError, OperationalError  # noqa: E402

from app.routing.events import KEY_ORG, routing_upserted  # noqa: E402


class _Conn:
    async def execute(self, *_a, **_k):
        return None


class _FakeEngine:
    def begin(self):

        class _Ctx:
            async def __aenter__(self_inner):
                return _Conn()

            async def __aexit__(self_inner, *_exc):
                return False

        return _Ctx()


class _FakeKafka:
    """Async-iterable consumer that records commits."""

    def __init__(self, messages):
        self._messages = messages
        self.commits = 0

    def __aiter__(self):
        async def gen():
            for m in self._messages:
                yield m

        return gen()

    async def commit(self):
        self.commits += 1


def _msg(payload, offset=0):
    value = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return SimpleNamespace(value=value, offset=offset)


def _good(org="org-1"):
    return _msg(routing_upserted(KEY_ORG, org, "site-b"))


@pytest.fixture
def harness(monkeypatch):
    monkeypatch.setattr(consumer_mod, "engine", _FakeEngine())
    monkeypatch.setattr(consumer_mod, "_APPLY_RETRY_BASE_SECONDS", 0.001)
    monkeypatch.setattr(consumer_mod, "_APPLY_RETRY_MAX_SECONDS", 0.002)

    import app.service as service

    async def _bypass(_conn):
        return None

    monkeypatch.setattr(service, "set_bypass_rls", _bypass)
    applied: list[str] = []
    behaviour: list = []  # exceptions to raise on successive attempts

    async def _apply_event(_conn, decoded):
        if behaviour:
            raise behaviour.pop(0)
        applied.append(decoded.key_value)

    monkeypatch.setattr(consumer_mod.directory, "apply_event", _apply_event)
    return SimpleNamespace(applied=applied, behaviour=behaviour)


def _operational():
    return OperationalError("UPDATE routing_directory", {}, Exception("connection lost"))


async def test_a_transient_db_error_is_retried_and_only_then_committed(harness):
    harness.behaviour.extend([_operational(), _operational()])
    kafka = _FakeKafka([_good()])

    await consumer_mod.RoutingConsumer()._consume(kafka)

    assert harness.applied == ["org-1"], "the event must be written, not dropped"
    assert kafka.commits == 1


async def test_events_stay_in_order_while_one_is_being_retried(harness):
    harness.behaviour.append(_operational())
    kafka = _FakeKafka([_good("org-1"), _good("org-2")])

    await consumer_mod.RoutingConsumer()._consume(kafka)

    assert harness.applied == ["org-1", "org-2"]
    assert kafka.commits == 2


async def test_shutdown_during_a_retry_does_not_commit_the_unapplied_event(harness, monkeypatch):
    monkeypatch.setattr(consumer_mod, "_APPLY_RETRY_BASE_SECONDS", 30.0)
    monkeypatch.setattr(consumer_mod, "_APPLY_RETRY_MAX_SECONDS", 30.0)
    harness.behaviour.extend([_operational()] * 5)
    kafka = _FakeKafka([_good()])
    consumer = consumer_mod.RoutingConsumer()

    task = asyncio.create_task(consumer._consume(kafka))
    await asyncio.sleep(0.05)  # first attempt failed; now waiting out a 30 s backoff
    consumer._stop.set()
    await asyncio.wait_for(task, timeout=2)  # responsive: returns long before the backoff ends

    assert harness.applied == []
    assert kafka.commits == 0


@pytest.mark.parametrize("raw", [b"not json", b"[1, 2]", b"\xff\xfe", b"null"])
async def test_a_malformed_event_is_skipped_counted_and_committed(harness, raw):
    before = consumer_mod.SKIPPED.labels(reason="malformed")._value.get()
    kafka = _FakeKafka([_msg(raw), _good()])

    await consumer_mod.RoutingConsumer()._consume(kafka)

    assert consumer_mod.SKIPPED.labels(reason="malformed")._value.get() == before + 1
    assert harness.applied == ["org-1"], "a bad event must not block the ones behind it"
    assert kafka.commits == 2


async def test_an_event_the_database_rejects_is_skipped_not_retried_forever(harness):
    harness.behaviour.append(DataError("INSERT", {}, Exception("invalid input")))
    before = consumer_mod.SKIPPED.labels(reason="rejected_by_db")._value.get()
    kafka = _FakeKafka([_good("bad"), _good("org-2")])

    await consumer_mod.RoutingConsumer()._consume(kafka)

    assert consumer_mod.SKIPPED.labels(reason="rejected_by_db")._value.get() == before + 1
    assert harness.applied == ["org-2"]
    assert kafka.commits == 2


class _PgErr(Exception):
    """Stands in for asyncpg's exception: carries a SQLSTATE like the real one."""

    def __init__(self, sqlstate: str):
        super().__init__(sqlstate)
        self.sqlstate = sqlstate


async def test_a_bare_dbapi_error_with_a_data_sqlstate_is_skipped(harness):
    # asyncpg reports a bad uuid / invalid input as a bare DBAPIError (22xxx),
    # NOT sqlalchemy's DataError - it must still be classified as permanent.
    harness.behaviour.append(DBAPIError("INSERT", {}, _PgErr("22P02")))
    before = consumer_mod.SKIPPED.labels(reason="rejected_by_db")._value.get()
    kafka = _FakeKafka([_good("bad"), _good("org-2")])

    await consumer_mod.RoutingConsumer()._consume(kafka)

    assert consumer_mod.SKIPPED.labels(reason="rejected_by_db")._value.get() == before + 1
    assert harness.applied == ["org-2"]
    assert kafka.commits == 2


@pytest.mark.parametrize("state", ["40001", "08006", "57014", "53300"])
def test_transient_sqlstates_are_not_permanent(state):
    assert not consumer_mod._is_permanent_db_error(DBAPIError("INSERT", {}, _PgErr(state)))


@pytest.mark.parametrize("state", ["22P02", "22000", "23505", "23503"])
def test_data_and_integrity_sqlstates_are_permanent(state):
    assert consumer_mod._is_permanent_db_error(DBAPIError("INSERT", {}, _PgErr(state)))


async def test_an_unknown_event_type_is_committed_without_a_write(harness):
    kafka = _FakeKafka([_msg({"type": "something.new", "occurredAt": "2026-01-01T00:00:00Z"})])

    await consumer_mod.RoutingConsumer()._consume(kafka)

    assert harness.applied == []
    assert kafka.commits == 1
