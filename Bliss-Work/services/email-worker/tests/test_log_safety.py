"""Recipient addresses are not emitted in email-worker operational logs."""
from __future__ import annotations

import types

import aiosmtplib
import pytest

from app import mailer as mailer_module
from app.mailer import Mailer
from app.relay_consumer import RelayConsumer
from app.worker import EmailWorker


class _Logger:
    def __init__(self) -> None:
        self.entries: list[str] = []

    def __getattr__(self, _name: str):
        def record(event: str, **fields: object) -> None:
            self.entries.append(repr((event, fields)))

        return record


async def test_smtp_error_log_redacts_raw_recipient(monkeypatch) -> None:
    logger = _Logger()
    monkeypatch.setattr(mailer_module, "log", logger)

    async def smtp_reject(*_args, **_kwargs) -> None:
        raise aiosmtplib.SMTPException(
            "temporary rejection for jane@example.test"
        )

    monkeypatch.setattr(aiosmtplib, "send", smtp_reject)
    monkeypatch.setattr(mailer_module, "_MAX_ATTEMPTS", 1)
    mailer = Mailer("smtp.test", 587, "no-reply@example.test")
    with pytest.raises(aiosmtplib.SMTPException):
        await mailer.send(
            to="jane@example.test",
            subject="Hi",
            text_body="Hello",
            html_body="<p>Hello</p>",
        )

    joined = "\n".join(logger.entries)
    assert "jane@example.test" not in joined
    assert "recipient_ref" in joined
    assert "<email>" in joined


async def test_smtp_success_log_uses_recipient_reference(monkeypatch) -> None:
    logger = _Logger()
    monkeypatch.setattr(mailer_module, "log", logger)

    async def accepted(*_args, **_kwargs) -> None:
        return None

    monkeypatch.setattr(aiosmtplib, "send", accepted)
    mailer = Mailer("smtp.test", 587, "no-reply@example.test")
    await mailer.send(
        to="jane@example.test",
        subject="Hi",
        text_body="Hello",
        html_body="<p>Hello</p>",
    )

    joined = "\n".join(logger.entries)
    assert "jane@example.test" not in joined
    assert "recipient_ref" in joined


async def test_worker_error_log_redacts_raw_recipient() -> None:
    settings = types.SimpleNamespace(
        smtp_host="smtp.test",
        smtp_port=587,
        smtp_from="no-reply@example.test",
        smtp_username="",
        smtp_password="",
        smtp_starttls=False,
        poison_max_failures=1,
    )
    worker = EmailWorker(settings)
    logger = _Logger()
    worker._log = logger

    await worker._on_failure(
        "evt-1",
        {"eventId": "evt-1"},
        "550 <jane@example.test> recipient rejected",
        max_failures=1,
    )

    joined = "\n".join(logger.entries)
    assert "jane@example.test" not in joined
    assert "<email>" in joined


async def test_relay_error_log_redacts_raw_recipient(monkeypatch) -> None:
    settings = types.SimpleNamespace(
        smtp_host="smtp.test",
        smtp_port=587,
        smtp_from="no-reply@example.test",
        smtp_username="",
        smtp_password="",
        smtp_starttls=False,
        redis_url="redis://localhost:6379/0",
        relay_max_concurrency=2,
        poison_max_failures=1,
    )
    relay = RelayConsumer(settings)
    logger = _Logger()
    monkeypatch.setattr("app.relay_consumer._log", logger)

    async def to_dlq(_event: dict, _error: str) -> None:
        return None

    relay._to_dlq = to_dlq  # type: ignore[method-assign]
    await relay._on_failure(
        "evt-2",
        {"eventId": "evt-2"},
        "550 <jane@example.test> recipient rejected",
        max_failures=1,
    )

    joined = "\n".join(logger.entries)
    assert "jane@example.test" not in joined
    assert "<email>" in joined
