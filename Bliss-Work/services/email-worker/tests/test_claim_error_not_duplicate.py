"""B-EW-1: a DB error in EmailWorker._claim must NOT look like "already sent".

_claim used to return False for BOTH "a 'sent' row exists" and "the claim query
raised". _handle_message read False as `duplicate_skipped` and returned True, so
the Kafka offset committed and a transient database blip permanently lost an
invite / password-reset / email-verification email. The claim is now tri-state
(claimed / duplicate / error) and an error returns False from _handle_message —
no send, no commit, the consume loop seeks back and retries.

Pure-logic: no Kafka, no database.
"""
from __future__ import annotations

import json
import types


from app import worker
from app.relay_consumer import RelayConsumer
from app.worker import EmailWorker, _Claim

EVENT_ID = "11111111-1111-1111-1111-111111111111"
USER_ID = "22222222-2222-2222-2222-222222222222"


def _settings() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit", smtp_port=1025, smtp_from="no-reply@test.local",
        smtp_username="", smtp_password="", smtp_starttls=False,
        redis_url="redis://localhost:6379/0", relay_max_concurrency=4,
        poison_max_failures=3, dlq_topic="email-worker-dlq",
    )


def _reset_event() -> bytes:
    return json.dumps({
        "type": "password.reset.requested", "eventId": EVENT_ID, "userId": USER_ID,
        "email": "user@example.com", "resetUrl": "https://x/reset?t=abc",
        "expiresAt": "2030-01-01T00:00:00Z",
    }).encode()


class _Conn:
    """fetchrow() behaves per `script`: an Exception instance is raised, anything
    else (None / a row) is returned. Each call pops the next entry (the last one
    repeats)."""

    def __init__(self, script):
        self.script = list(script)
        self.fetchrows = 0
        self.executes: list[str] = []

    async def fetchrow(self, *_a, **_kw):
        self.fetchrows += 1
        item = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(item, Exception):
            raise item
        return item

    async def execute(self, sql, *_a, **_kw):
        self.executes.append(" ".join(sql.split()))
        return "INSERT 0 1"


class _Pool:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        return self

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _FailingAcquirePool:
    def acquire(self):
        raise ConnectionError("pool cannot connect")


def _worker(conn_or_pool):
    w = EmailWorker(_settings())
    w._db = conn_or_pool if isinstance(conn_or_pool, _FailingAcquirePool) else _Pool(conn_or_pool)
    sent: list[dict] = []

    async def _send(**kw):
        sent.append(kw)

    w._mailer.send = _send  # type: ignore[method-assign]
    return w, sent


async def test_claim_distinguishes_claimed_duplicate_and_error():
    w, _ = _worker(_Conn([{"?column?": 1}]))
    assert await w._claim(EVENT_ID, USER_ID) is _Claim.CLAIMED
    w, _ = _worker(_Conn([None]))
    assert await w._claim(EVENT_ID, USER_ID) is _Claim.DUPLICATE
    w, _ = _worker(_Conn([ConnectionError("blip")]))
    assert await w._claim(EVENT_ID, USER_ID) is _Claim.ERROR


async def test_claim_error_when_the_pool_cannot_hand_out_a_connection():
    w, _ = _worker(_FailingAcquirePool())
    assert await w._claim(EVENT_ID, USER_ID) is _Claim.ERROR


async def test_a_db_error_on_claim_is_not_committed_and_sends_nothing():
    conn = _Conn([ConnectionError("blip")])
    w, sent = _worker(conn)

    ok = await w._handle_message(_reset_event())

    assert ok is False, "a DB blip must leave the offset uncommitted for retry"
    assert sent == []
    assert conn.executes == [], "nothing may be written as 'sent' either"
    assert w._failures == {}, "not the message's fault, so not counted toward the DLQ"


async def test_a_genuine_duplicate_is_still_skipped_and_committed():
    conn = _Conn([None])  # ON CONFLICT ... WHERE state='pending' matched nothing: row is 'sent'
    w, sent = _worker(conn)

    assert await w._handle_message(_reset_event()) is True
    assert sent == []


async def test_a_fresh_claim_still_sends_and_commits():
    conn = _Conn([{"?column?": 1}])
    w, sent = _worker(conn)

    assert await w._handle_message(_reset_event()) is True
    assert len(sent) == 1 and sent[0]["to"] == "user@example.com"


class _Msg:
    def __init__(self, value, offset):
        self.value, self.offset, self.topic, self.headers = value, offset, "auth.events", ()


class _Consumer:
    def __init__(self, msgs):
        self.msgs, self.pos, self.commits, self.seeks, self.on_done = msgs, 0, 0, [], None

    async def getmany(self, timeout_ms=0, max_records=None):
        if self.pos >= len(self.msgs):
            if self.on_done:
                self.on_done()
            return {}
        batch = {"tp": self.msgs[self.pos:]}
        self.pos = len(self.msgs)
        return batch

    async def commit(self):
        self.commits += 1

    def seek(self, tp, offset):
        self.seeks.append((tp, offset))
        self.pos = offset


async def test_end_to_end_a_claim_blip_is_retried_then_sent_exactly_once(monkeypatch):
    monkeypatch.setattr(worker, "_RETRY_BACKOFF", 0)
    # first claim attempt: DB error; second: fresh claim
    conn = _Conn([ConnectionError("blip"), {"?column?": 1}])
    w, sent = _worker(conn)
    consumer = _Consumer([_Msg(_reset_event(), 0)])
    consumer.on_done = w._stop.set

    await w._consume_loop(consumer)

    assert consumer.seeks == [("tp", 0)], "rewound after the failed claim"
    assert len(sent) == 1, "the email was not lost"
    assert consumer.commits == 1, "committed only after the retry succeeded"


# The relay consumer has its OWN claim; it must not conflate the same way.

async def test_relay_claim_error_is_never_treated_as_a_duplicate():
    """RelayConsumer._claim returns False on a DB error too, but its callers
    follow it with _is_sent(), which only answers True for a real 'sent' row, so
    an error falls through to `return False` (no commit). Pin that."""
    c = RelayConsumer(_settings())

    class _Boom:
        async def execute(self, *_a, **_kw):
            raise ConnectionError("blip")

        async def fetchrow(self, *_a, **_kw):
            raise ConnectionError("blip")

    c._db = _Pool(_Boom())
    event = {
        "type": "mail.outbound", "eventId": EVENT_ID, "mailId": USER_ID,
        "envelope": "to@example.com",
    }
    assert await c._handle(json.dumps(event).encode()) is False
