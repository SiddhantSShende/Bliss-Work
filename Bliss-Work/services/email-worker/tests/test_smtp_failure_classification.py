"""SMTP permanent replies go terminal; transient replies keep bounded retries."""
from __future__ import annotations

import json
import types

import aiosmtplib
import pytest

from app import mailer as mailer_module
from app.mailer import Mailer, PermanentSMTPError
from app.relay_consumer import RelayConsumer
from app.worker import EmailWorker


class _SMTPReply(aiosmtplib.SMTPException):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class _RecordingLogger:
    def __init__(self) -> None:
        self.records: list[tuple[str, dict]] = []

    def __getattr__(self, method: str):
        def record(_event: str, **fields: object) -> None:
            self.records.append((method, fields))

        return record


async def test_permanent_5xx_reply_is_not_retried(monkeypatch) -> None:
    sends = 0
    logger = _RecordingLogger()
    monkeypatch.setattr(mailer_module, "log", logger)

    async def rejected(*_args, **_kwargs) -> None:
        nonlocal sends
        sends += 1
        raise _SMTPReply(550, "550 5.1.1 <jane@example.test> recipient rejected")

    monkeypatch.setattr(aiosmtplib, "send", rejected)
    mailer = Mailer("smtp.test", 587, "no-reply@example.test")

    with pytest.raises(PermanentSMTPError) as exc:
        await mailer.send(
            to="jane@example.test",
            subject="Hi",
            text_body="Hello",
            html_body="<p>Hello</p>",
        )

    assert exc.value.code == 550
    assert sends == 1
    assert "jane@example.test" not in repr(logger.records)


async def test_authentication_5xx_reply_is_not_retried(monkeypatch) -> None:
    sends = 0

    async def authentication_rejected(*_args, **_kwargs) -> None:
        nonlocal sends
        sends += 1
        raise _SMTPReply(535, "535 authentication credentials rejected")

    monkeypatch.setattr(aiosmtplib, "send", authentication_rejected)
    mailer = Mailer("smtp.test", 587, "no-reply@example.test")

    with pytest.raises(PermanentSMTPError) as exc:
        await mailer.send(
            to="jane@example.test",
            subject="Hi",
            text_body="Hello",
            html_body="<p>Hello</p>",
        )

    assert exc.value.code == 535
    assert sends == 1


async def test_transient_4xx_reply_keeps_bounded_retry(monkeypatch) -> None:
    sends = 0
    monkeypatch.setattr(mailer_module, "_MAX_ATTEMPTS", 3)
    monkeypatch.setattr(mailer_module, "_BASE_DELAY", 0)
    monkeypatch.setattr(mailer_module, "_MAX_DELAY", 0)

    async def temporarily_rejected(*_args, **_kwargs) -> None:
        nonlocal sends
        sends += 1
        raise _SMTPReply(451, "451 4.3.0 temporary failure")

    monkeypatch.setattr(aiosmtplib, "send", temporarily_rejected)
    mailer = Mailer("smtp.test", 587, "no-reply@example.test")

    with pytest.raises(_SMTPReply):
        await mailer.send(
            to="jane@example.test",
            subject="Hi",
            text_body="Hello",
            html_body="<p>Hello</p>",
        )

    assert sends == 3


async def test_recipient_refusal_5xx_is_classified_as_permanent(monkeypatch) -> None:
    sends = 0

    async def recipient_refused(*_args, **_kwargs) -> None:
        nonlocal sends
        sends += 1
        exc = aiosmtplib.SMTPException("recipient refused")
        exc.recipients = [types.SimpleNamespace(code=550)]
        raise exc

    monkeypatch.setattr(aiosmtplib, "send", recipient_refused)
    mailer = Mailer("smtp.test", 587, "no-reply@example.test")

    with pytest.raises(PermanentSMTPError) as exc:
        await mailer.send(
            to="jane@example.test",
            subject="Hi",
            text_body="Hello",
            html_body="<p>Hello</p>",
        )

    assert exc.value.code == 550
    assert sends == 1


async def test_permanent_mail_worker_failure_uses_terminal_path() -> None:
    settings = types.SimpleNamespace(
        smtp_host="smtp.test",
        smtp_port=587,
        smtp_from="no-reply@example.test",
        smtp_username="",
        smtp_password="",
        smtp_starttls=False,
        poison_max_failures=5,
    )
    worker = EmailWorker(settings)
    dlq: list[tuple[dict, str]] = []

    async def claimed(*_args):
        from app.worker import _Claim

        return _Claim.CLAIMED

    async def permanent(*_args) -> None:
        raise PermanentSMTPError(550)

    async def to_dlq(event: dict, error: str) -> None:
        dlq.append((event, error))

    worker._claim = claimed  # type: ignore[method-assign]
    worker._send_invite = permanent  # type: ignore[method-assign]
    worker._to_dlq = to_dlq  # type: ignore[method-assign]
    event = {
        "type": "invite.created",
        "eventId": "evt-1",
        "inviteId": "invite-1",
    }

    result = await worker._handle_message(json.dumps(event).encode())

    assert result is True
    assert len(dlq) == 1
    assert worker._failures == {}


async def test_permanent_relay_smtp_failure_uses_one_failure_budget() -> None:
    settings = types.SimpleNamespace(
        smtp_host="smtp.test",
        smtp_port=587,
        smtp_from="no-reply@example.test",
        smtp_username="",
        smtp_password="",
        smtp_starttls=False,
        redis_url="redis://localhost:6379/0",
        relay_max_concurrency=2,
        poison_max_failures=5,
    )
    relay = RelayConsumer(settings)
    budgets: list[int | None] = []

    async def fail_send(*_args) -> None:
        raise PermanentSMTPError(550)

    async def retry_or_dlq(
        *_args, max_failures: int | None = None
    ) -> bool:
        budgets.append(max_failures)
        return max_failures == 1

    relay._do_handle_outbound_mail = fail_send  # type: ignore[method-assign]
    relay._retry_or_dlq = retry_or_dlq  # type: ignore[method-assign]

    assert await relay._handle_outbound_mail(
        {"mailId": "018f0000-0000-7000-8000-0000000000aa"},
        "evt-3",
    )
    assert budgets == [1]


async def test_permanent_relay_failure_uses_terminal_path() -> None:
    settings = types.SimpleNamespace(
        smtp_host="smtp.test",
        smtp_port=587,
        smtp_from="no-reply@example.test",
        smtp_username="",
        smtp_password="",
        smtp_starttls=False,
        redis_url="redis://localhost:6379/0",
        relay_max_concurrency=2,
        poison_max_failures=5,
    )
    relay = RelayConsumer(settings)
    dlq: list[tuple[dict, str]] = []

    async def to_dlq(event: dict, error: str) -> None:
        dlq.append((event, error))

    async def mark_sent(*_args) -> bool:
        return True

    relay._to_dlq = to_dlq  # type: ignore[method-assign]
    relay._mark_sent = mark_sent  # type: ignore[method-assign]

    result = await relay._retry_or_dlq(
        "evt-2",
        "018f0000-0000-7000-8000-0000000000aa",
        {"eventId": "evt-2"},
        "permanent SMTP response (550)",
        max_failures=1,
    )

    assert result is True
    assert len(dlq) == 1
    assert relay._failures == {}
