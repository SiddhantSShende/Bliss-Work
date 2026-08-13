"""WhatsApp is Business-accounts-only, end to end against a real Postgres.

Having Cloud API credentials proves a number exists, not that a business does.
An unverified number, one still in Meta's test state, or an on-premise
deployment would all have connected identically and only failed later — so the
properties worth proving here are the ones that would let a non-qualifying
account through, and the one that would leave a qualifying one stuck:

  * each of the four business checks rejects, with its own message
  * the number must belong to the Business Account that was pasted, not merely
    exist somewhere — otherwise any approved WABA id satisfies the gate
  * a token missing whatsapp_business_management is diagnosed as such, not
    blamed on the credentials
  * connecting leaves the connection PENDING and unusable for sending
  * Meta's own webhook verification request is what promotes it — and a wrong
    verify token does not
  * re-pasting credentials never un-confirms a live connection

The signature/parse-level tests live in tests/test_whatsapp_signature.py; only
the things needing real RLS, real constraints and the real app live here.
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

WABA = "WABA-123"
PNID = "PNID-999"
ACCESS_TOKEN = "EAAG-system-user-token"
APP_SECRET = "meta-app-secret"

#: A fully qualifying account: approved business, verified Cloud API number.
GOOD_ACCOUNT = {"id": WABA, "name": "Acme Ltd", "account_review_status": "APPROVED"}
GOOD_NUMBER = {
    "id": PNID,
    "display_phone_number": "+15550009999",
    "verified_name": "Acme",
    "code_verification_status": "VERIFIED",
    "platform_type": "CLOUD_API",
}


def _principal(user_id=ME, org_id=ORG):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=["admin"], username="me")


async def _client(principal=None):
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: principal or _principal()
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture
def meta(monkeypatch):
    """Stub Meta's two Graph reads. Mutate `meta['account']` / `meta['numbers']`
    in a test to describe an account that shouldn't qualify."""
    from app.providers import whatsapp

    state = {"account": dict(GOOD_ACCOUNT), "numbers": [dict(GOOD_NUMBER)], "raise": None}

    async def _graph_get(access_token, path, fields):
        if state["raise"] is not None:
            raise state["raise"]
        if path.endswith("/phone_numbers"):
            return {"data": state["numbers"]}
        return state["account"]

    monkeypatch.setattr(whatsapp, "_graph_get", _graph_get)
    return state


async def _connect(c, waba=WABA, pnid=PNID):
    return await c.post(
        "/api/v1/integrations/whatsapp/connect/start",
        json={
            "accessToken": ACCESS_TOKEN,
            "wabaId": waba,
            "phoneNumberId": pnid,
            "appSecret": APP_SECRET,
        },
    )


async def _status(conn_id: str) -> str:
    from app.db import get_engine

    async with get_engine().begin() as c:
        await c.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        return (
            await c.execute(
                text("SELECT status FROM integration_connections WHERE id = :i"), {"i": conn_id}
            )
        ).scalar_one()


async def _webhook_bits(c, conn_id: str) -> tuple[str, str]:
    """The webhook token (from the DB) and verify token (from the API) an admin
    would paste into Meta."""
    from app.db import get_engine

    async with get_engine().begin() as db:
        await db.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        wh = (
            await db.execute(
                text("SELECT webhook_token FROM integration_connections WHERE id = :i"),
                {"i": conn_id},
            )
        ).scalar_one()
    verify = next(
        x["webhookVerifyToken"]
        for x in (await c.get("/api/v1/integrations")).json()
        if x["id"] == conn_id
    )
    return wh, verify


# ── the business gate ─────────────────────────────────────────────────────────
async def test_an_approved_business_number_connects(db_app, meta):
    async with await _client() as c:
        r = await _connect(c)
        assert r.status_code == 200, r.text
        # Labelled by the business number, which is what an admin recognises.
        assert r.json()["connection"]["displayLabel"] == "+15550009999"


async def test_all_four_credentials_are_required(db_app, meta):
    """wabaId is a credential, not an optional extra — without it the gate has
    nothing to check membership against."""
    async with await _client() as c:
        r = await c.post(
            "/api/v1/integrations/whatsapp/connect/start",
            json={"accessToken": ACCESS_TOKEN, "phoneNumberId": PNID, "appSecret": APP_SECRET},
        )
        assert r.status_code == 400
        assert "wabaId" in r.text


async def test_unapproved_business_account_is_rejected(db_app, meta):
    meta["account"]["account_review_status"] = "PENDING"
    async with await _client() as c:
        r = await _connect(c)
        assert r.status_code == 400
        assert "hasn't been approved" in r.json()["error"]["message"]


async def test_unverified_number_is_rejected(db_app, meta):
    meta["numbers"][0]["code_verification_status"] = "NOT_VERIFIED"
    async with await _client() as c:
        r = await _connect(c)
        assert r.status_code == 400
        assert "verification" in r.json()["error"]["message"]


async def test_on_premise_number_is_rejected(db_app, meta):
    # It would pass every other check and then fail to send through Cloud API.
    meta["numbers"][0]["platform_type"] = "ON_PREMISE"
    async with await _client() as c:
        r = await _connect(c)
        assert r.status_code == 400
        assert "Cloud API" in r.json()["error"]["message"]


async def test_a_number_from_another_business_is_rejected(db_app, meta):
    """The load-bearing check. Without membership, pairing any APPROVED account
    id with an unrelated verified number would satisfy the gate."""
    meta["numbers"] = [dict(GOOD_NUMBER, id="SOMEONE-ELSES-NUMBER")]
    async with await _client() as c:
        r = await _connect(c)
        assert r.status_code == 400
        assert "doesn't belong to" in r.json()["error"]["message"]


async def test_a_rejected_account_stores_nothing(db_app, meta):
    meta["account"]["account_review_status"] = "REJECTED"
    async with await _client() as c:
        await _connect(c)
        assert (await c.get("/api/v1/integrations")).json() == []


async def test_missing_management_permission_says_so(db_app, meta):
    """Sending needs whatsapp_business_messaging; reading the account needs
    whatsapp_business_management. People grant the first and not the second, and
    "WhatsApp rejected the credentials" would send them hunting for a typo in a
    token that is perfectly good."""
    from app.providers import whatsapp

    meta["raise"] = whatsapp.WhatsAppPermissionError(
        "your system-user token also needs the `whatsapp_business_management` permission"
    )
    async with await _client() as c:
        r = await _connect(c)
        assert r.status_code == 400
        assert "whatsapp_business_management" in r.json()["error"]["message"]


# ── pending until Meta calls ──────────────────────────────────────────────────
async def test_connect_leaves_it_pending_and_unusable(db_app, meta, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "internal_token", "test-internal")
    async with await _client() as c:
        conn_id = (await _connect(c)).json()["connection"]["id"]
        assert await _status(conn_id) == "pending"

        # Nothing may be forwarded through a connection Meta hasn't reached yet.
        r = await c.post(
            "/internal/messages/send",
            headers={"X-Internal-Token": "test-internal"},
            json={"orgId": ORG, "connectionId": conn_id, "target": "15551234567", "text": "hi"},
        )
        assert r.status_code == 404


async def test_metas_webhook_handshake_confirms_the_connection(db_app, meta):
    """THE confirmation. Meta sends this the moment the admin saves the webhook
    URL — no code, no template, nobody's personal phone."""
    async with await _client() as c:
        conn_id = (await _connect(c)).json()["connection"]["id"]
        wh, verify = await _webhook_bits(c, conn_id)

        r = await c.get(
            f"/ext/whatsapp/webhook/{wh}",
            params={
                "hub.mode": "subscribe",
                "hub.verify_token": verify,
                "hub.challenge": "echo-me",
            },
        )
        assert r.status_code == 200
        assert r.text == "echo-me"  # Meta only accepts the echoed challenge
    assert await _status(conn_id) == "connected"


async def test_a_wrong_verify_token_confirms_nothing(db_app, meta):
    async with await _client() as c:
        conn_id = (await _connect(c)).json()["connection"]["id"]
        wh, _ = await _webhook_bits(c, conn_id)

        r = await c.get(
            f"/ext/whatsapp/webhook/{wh}",
            params={
                "hub.mode": "subscribe",
                "hub.verify_token": "not-the-token",
                "hub.challenge": "echo-me",
            },
        )
        assert r.status_code == 403
    assert await _status(conn_id) == "pending"


async def test_reconnecting_does_not_unconfirm_a_live_connection(db_app, meta):
    """The webhook URL survives a re-connect, so what the handshake proved is
    still true. Meta won't re-send it unless the admin clicks Verify and save
    again — dropping back to pending here would strand a working connection."""
    async with await _client() as c:
        conn_id = (await _connect(c)).json()["connection"]["id"]
        wh, verify = await _webhook_bits(c, conn_id)
        await c.get(
            f"/ext/whatsapp/webhook/{wh}",
            params={"hub.mode": "subscribe", "hub.verify_token": verify, "hub.challenge": "x"},
        )
        assert await _status(conn_id) == "connected"

        # Rotate the access token, same number.
        r = await c.post(
            "/api/v1/integrations/whatsapp/connect/start",
            json={
                "accessToken": "EAAG-rotated",
                "wabaId": WABA,
                "phoneNumberId": PNID,
                "appSecret": APP_SECRET,
            },
        )
        assert r.status_code == 200
        assert r.json()["connection"]["status"] == "connected"
    assert await _status(conn_id) == "connected"


# ── inbound while pending ─────────────────────────────────────────────────────
def _inbound(body: str, wamid: str = "wamid.A") -> bytes:
    return json.dumps(
        {
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
                                        "text": {"body": body},
                                    }
                                ],
                            }
                        }
                    ]
                }
            ]
        }
    ).encode()


async def test_messages_arriving_before_confirmation_are_dropped(db_app, meta):
    """A connection the product still shows as not-ready must not start filling
    someone's hub — that is how a half-finished setup starts looking finished."""
    async with await _client() as c:
        conn_id = (await _connect(c)).json()["connection"]["id"]
        wh, _ = await _webhook_bits(c, conn_id)

        raw = _inbound("hello there")
        sig = "sha256=" + hmac.new(APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()
        r = await c.post(
            f"/ext/whatsapp/webhook/{wh}", content=raw, headers={"X-Hub-Signature-256": sig}
        )
        assert r.status_code == 200  # ack it; Meta retries anything else forever
        assert (await c.get("/api/v1/integrations/activity")).json() == []
    assert await _status(conn_id) == "pending"


async def test_messages_are_ingested_once_confirmed(db_app, meta):
    async with await _client() as c:
        conn_id = (await _connect(c)).json()["connection"]["id"]
        wh, verify = await _webhook_bits(c, conn_id)
        await c.get(
            f"/ext/whatsapp/webhook/{wh}",
            params={"hub.mode": "subscribe", "hub.verify_token": verify, "hub.challenge": "x"},
        )

        raw = _inbound("hello there", wamid="wamid.B")
        sig = "sha256=" + hmac.new(APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()
        await c.post(
            f"/ext/whatsapp/webhook/{wh}", content=raw, headers={"X-Hub-Signature-256": sig}
        )
        acts = (await c.get("/api/v1/integrations/activity")).json()
        assert [a["body"] for a in acts] == ["hello there"]
