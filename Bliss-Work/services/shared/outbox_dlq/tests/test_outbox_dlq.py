"""Unit tests for ``outbox_dlq``.

`payload_bytes` is pure and tested directly. `quarantine_oversize` and
`record_publish_failure` are tested against a fake connection that records the
statement + params it was called with — what matters here is that the right
SQL and params go out, not exercising real Postgres CASE/CTE semantics (those
are covered by the services' own DB-backed integration suites).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from outbox_dlq import (
    MAX_PUBLISH_ATTEMPTS,
    MAX_PUBLISH_BYTES,
    payload_bytes,
    quarantine_oversize,
    record_publish_failure,
)


def test_payload_bytes_of_a_dict_measures_the_encoded_json():
    n = payload_bytes({"a": 1})
    assert n == len(b'{"a": 1}')


def test_payload_bytes_of_a_string_measures_utf8_encoding():
    assert payload_bytes("héllo") == len("héllo".encode("utf-8"))


def test_payload_bytes_of_bytes_is_passthrough():
    assert payload_bytes(b"\x00\x01\x02") == 3


@dataclass
class FakeResult:
    _row: tuple | None = None

    def first(self):
        return self._row


@dataclass
class FakeConn:
    calls: list[tuple] = field(default_factory=list)
    quarantined_count: int = 0

    async def execute(self, stmt, params):
        self.calls.append((stmt, params))
        return FakeResult(_row=(self.quarantined_count,))


async def test_quarantine_oversize_is_a_noop_for_an_empty_list():
    conn = FakeConn()
    n = await quarantine_oversize(conn, [])
    assert n == 0
    assert conn.calls == []


async def test_quarantine_oversize_passes_ids_and_limit():
    conn = FakeConn()
    n = await quarantine_oversize(conn, ["a", "b"])
    assert n == 2
    (_, params), = conn.calls
    assert params == {"ids": ["a", "b"], "limit": MAX_PUBLISH_BYTES}


async def test_record_publish_failure_is_a_noop_for_an_empty_list():
    conn = FakeConn()
    n = await record_publish_failure(conn, [], RuntimeError("boom"))
    assert n == 0
    assert conn.calls == []


async def test_record_publish_failure_truncates_the_reason_and_passes_max_attempts():
    conn = FakeConn(quarantined_count=1)
    long_reason = "x" * 1000
    n = await record_publish_failure(conn, ["id-1"], RuntimeError(long_reason))
    assert n == 1
    (_, params), = conn.calls
    assert params["ids"] == ["id-1"]
    assert params["max_attempts"] == MAX_PUBLISH_ATTEMPTS
    assert len(params["reason"]) == 500


async def test_record_publish_failure_returns_zero_when_nothing_matched():
    conn = FakeConn(quarantined_count=0)
    n = await record_publish_failure(conn, ["id-1"], RuntimeError("transient"))
    assert n == 0
