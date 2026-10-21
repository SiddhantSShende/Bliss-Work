"""Credit-purchase quote/initiation + Cashfree webhook integration tests.

FX is monkeypatched to a fixed rate (never hits the live provider in tests)
so these are deterministic; a separate unit test covers the "no fallback on
provider failure" behaviour of app/fx.py directly.
"""
from __future__ import annotations

import hashlib
import hmac
import base64
import json
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
ADMIN = "44444444-4444-4444-4444-444444444444"
MEMBER = "33333333-3333-3333-3333-333333333333"

_FIXED_RATE = Decimal("90")  # 1 USD = 90 INR, for deterministic math


def _id() -> str:
    return str(uuid.uuid4())


def _as(user_id: str, org: str = ORG, roles: list[str] | None = None) -> httpx.AsyncClient:
    from app.auth import Principal, require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: Principal(
        user_id=user_id, org_id=org, roles=roles or ["org_admin"], username="u"
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.fixture(autouse=True)
def _fixed_fx(monkeypatch):
    async def fake_get_usd_rate(db, target_currency):
        rate = _FIXED_RATE if target_currency.upper() == "INR" else Decimal("0.8")
        return float(rate), "test-fixed", datetime.now(timezone.utc)

    monkeypatch.setattr("app.pricing_quote.fx.get_usd_rate", fake_get_usd_rate)
    yield


@pytest.mark.asyncio
async def test_quote_calculation_matches_worked_example(db_app):
    # 10 credits @ $1 = $10 -> INR 900 pre-uplift -> +2% uplift = 918 base ->
    # +18% GST of 918 = 165.24 -> total 1083.24
    async with _as(ADMIN) as c:
        r = await c.post("/api/v1/billing/purchases/quote", json={"credits": 10})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["baseInr"] == "918.00"
    assert body["gstInr"] == "165.24"
    assert body["totalPayableInr"] == "1083.24"
    assert body["fxRate"] == "90"


@pytest.mark.asyncio
async def test_quote_rounding_is_deterministic_across_calls(db_app):
    async with _as(ADMIN) as c:
        r1 = await c.post("/api/v1/billing/purchases/quote", json={"credits": 13})
        r2 = await c.post("/api/v1/billing/purchases/quote", json={"credits": 13})
    assert r1.json()["totalPayableInr"] == r2.json()["totalPayableInr"]


@pytest.mark.asyncio
async def test_first_purchase_minimum_enforced(db_app):
    async with _as(ADMIN) as c:
        r = await c.post("/api/v1/billing/purchases", json={"credits": 5})
    assert r.status_code == 422, r.text

    async with _as(ADMIN) as c:
        r = await c.post("/api/v1/billing/purchases", json={"credits": 10})
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_purchases_require_org_admin(db_app):
    async with _as(MEMBER, roles=["member"]) as c:
        r = await c.post("/api/v1/billing/purchases", json={"credits": 10})
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_org_isolation_on_purchase_lookup(db_app):
    other_org = _id()
    async with _as(ADMIN) as c:
        r = await c.post(
            "/api/v1/billing/purchases",
            json={"credits": 10},
            headers={"Idempotency-Key": _id()},
        )
    purchase_id = r.json()["id"]

    async with _as(ADMIN, org=other_org) as c:
        r2 = await c.get(f"/api/v1/billing/purchases/{purchase_id}")
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_idempotency_key_reuse_returns_same_pending_purchase(db_app):
    key = _id()
    async with _as(ADMIN) as c:
        r1 = await c.post(
            "/api/v1/billing/purchases", json={"credits": 10}, headers={"Idempotency-Key": key}
        )
        r2 = await c.post(
            "/api/v1/billing/purchases", json={"credits": 10}, headers={"Idempotency-Key": key}
        )
    assert r1.status_code == 201, r1.text
    assert r2.status_code == 201, r2.text
    assert r1.json()["id"] == r2.json()["id"]

    async with _get_engine_conn() as conn:
        rows = (
            await conn.execute(
                text("SELECT count(*) FROM credit_purchases WHERE idempotency_key = :k"), {"k": key}
            )
        ).first()
    assert rows[0] == 1


def _get_engine_conn():
    from app.db import get_engine

    return get_engine().begin()


def _sign(secret: str, timestamp: str, body: bytes) -> str:
    digest = hmac.new(secret.encode(), timestamp.encode() + body, hashlib.sha256).digest()
    return base64.b64encode(digest).decode()


async def _make_pending_purchase(db_app) -> str:
    from app.db import session

    purchase_id = _id()
    gw_order_id = f"po_{uuid.uuid4().hex[:24]}"
    async with session() as db:
        await db.execute(
            text(
                "INSERT INTO credit_purchases (id, org_id, credits, amount_cents, currency, "
                "payment_provider, status, requested_credits, gateway_order_id) "
                "VALUES (:id, :org, 10, 108324, 'inr', 'cashfree', 'pending', 10, :gw)"
            ),
            {"id": purchase_id, "org": ORG, "gw": gw_order_id},
        )
        await db.commit()
    return purchase_id, gw_order_id


@pytest.mark.asyncio
async def test_invalid_webhook_signature_rejected(db_app, monkeypatch):
    monkeypatch.setattr("app.config.settings.cashfree_webhook_secret", "test-secret")
    purchase_id, gw_order_id = await _make_pending_purchase(db_app)
    body = json.dumps(
        {"type": "PAYMENT_SUCCESS_WEBHOOK", "data": {"order": {"order_id": gw_order_id}}}
    ).encode()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=__import__("app.main", fromlist=["app"]).app),
        base_url="http://test",
    ) as c:
        r = await c.post(
            "/webhooks/cashfree",
            content=body,
            headers={
                "x-webhook-timestamp": "123",
                "x-webhook-signature": "not-the-right-signature",
                "content-type": "application/json",
            },
        )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_duplicate_webhook_is_noop_and_grants_credits_once(db_app, monkeypatch):
    monkeypatch.setattr("app.config.settings.cashfree_webhook_secret", "test-secret")
    purchase_id, gw_order_id = await _make_pending_purchase(db_app)
    body = json.dumps(
        {"type": "PAYMENT_SUCCESS_WEBHOOK", "data": {"order": {"order_id": gw_order_id}}}
    ).encode()
    ts = "123"
    sig = _sign("test-secret", ts, body)
    headers = {"x-webhook-timestamp": ts, "x-webhook-signature": sig, "content-type": "application/json"}

    from app.main import app

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        r1 = await c.post("/webhooks/cashfree", content=body, headers=headers)
        r2 = await c.post("/webhooks/cashfree", content=body, headers=headers)
    assert r1.status_code == 200 and r1.json()["status"] == "completed"
    assert r2.status_code == 200 and r2.json()["status"] == "noop"

    async with _as(ADMIN) as c:
        bal = await c.get("/api/v1/billing/balance")
    assert bal.json()["balance"] == 10  # granted exactly once


@pytest.mark.asyncio
async def test_out_of_order_failed_after_success_does_not_regress(db_app, monkeypatch):
    monkeypatch.setattr("app.config.settings.cashfree_webhook_secret", "test-secret")
    purchase_id, gw_order_id = await _make_pending_purchase(db_app)
    success_body = json.dumps(
        {"type": "PAYMENT_SUCCESS_WEBHOOK", "data": {"order": {"order_id": gw_order_id}}}
    ).encode()
    failed_body = json.dumps(
        {"type": "PAYMENT_FAILED_WEBHOOK", "data": {"order": {"order_id": gw_order_id}}}
    ).encode()
    ts = "123"

    from app.main import app

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        await c.post(
            "/webhooks/cashfree",
            content=success_body,
            headers={
                "x-webhook-timestamp": ts,
                "x-webhook-signature": _sign("test-secret", ts, success_body),
                "content-type": "application/json",
            },
        )
        r = await c.post(
            "/webhooks/cashfree",
            content=failed_body,
            headers={
                "x-webhook-timestamp": ts,
                "x-webhook-signature": _sign("test-secret", ts, failed_body),
                "content-type": "application/json",
            },
        )
    assert r.json()["status"] == "noop"

    async with _as(ADMIN) as c:
        row = await c.get(f"/api/v1/billing/purchases/{purchase_id}")
    assert row.json()["status"] == "completed"
