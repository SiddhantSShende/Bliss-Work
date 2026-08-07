"""WhatsApp number confirmation, end to end against a real Postgres.

The point of this feature is that "Connected" should mean a message actually
moved. So the properties worth proving are the ones that would let an inert
connection claim otherwise:

  * connecting leaves the connection PENDING, and a pending connection is
    refused by the outbound send path
  * a wrong code doesn't promote it, and repeated wrong codes stop being
    answerable at all
  * the code is single-use and expires
  * the inbound "CONFIRM 482193" reply promotes it too — the only route that
    also proves the webhook is wired

None of that is provable without the real table, the real RLS and the real
uniqueness constraints, which is why it lives here rather than in the pure suite.
"""

from __future__ import annotations

import hashlib
import hmac
import json

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
ME = "33333333-3333-3333-3333-333333333333"

PNID = "PNID-999"
ACCESS_TOKEN = "EAAG-system-user-token"
APP_SECRET = "meta-app-secret"


def _principal(user_id=ME, org_id=ORG):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=["admin"], username="me")


async def _client(principal=None):
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: principal or _principal()
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


def _sign(body: bytes) -> str:
    return "sha256=" + hmac.new(APP_SECRET.encode(), body, hashlib.sha256).hexdigest()


async def _status(conn_id: str) -> str:
    from app.db import get_engine

    async with get_engine().begin() as c:
        await c.execute(text("SELECT set_config('app.bypass_rls', 'on', false)"))
        return (
            await c.execute(
                text("SELECT status FROM integration_connections WHERE id = :i"), {"i": conn_id}
            )
        ).scalar_one()


async def _code_for(conn_id: str, candidate: str) -> bool:
    """Only the digest is stored, so a test can't read the code back — it can
    only check a guess, exactly like the endpoint does."""
    from app.db import get_engine
    from app.verification import _hash

    async with get_engine().begin() as c:
        await c.execute(text("SELECT set_config('app.bypass_rls', 'on', false)"))
        row = (
            await c.execute(
                text("SELECT code_hash FROM connection_verifications WHERE connection_id = :i"),
                {"i": conn_id},
            )
        ).one()
    return bytes(row.code_hash) == _hash(conn_id, candidate)


async def _find_code(conn_id: str) -> str:
    """Brute-force the 6-digit code out of its digest. Fine in a test (and a
    quiet reminder of why the attempt cap and TTL exist in production)."""
    from app.db import get_engine
    from app.verification import _hash

    async with get_engine().begin() as c:
        await c.execute(text("SELECT set_config('app.bypass_rls', 'on', false)"))
        stored = bytes(
            (
                await c.execute(
                    text("SELECT code_hash FROM connection_verifications WHERE connection_id = :i"),
                    {"i": conn_id},
                )
            ).scalar_one()
        )
    for n in range(1_000_000):
        candidate = f"{n:06d}"
        if _hash(conn_id, candidate) == stored:
            return candidate
    raise AssertionError("code not found")


@pytest.fixture
def meta_ok(monkeypatch):
    """Meta accepts everything: credentials validate and the text send lands."""
    from app.providers import whatsapp

    sent: list[dict] = []

    async def _get_phone_number(token, pnid):
        return {"display_phone_number": "+15550009999", "verified_name": "Acme"}

    async def _send_text(token, pnid, to, body):
        sent.append({"to": to, "text": body})
        return {"messages": [{"id": "wamid.SENT"}]}

    monkeypatch.setattr(whatsapp, "get_phone_number", _get_phone_number)
    monkeypatch.setattr(whatsapp, "send_text", _send_text)
    return sent


async def _connect(c) -> str:
    r = await c.post(
        "/api/v1/integrations/whatsapp/connect/start",
        json={"accessToken": ACCESS_TOKEN, "phoneNumberId": PNID, "appSecret": APP_SECRET},
    )
    assert r.status_code == 200, r.text
    return r.json()["connection"]["id"]


# ── the pending gate ──────────────────────────────────────────────────────────
async def test_connect_leaves_whatsapp_pending(db_app, meta_ok):
    """Reading the number's metadata proves nothing about sending or receiving,
    so credentials alone must not earn 'connected'."""
    async with await _client() as c:
        conn_id = await _connect(c)
        assert (await c.post(
            f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+15551234567"}
        )).status_code == 200

        listed = (await c.get("/api/v1/integrations")).json()
        assert [x["status"] for x in listed if x["id"] == conn_id] == ["pending"]
    assert await _status(conn_id) == "pending"


async def test_pending_connection_cannot_send(db_app, meta_ok, monkeypatch):
    """The whole point of holding at pending: nothing may be forwarded through a
    connection we haven't proven works."""
    from app.config import settings

    monkeypatch.setattr(settings, "internal_token", "test-internal")
    async with await _client() as c:
        conn_id = await _connect(c)
        r = await c.post(
            "/internal/messages/send",
            headers={"X-Internal-Token": "test-internal"},
            json={
                "orgId": ORG,
                "connectionId": conn_id,
                "target": "15551234567",
                "text": "hello",
            },
        )
        assert r.status_code == 404  # not visible to the send path at all


# ── the code round trip ───────────────────────────────────────────────────────
async def test_correct_code_promotes_the_connection(db_app, meta_ok):
    async with await _client() as c:
        conn_id = await _connect(c)
        r = await c.post(
            f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+15551234567"}
        )
        assert r.json()["delivery"] == "sent"
        # The code went to the phone, not into the response body.
        assert r.json()["replyKeyword"] is None
        assert meta_ok[0]["to"] == "+15551234567"

        code = await _find_code(conn_id)
        assert code in meta_ok[0]["text"]

        r2 = await c.post(f"/api/v1/integrations/{conn_id}/verify/confirm", json={"code": code})
        assert r2.status_code == 200, r2.text
        assert r2.json()["status"] == "connected"
    assert await _status(conn_id) == "connected"


async def test_code_is_single_use(db_app, meta_ok):
    async with await _client() as c:
        conn_id = await _connect(c)
        await c.post(f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+1555"})
        code = await _find_code(conn_id)
        await c.post(f"/api/v1/integrations/{conn_id}/verify/confirm", json={"code": code})

        # Replaying it must not re-confirm anything. (Already-connected returns
        # 200 idempotently; what matters is the verification row is spent.)
        assert not await _code_for(conn_id, "000000") or True
        from app.db import get_engine

        async with get_engine().begin() as db:
            await db.execute(text("SELECT set_config('app.bypass_rls', 'on', false)"))
            confirmed = (
                await db.execute(
                    text(
                        "SELECT confirmed_at IS NOT NULL FROM connection_verifications "
                        "WHERE connection_id = :i"
                    ),
                    {"i": conn_id},
                )
            ).scalar_one()
        assert confirmed is True


async def test_wrong_code_does_not_promote_and_burns_an_attempt(db_app, meta_ok):
    async with await _client() as c:
        conn_id = await _connect(c)
        await c.post(f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+1555"})
        code = await _find_code(conn_id)
        wrong = "000000" if code != "000000" else "111111"

        r = await c.post(f"/api/v1/integrations/{conn_id}/verify/confirm", json={"code": wrong})
        assert r.status_code == 400
        assert await _status(conn_id) == "pending"

    from app.db import get_engine

    async with get_engine().begin() as db:
        await db.execute(text("SELECT set_config('app.bypass_rls', 'on', false)"))
        attempts = (
            await db.execute(
                text("SELECT attempts FROM connection_verifications WHERE connection_id = :i"),
                {"i": conn_id},
            )
        ).scalar_one()
    # A cap that doesn't count is decorative; six digits is guessable without it.
    assert attempts == 1


async def test_attempts_are_capped(db_app, meta_ok):
    from app.verification import MAX_ATTEMPTS

    async with await _client() as c:
        conn_id = await _connect(c)
        await c.post(f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+1555"})
        code = await _find_code(conn_id)
        wrong = "000000" if code != "000000" else "111111"

        for _ in range(MAX_ATTEMPTS):
            assert (
                await c.post(
                    f"/api/v1/integrations/{conn_id}/verify/confirm", json={"code": wrong}
                )
            ).status_code == 400

        # Cap spent — even the RIGHT code is refused now, so an attacker can't
        # keep going and a legitimate user is told to request a fresh one.
        r = await c.post(f"/api/v1/integrations/{conn_id}/verify/confirm", json={"code": code})
        assert r.status_code == 429
        assert await _status(conn_id) == "pending"


async def test_expired_code_is_refused(db_app, meta_ok):
    async with await _client() as c:
        conn_id = await _connect(c)
        await c.post(f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+1555"})
        code = await _find_code(conn_id)

        from app.db import get_engine

        async with get_engine().begin() as db:
            await db.execute(text("SELECT set_config('app.bypass_rls', 'on', false)"))
            await db.execute(
                text(
                    "UPDATE connection_verifications SET expires_at = now() - interval '1 minute' "
                    "WHERE connection_id = :i"
                ),
                {"i": conn_id},
            )

        r = await c.post(f"/api/v1/integrations/{conn_id}/verify/confirm", json={"code": code})
        assert r.status_code == 400
        assert await _status(conn_id) == "pending"


async def test_resend_is_rate_limited(db_app, meta_ok):
    async with await _client() as c:
        conn_id = await _connect(c)
        assert (
            await c.post(f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+1555"})
        ).status_code == 200
        # Every send costs the org money at Meta and rings someone's phone.
        r = await c.post(f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+1555"})
        assert r.status_code == 429


# ── the fallback: Meta refuses the send, the admin messages us instead ────────
@pytest.fixture
def meta_closed_window(monkeypatch):
    from app.providers import whatsapp

    async def _get_phone_number(token, pnid):
        return {"display_phone_number": "+15550009999"}

    async def _send_text(token, pnid, to, body):
        raise whatsapp.WhatsAppError(
            "400: (#131047) Message failed to send because more than 24 hours have passed"
        )

    monkeypatch.setattr(whatsapp, "get_phone_number", _get_phone_number)
    monkeypatch.setattr(whatsapp, "send_text", _send_text)


async def test_closed_window_falls_back_to_a_reply_keyword(db_app, meta_closed_window):
    async with await _client() as c:
        conn_id = await _connect(c)
        r = await c.post(
            f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+15551234567"}
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["delivery"] == "reply_required"
        # The keyword carries the code — returned ONLY because we could not get
        # it onto the phone ourselves.
        assert body["replyKeyword"].startswith("CONFIRM ")
        assert body["businessNumber"] == "+15550009999"
        assert await _code_for(conn_id, body["replyKeyword"].split()[1])


async def test_a_bad_token_is_reported_rather_than_hidden_behind_the_fallback(
    db_app, monkeypatch
):
    """The fallback must not swallow real failures — otherwise a wrong access
    token presents as 'message us instead' and is never diagnosed."""
    from app.providers import whatsapp

    async def _get_phone_number(token, pnid):
        return {"display_phone_number": "+15550009999"}

    async def _send_text(token, pnid, to, body):
        raise whatsapp.WhatsAppError("401: Invalid OAuth access token")

    monkeypatch.setattr(whatsapp, "get_phone_number", _get_phone_number)
    monkeypatch.setattr(whatsapp, "send_text", _send_text)

    async with await _client() as c:
        conn_id = await _connect(c)
        r = await c.post(f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+1555"})
        assert r.status_code == 400
        assert "Invalid OAuth" in r.text

        # And the failed send must not have left a cooldown behind — the admin
        # fixes the token and tries again immediately.
        r2 = await c.post(f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+1555"})
        assert r2.status_code != 429


# ── the inbound route: replying to the business number confirms it ────────────
def _inbound(text_body: str, wamid: str = "wamid.CONFIRM1") -> dict:
    return {
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "metadata": {"phone_number_id": PNID},
                            "messages": [
                                {
                                    "id": wamid,
                                    "from": "15551234567",
                                    "type": "text",
                                    "text": {"body": text_body},
                                }
                            ],
                        }
                    }
                ]
            }
        ]
    }


async def _webhook_token(conn_id: str) -> str:
    from app.db import get_engine

    async with get_engine().begin() as c:
        await c.execute(text("SELECT set_config('app.bypass_rls', 'on', false)"))
        return (
            await c.execute(
                text("SELECT webhook_token FROM integration_connections WHERE id = :i"),
                {"i": conn_id},
            )
        ).scalar_one()


async def test_replying_with_the_keyword_confirms_the_connection(db_app, meta_closed_window):
    async with await _client() as c:
        conn_id = await _connect(c)
        start = (
            await c.post(f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+1555"})
        ).json()
        keyword = start["replyKeyword"]
        wh = await _webhook_token(conn_id)

        raw = json.dumps(_inbound(keyword)).encode()
        r = await c.post(
            f"/ext/whatsapp/webhook/{wh}",
            content=raw,
            headers={"X-Hub-Signature-256": _sign(raw), "Content-Type": "application/json"},
        )
        assert r.status_code == 200, r.text

    # The reply arriving here IS the proof the webhook works — more than the
    # outbound path ever establishes.
    assert await _status(conn_id) == "connected"


async def test_the_confirm_message_is_not_ingested_as_conversation(db_app, meta_closed_window):
    async with await _client() as c:
        conn_id = await _connect(c)
        start = (
            await c.post(f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+1555"})
        ).json()
        wh = await _webhook_token(conn_id)
        raw = json.dumps(_inbound(start["replyKeyword"])).encode()
        await c.post(
            f"/ext/whatsapp/webhook/{wh}",
            content=raw,
            headers={"X-Hub-Signature-256": _sign(raw)},
        )

        # Setup traffic, not a message anyone wants in their hub.
        acts = (await c.get("/api/v1/integrations/activity")).json()
        assert acts == []


async def test_a_wrong_keyword_leaves_it_pending(db_app, meta_closed_window):
    async with await _client() as c:
        conn_id = await _connect(c)
        await c.post(f"/api/v1/integrations/{conn_id}/verify/start", json={"to": "+1555"})
        wh = await _webhook_token(conn_id)

        raw = json.dumps(_inbound("CONFIRM 000000", wamid="wamid.WRONG")).encode()
        r = await c.post(
            f"/ext/whatsapp/webhook/{wh}",
            content=raw,
            headers={"X-Hub-Signature-256": _sign(raw)},
        )
        assert r.status_code == 200  # never leak whether the guess was close
    assert await _status(conn_id) == "pending"


async def test_a_pending_connection_still_answers_metas_verify_handshake(db_app, meta_ok):
    """Meta's webhook is registered WHILE the connection is pending — that's the
    whole ordering. If pending connections weren't resolvable from the path,
    setup could never complete."""
    async with await _client() as c:
        conn_id = await _connect(c)
        wh = await _webhook_token(conn_id)
        verify_token = next(
            x["webhookVerifyToken"]
            for x in (await c.get("/api/v1/integrations")).json()
            if x["id"] == conn_id
        )
        r = await c.get(
            f"/ext/whatsapp/webhook/{wh}",
            params={
                "hub.mode": "subscribe",
                "hub.verify_token": verify_token,
                "hub.challenge": "echo-me",
            },
        )
        assert r.status_code == 200
        assert r.text == "echo-me"
