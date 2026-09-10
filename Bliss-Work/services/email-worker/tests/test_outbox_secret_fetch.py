"""Tests for the Phase 3 outbox-secret pull path (see
docs/AUTH_AUTHZ_REMEDIATION_PLAN.md).

Kafka no longer carries the raw password-reset/email-verify/invite URL —
``worker.py`` pulls it from auth-svc's internal endpoint by ``outboxId``
instead. These tests drive the REAL ``_fetch_outbox_event`` and ``_to_dlq``
coroutines against fake HTTP/Kafka clients (no network, no broker), covering:

  * a 200 response is returned as-is;
  * a 404 (permanent — row gone/redacted/wrong type) returns None rather than
    raising, so the caller can mark the event handled instead of retrying;
  * a 5xx (transient) raises, so the caller leaves the Kafka offset
    uncommitted and lets redelivery retry;
  * a poison message that reached _to_dlq AFTER a successful fetch never
    carries the raw secret onto the DLQ topic.
"""
from __future__ import annotations

import json
import types

import pytest

from app.worker import EmailWorker


def _settings() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit",
        smtp_port=1025,
        smtp_from="no-reply@test.local",
        smtp_username="",
        smtp_password="",
        smtp_starttls=False,
        redis_url="redis://localhost:6379/0",
        poison_max_failures=3,
        auth_internal_base="http://auth-svc:8001",
        auth_internal_token="test-internal-token",
        dlq_topic="email-worker-dlq",
    )


class _FakeResponse:
    def __init__(self, status_code: int, json_body: dict | None = None) -> None:
        self.status_code = status_code
        self._json = json_body or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict:
        return self._json


class _FakeHttpClient:
    def __init__(self, response: _FakeResponse) -> None:
        self._response = response
        self.calls: list[tuple[str, dict]] = []

    async def get(self, url: str, headers: dict | None = None) -> _FakeResponse:
        self.calls.append((url, headers or {}))
        return self._response


class _FakeProducer:
    def __init__(self) -> None:
        self.sent: list[tuple[str, bytes]] = []

    async def send_and_wait(self, topic: str, value: bytes, headers=None) -> None:
        self.sent.append((topic, value))


def _worker_with_http(response: _FakeResponse) -> tuple[EmailWorker, _FakeHttpClient]:
    worker = EmailWorker(_settings())
    fake_http = _FakeHttpClient(response)
    worker._http = fake_http  # type: ignore[assignment]
    return worker, fake_http


async def test_fetch_outbox_event_returns_payload_on_200() -> None:
    payload = {
        "type": "password.reset.requested",
        "userId": "u1",
        "email": "a@b.test",
        "resetUrl": "https://app.test/reset?token=SUPER-SECRET",
        "expiresAt": "2026-01-01T00:00:00.000Z",
    }
    worker, fake_http = _worker_with_http(_FakeResponse(200, payload))

    result = await worker._fetch_outbox_event("outbox-id-1")

    assert result == payload
    url, headers = fake_http.calls[0]
    assert url == "http://auth-svc:8001/internal/outbox-events/outbox-id-1"
    assert headers["X-Internal-Token"] == "test-internal-token"


async def test_fetch_outbox_event_returns_none_on_404() -> None:
    """404 is PERMANENT — the caller marks the event handled, never retries."""
    worker, _fake_http = _worker_with_http(_FakeResponse(404))

    result = await worker._fetch_outbox_event("gone")

    assert result is None


async def test_fetch_outbox_event_raises_on_5xx() -> None:
    """5xx is TRANSIENT — must propagate so the offset stays uncommitted."""
    worker, _fake_http = _worker_with_http(_FakeResponse(500))

    with pytest.raises(RuntimeError):
        await worker._fetch_outbox_event("broker-down")


async def test_dlq_never_carries_the_raw_secret_url() -> None:
    """A poison message that reached the DLQ AFTER a successful fetch (e.g. an
    SMTP failure on send) must not leak the fetched raw URL onto Kafka — the
    DLQ topic has the same no-ACL exposure as every other topic."""
    worker = EmailWorker(_settings())
    fake_producer = _FakeProducer()
    worker._producer = fake_producer  # type: ignore[assignment]

    fetched_event = {
        "eventId": "evt-1",
        "type": "password.reset.requested",
        "userId": "u1",
        "email": "a@b.test",
        "resetUrl": "https://app.test/reset?token=SUPER-SECRET",
        "expiresAt": "2026-01-01T00:00:00.000Z",
    }

    await worker._to_dlq(fetched_event, "smtp connection refused")

    assert len(fake_producer.sent) == 1
    _topic, raw_value = fake_producer.sent[0]
    envelope = json.loads(raw_value)
    assert "resetUrl" not in envelope["event"]
    assert "SUPER-SECRET" not in raw_value.decode("utf-8")
    # Everything else survives — only the secret fields are stripped.
    assert envelope["event"]["userId"] == "u1"
    assert envelope["event"]["email"] == "a@b.test"
