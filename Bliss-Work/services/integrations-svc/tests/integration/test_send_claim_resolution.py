"""B-INT-1: after the idempotency claim commits, EVERY outcome must resolve the row
or knowingly leave it 'sending' — never strand it by accident.

Before the fix only a few typed exceptions resolved the claim:
  * a bare httpx.HTTPStatusError (Slack: any 4xx/5xx; Gmail/Graph: a plain 5xx) is an
    httpx.HTTPError, so it took the "ambiguous network fault" path — the row stayed
    'sending' and every retry answered 409 forever, although the provider had plainly
    ANSWERED (nothing was sent);
  * a Gmail header-validation ValueError (CR/LF in the subject) and any other bug
    escaped as a bare 500 with the row still 'sending' — again 409 forever;
  * a connect failure (request never left) was treated as ambiguous too.
The truly ambiguous cases (timeout / drop after the request went out, or an unknown
exception once a request may be on the wire) must STILL stay 'sending' and answer 409.

Real FastAPI routes + real Postgres. Only the HTTP transport of the provider adapters
(or, for the mail route, providers.microsoft.send_mail) is replaced.
"""
from __future__ import annotations

import httpx
import pytest

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
USER = "22222222-2222-2222-2222-222222222222"
TOKEN = "test-internal-token"
HDR = {"X-Internal-Token": TOKEN}
CONN = "33333333-3333-3333-3333-333333333333"


def _id(n: int) -> str:
    return f"018f0000-0000-7000-8000-{n:012d}"


@pytest.fixture(autouse=True)
def _internal_token(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "internal_token", TOKEN)


async def _client() -> httpx.AsyncClient:
    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _seed(provider: str) -> None:
    from sqlalchemy import text

    from app.db import session, set_org_context
    from crypto import cryptor

    async with session() as db:
        await set_org_context(db, ORG)
        access_enc = await cryptor().encrypt(db, ORG, "fake-access-token")
        await db.execute(
            text(
                """
                INSERT INTO integration_connections
                    (id, org_id, owner_user_id, created_by, scope_kind, provider,
                     status, display_label, access_token_enc)
                VALUES (:id, :o, :u, :u, 'user', :p, 'connected', 'x', :a)
                """
            ),
            {"id": CONN, "o": ORG, "u": USER, "p": provider, "a": access_enc},
        )
        await db.commit()


async def _status(table: str, column: str, entity_id: str) -> str | None:
    from sqlalchemy import text

    from app.db import session, set_org_context

    async with session() as db:
        await set_org_context(db, ORG)
        row = (
            await db.execute(
                text(f"SELECT status FROM {table} WHERE {column} = :e"), {"e": entity_id}
            )
        ).one_or_none()
    return row.status if row else None


def _status_error(code: int) -> httpx.HTTPStatusError:
    req = httpx.Request("POST", "https://provider.test/x")
    return httpx.HTTPStatusError("boom", request=req, response=httpx.Response(code, request=req))


# ───────────────────────── mail route (/internal/mail/send) ─────────────────────────


def _mail_body(mail_id: str) -> dict:
    return {"orgId": ORG, "userId": USER, "mailId": mail_id, "subject": "s",
            "bodyText": "b", "to": ["p@outside.test"]}


class _Send:
    """Stand-in for providers.microsoft.send_mail with scripted outcomes."""

    def __init__(self, outcomes, touch_wire: bool = False):
        self.outcomes, self.calls, self.touch_wire = list(outcomes), 0, touch_wire

    async def __call__(self, token, **kw):
        from app.providers import httpclient

        self.calls += 1
        if self.touch_wire:
            httpclient.shared()  # a real adapter asks for the client as it sends
        out = self.outcomes.pop(0)
        if isinstance(out, BaseException):
            raise out


def _install(monkeypatch, send):
    from app.routes import internal

    monkeypatch.setattr(internal.ms, "send_mail", send)


@pytest.mark.parametrize(
    "exc, expected_http",
    [
        (_status_error(500), 502),   # provider 5xx answer -> retryable
        (_status_error(403), 400),   # provider 4xx answer -> will repeat, give up
        (httpx.ConnectError("refused"), 502),  # request never left
    ],
)
async def test_mail_a_definite_not_sent_error_resolves_failed_and_a_retry_can_send(
    db_app, monkeypatch, exc, expected_http
):
    mail = _id(101 + expected_http)
    await _seed("outlook")
    send = _Send([exc, None], touch_wire=True)
    _install(monkeypatch, send)

    async with await _client() as c:
        first = await c.post("/internal/mail/send", json=_mail_body(mail), headers=HDR)
        assert first.status_code == expected_http, first.text
        assert await _status("mail_send_attempts", "mail_id", mail) == "failed"

        retry = await c.post("/internal/mail/send", json=_mail_body(mail), headers=HDR)

    assert retry.status_code == 200, "the row must not be stranded 'sending' (409 forever)"
    assert send.calls == 2
    assert await _status("mail_send_attempts", "mail_id", mail) == "sent"


async def test_mail_an_unexpected_error_before_the_wire_resolves_failed(db_app, monkeypatch):
    mail = _id(201)
    await _seed("outlook")
    send = _Send([RuntimeError("bug before any request"), None], touch_wire=False)
    _install(monkeypatch, send)

    async with await _client() as c:
        first = await c.post("/internal/mail/send", json=_mail_body(mail), headers=HDR)
        assert first.status_code == 502, first.text
        assert await _status("mail_send_attempts", "mail_id", mail) == "failed"
        retry = await c.post("/internal/mail/send", json=_mail_body(mail), headers=HDR)

    assert retry.status_code == 200
    assert send.calls == 2


async def test_mail_an_unexpected_error_after_the_wire_stays_sending_and_409(db_app, monkeypatch):
    mail = _id(202)
    await _seed("outlook")
    send = _Send([RuntimeError("blew up after the request left")], touch_wire=True)
    _install(monkeypatch, send)

    async with await _client() as c:
        first = await c.post("/internal/mail/send", json=_mail_body(mail), headers=HDR)
        assert first.status_code == 409, first.text  # not a bare 500
        assert await _status("mail_send_attempts", "mail_id", mail) == "sending"
        again = await c.post("/internal/mail/send", json=_mail_body(mail), headers=HDR)

    assert again.status_code == 409
    assert send.calls == 1, "never re-sent: the provider may already have delivered it"


@pytest.mark.parametrize("exc", [httpx.ReadTimeout("t"), httpx.RemoteProtocolError("dropped")])
async def test_mail_a_timeout_or_drop_after_send_is_still_ambiguous(db_app, monkeypatch, exc):
    mail = _id(203 if isinstance(exc, httpx.ReadTimeout) else 204)
    await _seed("outlook")
    send = _Send([exc], touch_wire=True)
    _install(monkeypatch, send)

    async with await _client() as c:
        first = await c.post("/internal/mail/send", json=_mail_body(mail), headers=HDR)

    assert first.status_code == 409
    assert await _status("mail_send_attempts", "mail_id", mail) == "sending"


# ──────────────────── message route (/internal/messages/send) ────────────────────


def _msg_body(message_id: str, **kw) -> dict:
    body = {"orgId": ORG, "connectionId": CONN, "target": "C123", "text": "hello",
            "messageId": message_id}
    body.update(kw)
    return body


def _serve(monkeypatch, handler):
    """Route the REAL provider adapters' HTTP through a mock transport."""
    from app.providers import gmail, httpclient, slack
    from resilience import CircuitBreaker

    monkeypatch.setattr(httpclient, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    # Breakers are module state: one test's failures must not open the next one's.
    monkeypatch.setattr(slack, "_slack_breaker", CircuitBreaker(fail_max=50, reset_timeout=30.0))
    monkeypatch.setattr(gmail, "_gmail_breaker", CircuitBreaker(fail_max=50, reset_timeout=30.0))


@pytest.mark.parametrize("code, expected_http", [(500, 502), (403, 400), (404, 400)])
async def test_slack_an_http_error_response_resolves_failed_not_stuck_sending(
    db_app, monkeypatch, code, expected_http
):
    msg = _id(300 + code)
    await _seed("slack")
    answers = [httpx.Response(code), httpx.Response(200, json={"ok": True, "ts": "1.2"})]
    seen = []

    def handler(request):
        seen.append(request)
        return answers.pop(0)

    _serve(monkeypatch, handler)

    async with await _client() as c:
        first = await c.post("/internal/messages/send", json=_msg_body(msg), headers=HDR)
        assert first.status_code == expected_http, first.text
        assert await _status("message_send_attempts", "message_id", msg) == "failed"

        retry = await c.post("/internal/messages/send", json=_msg_body(msg), headers=HDR)

    assert retry.status_code == 200, retry.text  # was 409 forever
    assert len(seen) == 2
    assert await _status("message_send_attempts", "message_id", msg) == "sent"


async def test_slack_a_read_timeout_after_the_request_went_out_stays_ambiguous(db_app, monkeypatch):
    msg = _id(401)
    await _seed("slack")

    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    _serve(monkeypatch, handler)

    async with await _client() as c:
        first = await c.post("/internal/messages/send", json=_msg_body(msg), headers=HDR)

    assert first.status_code == 409
    assert await _status("message_send_attempts", "message_id", msg) == "sending"


async def test_gmail_header_validation_error_is_definitive_not_a_stuck_claim(db_app, monkeypatch):
    msg = _id(402)
    await _seed("gmail")

    def handler(request):  # pragma: no cover - must never be reached
        raise AssertionError("an invalid message must not reach the network")

    _serve(monkeypatch, handler)

    async with await _client() as c:
        # CR/LF in the subject: EmailMessage rejects it with ValueError before any I/O.
        r = await c.post(
            "/internal/messages/send",
            json=_msg_body(msg, target="to@outside.test", subject="hi\r\nBcc: evil@x.test"),
            headers=HDR,
        )

    assert r.status_code == 400, r.text
    assert await _status("message_send_attempts", "message_id", msg) == "failed"
