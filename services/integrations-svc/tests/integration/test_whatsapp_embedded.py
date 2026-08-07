"""WhatsApp Embedded Signup — the one-click path, against a real Postgres.

The customer supplies nothing but a click: no developer app, no token, no app
secret, no IDs. Everything that could go wrong therefore goes wrong on OUR side,
which is what these tests are about:

  * unconfigured deployment says so, instead of opening a popup that dies at Meta
  * the popup's claims are re-checked against Meta, not trusted
  * a failed webhook subscription does NOT produce a connected connection —
    subscribing is the proof, so without it there is nothing to be confident about
  * the connection carries phoneNumberId in metadata, because outbound sending
    reads it from there and its absence would only surface on the first forward
  * no per-connection webhook URL is offered, since there is nothing to paste
  * a second workspace cannot claim a number the first one already has
"""

from __future__ import annotations

import json

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
OTHER_ORG = "22222222-2222-2222-2222-222222222222"
ME = "33333333-3333-3333-3333-333333333333"

WABA = "WABA-123"
PNID = "PNID-999"

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
def configured(monkeypatch):
    """A deployment that IS an approved Meta Tech Provider."""
    from app.config import settings

    monkeypatch.setattr(settings, "meta_app_id", "APP-1")
    monkeypatch.setattr(settings, "meta_config_id", "CFG-1")
    monkeypatch.setattr(settings, "meta_app_secret", "app-secret")


@pytest.fixture
def meta(monkeypatch):
    """Stub every Graph call Embedded Signup makes."""
    from app.providers import whatsapp

    state = {
        "account": dict(GOOD_ACCOUNT),
        "numbers": [dict(GOOD_NUMBER)],
        "subscribed": [],
        "registered": [],
        "subscribe_error": None,
    }

    async def _graph_get(access_token, path, fields):
        if path.endswith("/phone_numbers"):
            return {"data": state["numbers"]}
        return state["account"]

    async def _exchange(app_id, app_secret, code):
        return f"token-for-{code}"

    async def _subscribe(token, waba_id):
        if state["subscribe_error"] is not None:
            raise state["subscribe_error"]
        state["subscribed"].append(waba_id)

    async def _register(token, pnid, pin):
        state["registered"].append((pnid, pin))

    monkeypatch.setattr(whatsapp, "_graph_get", _graph_get)
    monkeypatch.setattr(whatsapp, "exchange_embedded_code", _exchange)
    monkeypatch.setattr(whatsapp, "subscribe_app", _subscribe)
    monkeypatch.setattr(whatsapp, "register_number", _register)
    return state


async def _signup(c, waba=WABA, pnid=PNID, code="popup-code"):
    return await c.post(
        "/api/v1/integrations/whatsapp/embedded/exchange",
        json={"code": code, "wabaId": waba, "phoneNumberId": pnid},
    )


# ── availability ──────────────────────────────────────────────────────────────
async def test_reports_unavailable_until_configured(db_app):
    """Better an honest 'not yet' than a popup that dies on Meta's side with an
    error the customer can do nothing about."""
    async with await _client() as c:
        r = await c.get("/api/v1/integrations/whatsapp/embedded")
        assert r.status_code == 200
        assert r.json()["available"] is False


async def test_exchange_is_refused_until_configured(db_app, meta):
    async with await _client() as c:
        r = await _signup(c)
        assert r.status_code == 409
        assert "advanced" in r.json()["error"]["message"].lower()


async def test_config_exposes_ids_but_never_the_secret(db_app, configured):
    async with await _client() as c:
        r = await c.get("/api/v1/integrations/whatsapp/embedded")
        body = r.json()
        assert body == {
            "available": True,
            "appId": "APP-1",
            "configId": "CFG-1",
            "graphVersion": body["graphVersion"],
        }
        # The app id and config id travel in the popup URL; the secret must not
        # leave the server on any field, ever.
        assert "app-secret" not in r.text


# ── the happy path ────────────────────────────────────────────────────────────
async def test_one_click_signup_produces_a_connected_account(db_app, configured, meta):
    async with await _client() as c:
        r = await _signup(c)
        assert r.status_code == 200, r.text
        conn = r.json()["connection"]

        # Connected, not pending: subscribing our app to their webhooks IS the
        # proof the manual flow gets from the hub.challenge handshake.
        assert conn["status"] == "connected"
        assert conn["displayLabel"] == "+15550009999"
        # A WABA belongs to the workspace, not to whoever clicked.
        assert conn["scopeKind"] == "org"
        # Nothing to paste anywhere — that is the entire point.
        assert conn["webhookUrl"] is None
        assert conn["webhookVerifyToken"] is None

    assert meta["subscribed"] == [WABA]
    assert meta["registered"] and meta["registered"][0][0] == PNID


async def test_metadata_carries_what_outbound_needs(db_app, configured, meta):
    """outbound._send_whatsapp addresses every send with phoneNumberId read from
    this blob. Its absence wouldn't fail here — it would fail on the first
    forward, long after anyone connected the account."""
    from app.crypto import cryptor
    from app.db import get_engine

    async with await _client() as c:
        conn_id = (await _signup(c)).json()["connection"]["id"]

    async with get_engine().begin() as db:
        await db.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        blob = (
            await db.execute(
                text("SELECT metadata_enc FROM integration_connections WHERE id = :i"),
                {"i": conn_id},
            )
        ).scalar_one()
        meta_json = json.loads(await cryptor().decrypt(db, ORG, bytes(blob)))

    assert meta_json["phoneNumberId"] == PNID
    assert meta_json["wabaId"] == WABA
    assert meta_json["embedded"] is True
    # No per-connection secrets: under Embedded Signup the app secret and verify
    # token are app-level, which is exactly what the customer gets to skip.
    assert "appSecret" not in meta_json
    assert "verifyToken" not in meta_json


async def test_the_registration_pin_is_stable_across_reconnects(db_app, configured, meta):
    """Re-registering must not need a PIN nobody stored. Deriving it means the
    same account always yields the same PIN without another secret to protect."""
    async with await _client() as c:
        await _signup(c)
        first = meta["registered"][0][1]
        await _signup(c, code="another-code")
        assert meta["registered"][1][1] == first
        assert len(first) == 6 and first.isdigit()


# ── the popup's claims are not trusted ────────────────────────────────────────
async def test_the_business_gate_still_applies(db_app, configured, meta):
    """The popup told us which account was picked. That is a client claim, and
    it goes through the same gate as a manually pasted one."""
    meta["account"]["account_review_status"] = "PENDING"
    async with await _client() as c:
        r = await _signup(c)
        assert r.status_code == 400
        assert "hasn't been approved" in r.json()["error"]["message"]
        assert (await c.get("/api/v1/integrations")).json() == []


async def test_a_number_from_another_business_is_rejected(db_app, configured, meta):
    meta["numbers"] = [dict(GOOD_NUMBER, id="SOMEONE-ELSES")]
    async with await _client() as c:
        r = await _signup(c)
        assert r.status_code == 400
        assert "doesn't belong to" in r.json()["error"]["message"]


async def test_a_failed_subscription_does_not_connect_anything(db_app, configured, meta):
    """Subscribing is the proof. Without it, Meta delivers this account's
    messages nowhere, and a 'connected' row would be a lie discovered only when
    someone noticed nothing was arriving."""
    from app.providers import whatsapp

    meta["subscribe_error"] = whatsapp.WhatsAppError("could not subscribe")
    async with await _client() as c:
        r = await _signup(c)
        assert r.status_code == 400
        assert (await c.get("/api/v1/integrations")).json() == []


async def test_our_missing_permission_is_reported_as_ours(db_app, configured, meta):
    """A Tech Provider app lacking advanced access is our problem to fix. Telling
    the customer their account was rejected would send them to Meta support for
    something they cannot change."""
    from app.providers import whatsapp

    meta["subscribe_error"] = whatsapp.WhatsAppPermissionError("advanced access required")
    async with await _client() as c:
        r = await _signup(c)
        assert r.status_code == 502
        assert "BlissWork's WhatsApp app" in r.json()["error"]["message"]


# ── cross-tenant safety ───────────────────────────────────────────────────────
async def test_a_second_workspace_cannot_claim_the_same_number(db_app, configured, meta):
    """Embedded Signup routes every org's webhooks to ONE app-level URL, resolved
    purely by phone_number_id. Two orgs holding the same number would misroute
    one workspace's messages into another's."""
    async with await _client(_principal(org_id=ORG)) as c:
        assert (await _signup(c)).status_code == 200

    async with await _client(_principal(org_id=OTHER_ORG)) as c:
        r = await _signup(c)
        assert r.status_code == 409
        assert "another BlissWork workspace" in r.json()["error"]["message"]
        assert (await c.get("/api/v1/integrations")).json() == []


async def test_the_same_workspace_reconnecting_refreshes_in_place(db_app, configured, meta):
    async with await _client() as c:
        first = (await _signup(c)).json()["connection"]["id"]
        again = await _signup(c, code="fresh-code")
        assert again.status_code == 200
        assert again.json()["connection"]["id"] == first
        assert len((await c.get("/api/v1/integrations")).json()) == 1
