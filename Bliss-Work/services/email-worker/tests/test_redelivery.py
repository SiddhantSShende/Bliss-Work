"""A failed batch must be genuinely redelivered, and the retry must be able to send.

Both email consumers left a failed batch uncommitted and carried on, on the
strength of "Kafka redelivers and we retry". It does not: the fetch position has
already moved past the batch, so the NEXT batch's commit carried the offset past
the message that failed — an invite, a password reset or a user's own outbound
mail lost for good. Rewinding the partition is what makes the retry real.

The relay has a second half. A failed send left its own 'pending' claim behind, so
the redelivery found it, returned without sending, and waited for the reaper —
which flips a stale 'pending' row to 'sent' WITHOUT sending. The failed attempt
must release its claim so the retry can send.

Pure-logic: no Kafka, no database.
"""
from __future__ import annotations

import types

import pytest

from app import relay_consumer, worker
from app.relay_consumer import RelayConsumer
from app.worker import EmailWorker


def _settings(poison_max_failures: int = 3) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit", smtp_port=1025, smtp_from="no-reply@test.local",
        smtp_username="", smtp_password="", smtp_starttls=False,
        redis_url="redis://localhost:6379/0", relay_max_concurrency=4,
        poison_max_failures=poison_max_failures, dlq_topic="email-worker-dlq",
    )


class _Msg:
    def __init__(self, value, offset):
        self.value = value
        self.offset = offset
        self.topic = "messaging.events.v1"
        self.headers = ()


class _SeekableConsumer:
    """One partition. getmany() serves from the current position to the end (like a
    real fetch); seek() puts the position back."""

    def __init__(self, messages):
        self.messages = messages
        self.pos = 0
        self.commits = 0
        self.seeks: list[tuple[str, int]] = []
        self.on_done = None

    async def getmany(self, timeout_ms=0, max_records=None):
        if self.pos >= len(self.messages):
            if self.on_done is not None:
                self.on_done()
            return {}
        batch = {"tp": self.messages[self.pos :]}
        self.pos = len(self.messages)
        return batch

    async def commit(self):
        self.commits += 1

    def seek(self, partition, offset):
        self.seeks.append((partition, offset))
        self.pos = offset


def _messages(*names):
    return [_Msg(n, offset=i) for i, n in enumerate(names)]


@pytest.fixture(autouse=True)
def _no_pause(monkeypatch):
    monkeypatch.setattr(relay_consumer, "_RETRY_BACKOFF", 0)
    monkeypatch.setattr(worker, "_RETRY_BACKOFF", 0)


# ── the rewind, in both consumers ───────────────────────────────────────────


async def _run_loop(consumer_obj, handle_attr, fake):
    handled: list[str] = []
    failures = {"boom": 1}  # fails once, then succeeds

    async def _handle(raw):
        handled.append(raw)
        if failures.get(raw, 0) > 0:
            failures[raw] -= 1
            return False
        return True

    fake.on_done = consumer_obj._stop.set
    setattr(consumer_obj, handle_attr, _handle)
    await consumer_obj._consume_loop(fake)
    return handled


async def test_the_relay_rewinds_a_failed_batch_and_commits_only_after_the_retry():
    fake = _SeekableConsumer(_messages("a", "boom", "c"))

    handled = await _run_loop(RelayConsumer(_settings()), "_handle", fake)

    assert fake.seeks == [("tp", 0)], "rewound to the first message of the failed batch"
    assert handled == ["a", "boom", "c", "a", "boom", "c"], "the whole batch is re-read"
    assert fake.commits == 1, "committed once, after the retry succeeded — never after the failure"


async def test_the_invite_and_reset_worker_rewinds_a_failed_batch_the_same_way():
    fake = _SeekableConsumer(_messages("a", "boom", "c"))

    handled = await _run_loop(EmailWorker(_settings()), "_handle_message", fake)

    assert fake.seeks == [("tp", 0)]
    assert handled == ["a", "boom", "c", "a", "boom", "c"]
    assert fake.commits == 1


async def test_a_clean_batch_is_committed_without_a_rewind():
    fake = _SeekableConsumer(_messages("a", "b"))

    await _run_loop(RelayConsumer(_settings()), "_handle", fake)

    assert fake.seeks == [] and fake.commits == 1


# ── the relay releases its own claim so the retry can send ──────────────────


class _RecordingConn:
    def __init__(self):
        self.executed: list[tuple[str, tuple]] = []

    async def execute(self, sql, *args):
        self.executed.append((" ".join(sql.split()), args))
        return "DELETE 1"


class _Pool:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        return self

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


def _relay_with_db(poison_max_failures: int = 3):
    c = RelayConsumer(_settings(poison_max_failures))
    conn = _RecordingConn()
    c._db = _Pool(conn)
    return c, conn


async def test_a_retryable_failure_releases_the_claim_so_the_redelivery_can_send():
    c, conn = _relay_with_db()

    done = await c._retry_or_dlq("evt-1", "user-1", {"eventId": "evt-1"}, "smtp down")

    assert done is False, "below the poison threshold the message is retried"
    assert len(conn.executed) == 1
    sql, args = conn.executed[0]
    assert sql.startswith("DELETE FROM email_consumed") and args == ("evt-1", "user-1")
    # Only this consumer's still-unsent claim: never a 'sent' row, never the invite worker's.
    assert "state = 'pending'" in sql and "owner = 'relay'" in sql


async def test_a_message_routed_to_the_dlq_keeps_its_claim():
    c, conn = _relay_with_db(poison_max_failures=1)

    done = await c._retry_or_dlq("evt-2", "user-2", {"eventId": "evt-2"}, "smtp down")

    assert done is True, "at the threshold it goes to the DLQ and the offset moves on"
    assert conn.executed == [], "nothing to retry, so nothing to release"


async def test_no_claim_is_released_when_there_is_no_recipient_key():
    c, conn = _relay_with_db()

    await c._retry_or_dlq("evt-3", "", {"eventId": "evt-3"}, "bad event")

    assert conn.executed == []
