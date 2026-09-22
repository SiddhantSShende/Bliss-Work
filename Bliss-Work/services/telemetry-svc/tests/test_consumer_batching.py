"""Batched Kafka consumption.

This consumer used to process one message at a time — a session checkout, an
RLS GUC, a dedup INSERT, a row INSERT, a COMMIT and a synchronous offset commit
per event, on the five topics that carry every event in the product. It now
handles a whole fetch in one transaction.

Batching is an efficiency change, so the tests here are almost entirely about
the things that must NOT have changed: what gets written, in what order, and
whether the offsets are allowed to advance. The two that would be easy to get
wrong and hard to notice are `_a_control_event_flushes_the_rows_before_it`
(ordering) and `_a_transient_failure_does_not_advance_the_offsets` (a batch
that half-wrote and reported success would silently lose events).

PURE LOGIC: the database and Kafka are both fakes. What is actually being
exercised is the batching decision-making, not SQL — the SQL is covered by the
integration suite against a real Postgres.
"""
from __future__ import annotations

import uuid

import pytest

consumer = pytest.importorskip(
    "app.consumer",
    reason="telemetry-svc deps not installed locally; CI installs requirements.txt.",
)

ORG = str(uuid.uuid4())
ALICE = str(uuid.uuid4())


# ── fakes ────────────────────────────────────────────────────────────────────


class _Msg:
    """The handful of ConsumerRecord attributes the loop actually reads."""

    def __init__(self, value, offset=0, topic="messaging.events.v1"):
        self.value = value
        self.offset = offset
        self.topic = topic
        self.headers = ()


class _FakeDB:
    def __init__(self):
        self.committed = 0

    async def commit(self):
        self.committed += 1


class _Recorder:
    """Stands in for the module's session/claim/insert helpers.

    `writes` is a list of batches rather than a flat list of rows, because the
    number of transactions is exactly what these tests are about — a flush per
    row would pass every assertion about content and still be the bug.
    """

    def __init__(self, *, claim=None, insert_error=None):
        self.writes: list[list] = []
        self.purged: list[str] = []
        self._claim = claim
        self._insert_error = insert_error

    def install(self, monkeypatch):
        db = _FakeDB()

        class _Session:
            async def __aenter__(_self):
                return db

            async def __aexit__(_self, *exc):
                return False

        async def _claim_many(_db, event_ids):
            if self._claim is not None:
                return self._claim(event_ids)
            return set(event_ids)

        async def _insert_events(_db, rows):
            if self._insert_error is not None:
                raise self._insert_error
            self.writes.append(list(rows))
            return len(rows)

        async def _purge_org(org_id):
            self.purged.append(org_id)

        monkeypatch.setattr(consumer, "session", lambda: _Session())
        monkeypatch.setattr(consumer, "set_bypass_rls", _noop)
        monkeypatch.setattr(consumer, "_claim_many", _claim_many)
        monkeypatch.setattr(consumer, "insert_events", _insert_events)
        monkeypatch.setattr(consumer, "purge_org", _purge_org)
        return self


async def _noop(*_a, **_kw):
    return None


def _event(**kw):
    """A `message.created`, which maps to exactly one activity row."""
    base = {
        "eventId": str(uuid.uuid4()),
        "orgId": ORG,
        "type": "message.created",
        "senderId": ALICE,
        "conversationId": str(uuid.uuid4()),
        "occurredAt": "2026-08-17T09:00:00.000Z",
    }
    base.update(kw)
    return base


def _batch(*messages):
    """One fetch on one partition, in offset order."""
    return {"tp": [_Msg(m, offset=i) for i, m in enumerate(messages)]}


def test_malformed_kafka_bytes_are_skippable():
    assert consumer._deserialize_event(b"not-json") is None
    assert consumer._deserialize_event(b'{"type":"ok"}') == {"type": "ok"}


# ── the poison-message case ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_poison_event_id_does_not_take_the_batch_with_it(monkeypatch):
    """One malformed id must cost one event, not the whole fetch.

    `consumed_events.event_id` is a `uuid` column, so an eventId that is not a
    UUID used to raise a DataError. Per message that stalled one partition
    forever — the handler failed, the offset was never committed, and the same
    message came back. Inside a batch it would additionally take up to 199
    healthy events with it every time.
    """
    rec = _Recorder().install(monkeypatch)
    c = consumer.TelemetryConsumer()

    ok = await c._process_batch(
        _batch(
            _event(),
            _event(eventId="not-a-uuid"),
            _event(),
        )
    )

    assert ok is True, "a skippable message must not block the offsets"
    assert len(rec.writes) == 1, "the healthy events belong in ONE transaction"
    assert len(rec.writes[0]) == 2, "the poison event is skipped, the other two are not"


@pytest.mark.asyncio
async def test_unmapped_events_are_skipped_rather_than_failed(monkeypatch):
    """Most traffic on these five topics is not a timeline row.

    An event type with no entry in MAPPINGS is ordinary, not exceptional, so it
    must not look like a failure to the offset logic.
    """
    rec = _Recorder().install(monkeypatch)
    c = consumer.TelemetryConsumer()

    ok = await c._process_batch(_batch(_event(type="something.unmapped"), _event()))

    assert ok is True
    assert len(rec.writes[0]) == 1


# ── ordering ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_control_event_flushes_the_rows_before_it(monkeypatch):
    """`org.deleted` must still land between its neighbours.

    The purge empties the org's rows. Batching the rows around it without a
    flush would let rows that arrived BEFORE the delete be written AFTER it —
    resurrecting activity for a workspace that is gone. So a control event
    forces the pending batch out first, and only rows that genuinely follow it
    are written afterwards.
    """
    rec = _Recorder().install(monkeypatch)
    c = consumer.TelemetryConsumer()

    ok = await c._process_batch(
        _batch(
            _event(),
            {"eventId": str(uuid.uuid4()), "orgId": ORG, "type": "org.deleted"},
            _event(),
        )
    )

    assert ok is True
    assert rec.purged == [ORG]
    assert [len(w) for w in rec.writes] == [1, 1], (
        "the row before the purge and the row after it must be separate writes"
    )


# ── offsets ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_transient_failure_does_not_advance_the_offsets(monkeypatch):
    """A batch that cannot be written must report failure.

    This is the guarantee batching is most likely to break: returning True here
    would commit an offset past events that were never stored, and no
    redelivery would ever bring them back.
    """
    rec = _Recorder(insert_error=RuntimeError("database is gone")).install(monkeypatch)
    c = consumer.TelemetryConsumer()

    ok = await c._process_batch(_batch(_event(), _event()))

    assert ok is False
    assert rec.writes == []


@pytest.mark.asyncio
async def test_only_newly_claimed_events_are_written(monkeypatch):
    """Redelivery must write nothing the second time.

    `_claim_many` returns the ids this process won; anything already in
    consumed_events is dropped before the insert. A redelivered batch therefore
    costs one statement and writes no rows.
    """
    first = _event()
    second = _event()
    already_seen = {first["eventId"]}

    rec = _Recorder(
        claim=lambda ids: {i for i in ids if i not in already_seen}
    ).install(monkeypatch)
    c = consumer.TelemetryConsumer()

    ok = await c._process_batch(_batch(first, second))

    assert ok is True
    assert len(rec.writes[0]) == 1, "the already-claimed event must not be re-written"


@pytest.mark.asyncio
async def test_a_batch_of_only_duplicates_writes_nothing(monkeypatch):
    """The full-redelivery case: claimed nothing, so insert nothing.

    Worth its own test because `insert_events` on an empty list is a wasted
    round trip, and the guard that avoids it is easy to drop.
    """
    rec = _Recorder(claim=lambda _ids: set()).install(monkeypatch)
    c = consumer.TelemetryConsumer()

    ok = await c._process_batch(_batch(_event(), _event()))

    assert ok is True
    assert rec.writes == []


@pytest.mark.asyncio
async def test_a_non_dict_message_is_ignored(monkeypatch):
    """A deserialised value that is not an object cannot be an event."""
    rec = _Recorder().install(monkeypatch)
    c = consumer.TelemetryConsumer()

    ok = await c._process_batch(_batch("not-an-object", None, _event()))

    assert ok is True
    assert len(rec.writes[0]) == 1
