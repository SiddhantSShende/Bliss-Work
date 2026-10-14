"""Outbound send dispatch.

The retryable/definitive split is the part with consequences: it decides whether
routes/internal.py answers 502 (messaging-svc retries) or 400 (it gives up). An
expired access token classified as definitive drops a message that a token
refresh — already running on its own 60s sweep — would have delivered.
"""

import pytest

from app import outbound
from app.providers import gmail, microsoft as ms


class _Row:
    """Minimal stand-in for an integration_connections row."""

    def __init__(self, provider: str, token_enc=b"x", metadata_enc=None):
        self.provider = provider
        self.access_token_enc = token_enc
        self.metadata_enc = metadata_enc


class _FakeCryptor:
    """Decrypt returns a canned token / metadata blob without touching the DB."""

    def __init__(self, token="tok", meta=None):
        self._token, self._meta = token, meta

    async def decrypt(self, _db, _org, blob):
        if blob is None:
            return None
        return self._meta if blob == b"META" else self._token

    async def encrypt(self, _db, _org, value):
        return value.encode()


@pytest.fixture
def crypt(monkeypatch):
    def _install(token="tok", meta=None):
        fake = _FakeCryptor(token, meta)
        monkeypatch.setattr(outbound, "cryptor", lambda: fake)
        return fake

    return _install


# ── routing ───────────────────────────────────────────────────────────────────
async def test_slack_routes_to_post_message(crypt, monkeypatch):
    crypt()
    monkeypatch.setattr(gmail, "send_message", None)  # must not be touched
    sent = {}

    async def fake_post(token, channel, text):
        sent.update(token=token, channel=channel, text=text)
        return {"ok": True, "ts": "1699.0001"}

    monkeypatch.setattr(outbound.slack, "post_message", fake_post)
    res = await outbound.send_via_connection(
        None, "org", _Row("slack"), target="C123", text="hi"
    )
    assert res.external_id == "1699.0001"
    assert res.kind == "message"
    assert sent == {"token": "tok", "channel": "C123", "text": "hi"}


async def test_gmail_sends_mime_and_reports_email_kind(crypt, monkeypatch):
    crypt()
    captured = {}

    async def fake_send(token, raw, thread_id=None):
        captured["raw"] = raw
        return {"id": "msg-1", "threadId": "t-1"}

    monkeypatch.setattr(outbound.gmail, "send_message", fake_send)
    res = await outbound.send_via_connection(
        None, "org", _Row("gmail"), target="a@b.com", text="body", subject="Subj"
    )
    assert res.external_id == "msg-1"
    # 'email' drives the activity mirror's kind, which the hub branches on.
    assert res.kind == "email"
    assert "=" not in captured["raw"]  # base64url, unpadded — Gmail requires it


async def test_mail_without_a_subject_gets_a_default(crypt, monkeypatch):
    # An empty subject is far more likely to be filtered as spam and reads as
    # broken to a human.
    crypt()
    captured = {}

    async def fake_send(_token, raw, thread_id=None):
        captured["raw"] = raw
        return {"id": "m"}

    monkeypatch.setattr(outbound.gmail, "send_message", fake_send)
    await outbound.send_via_connection(None, "org", _Row("gmail"), target="a@b.com", text="b")

    import base64

    raw = captured["raw"]
    decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode()
    assert outbound.DEFAULT_SUBJECT in decoded


async def test_outlook_external_id_is_the_internet_message_id(crypt, monkeypatch):
    """send_mail is draft-then-send (see microsoft.py): it returns the
    Graph-assigned internetMessageId, which is what gets recorded as this
    activity's external_id — a stable, cross-mailbox identifier, unlike the
    mailbox-scoped Graph `id` the same call also returns."""
    crypt()

    async def fake_send_mail(_token, *, to, subject, body):
        return "msg-1", "<abc123@graph.microsoft.com>"

    monkeypatch.setattr(outbound.ms, "send_mail", fake_send_mail)
    res = await outbound.send_via_connection(
        None, "org", _Row("outlook"), target="a@b.com", text="body"
    )
    assert res.external_id == "<abc123@graph.microsoft.com>"
    assert res.kind == "email"


async def test_outlook_external_id_is_none_when_graph_omits_it(crypt, monkeypatch):
    # Belt-and-suspenders: an empty string from a stubbed/odd response must
    # still become None, not an empty-but-truthy external id.
    crypt()

    async def fake_send_mail(_token, *, to, subject, body):
        return "msg-1", ""

    monkeypatch.setattr(outbound.ms, "send_mail", fake_send_mail)
    res = await outbound.send_via_connection(
        None, "org", _Row("outlook"), target="a@b.com", text="body"
    )
    assert res.external_id is None
    assert res.kind == "email"


async def test_teams_posts_to_the_chat(crypt, monkeypatch):
    crypt()

    async def fake_chat(_token, chat_id, text):
        return {"id": f"msg-in-{chat_id}"}

    monkeypatch.setattr(outbound.ms, "send_chat_message", fake_chat)
    res = await outbound.send_via_connection(
        None, "org", _Row("teams"), target="chat-9", text="hi"
    )
    assert res.external_id == "msg-in-chat-9"
    assert res.kind == "message"


async def test_unknown_provider_is_unsupported(crypt):
    crypt()
    with pytest.raises(outbound.OutboundUnsupported):
        await outbound.send_via_connection(None, "org", _Row("myspace"), target="x", text="y")


# ── error classification ──────────────────────────────────────────────────────
async def test_missing_token_is_retryable(crypt):
    # A connected row with no token means the refresh worker hasn't caught up.
    # Definitive would drop a message that succeeds moments later.
    crypt()
    with pytest.raises(outbound.OutboundError) as ei:
        await outbound.send_via_connection(
            None, "org", _Row("slack", token_enc=None), target="C1", text="hi"
        )
    assert ei.value.retryable is True


@pytest.mark.parametrize(
    "exc",
    [
        gmail.GmailAuthError("expired"),
        gmail.GmailRateLimited("slow down", 30),
    ],
)
async def test_gmail_transient_failures_are_retryable(crypt, monkeypatch, exc):
    crypt()

    async def boom(*_a, **_kw):
        raise exc

    monkeypatch.setattr(outbound.gmail, "send_message", boom)
    with pytest.raises(outbound.OutboundError) as ei:
        await outbound.send_via_connection(
            None, "org", _Row("gmail"), target="a@b.com", text="x"
        )
    assert ei.value.retryable is True


async def test_gmail_definitive_failure_is_not_retryable(crypt, monkeypatch):
    crypt()

    async def boom(*_a, **_kw):
        raise gmail.GmailError("400: malformed recipient")

    monkeypatch.setattr(outbound.gmail, "send_message", boom)
    with pytest.raises(outbound.OutboundError) as ei:
        await outbound.send_via_connection(
            None, "org", _Row("gmail"), target="bad", text="x"
        )
    assert ei.value.retryable is False


@pytest.mark.parametrize(
    "exc,retryable",
    [
        (ms.MicrosoftAuthError("expired"), True),
        (ms.MicrosoftRateLimited("throttled", 60), True),
        (ms.MicrosoftError("400: bad recipient"), False),
    ],
)
async def test_microsoft_failures_classify_correctly(crypt, monkeypatch, exc, retryable):
    crypt()

    async def boom(*_a, **_kw):
        raise exc

    monkeypatch.setattr(outbound.ms, "send_mail", boom)
    with pytest.raises(outbound.OutboundError) as ei:
        await outbound.send_via_connection(
            None, "org", _Row("outlook"), target="a@b.com", text="x"
        )
    assert ei.value.retryable is retryable


async def test_ambiguous_graph_delivery_is_not_represented_as_definite_failure(
    crypt, monkeypatch
):
    crypt()

    async def boom(*_a, **_kw):
        raise ms.MicrosoftAmbiguousDelivery("504: gateway timeout")

    monkeypatch.setattr(outbound.ms, "send_mail", boom)
    with pytest.raises(outbound.OutboundError) as ei:
        await outbound.send_via_connection(
            None, "org", _Row("outlook"), target="a@b.com", text="x"
        )
    assert ei.value.ambiguous is True
    assert ei.value.retryable is False


@pytest.mark.parametrize(
    "provider,exc",
    [
        ("gmail", gmail.GmailAuthError("expired")),
        ("outlook", ms.MicrosoftAuthError("expired")),
        ("teams", ms.MicrosoftAuthError("expired")),
    ],
)
async def test_a_401_at_send_time_is_flagged_as_an_auth_error(crypt, monkeypatch, provider, exc):
    # gmail.py/microsoft.py's own docstrings promise the caller re-arms
    # token_expires_at on a 401 so refresh_worker's next sweep renews it
    # rather than waiting out the token's original expiry — routes/internal.py
    # only does that when this flag is set.
    crypt()
    send_attr = {"gmail": "send_message", "outlook": "send_mail", "teams": "send_chat_message"}[
        provider
    ]

    async def boom(*_a, **_kw):
        raise exc

    monkeypatch.setattr(getattr(outbound, "gmail" if provider == "gmail" else "ms"), send_attr, boom)
    with pytest.raises(outbound.OutboundError) as ei:
        await outbound.send_via_connection(
            None, "org", _Row(provider), target="a@b.com" if provider != "teams" else "chat1", text="x"
        )
    assert ei.value.is_auth_error is True


@pytest.mark.parametrize(
    "provider,exc",
    [
        ("gmail", gmail.GmailRateLimited("slow down", 30)),
        ("outlook", ms.MicrosoftRateLimited("throttled", 60)),
        ("outlook", ms.MicrosoftError("400: bad recipient")),
    ],
)
async def test_a_non_auth_failure_is_never_flagged_as_an_auth_error(crypt, monkeypatch, provider, exc):
    crypt()
    send_attr = "send_message" if provider == "gmail" else "send_mail"

    async def boom(*_a, **_kw):
        raise exc

    monkeypatch.setattr(getattr(outbound, "gmail" if provider == "gmail" else "ms"), send_attr, boom)
    with pytest.raises(outbound.OutboundError) as ei:
        await outbound.send_via_connection(None, "org", _Row(provider), target="a@b.com", text="x")
    assert ei.value.is_auth_error is False


async def test_unsupported_is_never_retryable(crypt):
    # OutboundUnsupported subclasses OutboundError; internal.py maps it to 400
    # explicitly, but the flag must agree or a future caller gets it wrong.
    crypt()
    with pytest.raises(outbound.OutboundError) as ei:
        await outbound.send_via_connection(None, "org", _Row("nope"), target="x", text="y")
    assert ei.value.retryable is False
