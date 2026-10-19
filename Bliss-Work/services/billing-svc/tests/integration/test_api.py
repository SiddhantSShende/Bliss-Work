"""API-level integration tests: the real FastAPI app over httpx (ASGI
transport), auth via dependency override (mirrors task-svc's pattern — see
task-svc/tests/integration/test_reassign_task.py)."""
from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
OTHER_ORG = "22222222-2222-2222-2222-222222222222"
MEMBER = "33333333-3333-3333-3333-333333333333"
ADMIN = "44444444-4444-4444-4444-444444444444"
OPERATOR = "55555555-5555-5555-5555-555555555555"


def _id() -> str:
    return str(uuid.uuid4())


def _as(user_id: str, org: str = ORG, roles: list[str] | None = None) -> httpx.AsyncClient:
    from app.auth import Principal, require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: Principal(
        user_id=user_id, org_id=org, roles=roles or ["member"], username="u"
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _grant_operator(user_id: str) -> None:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(
            text("INSERT INTO platform_operators (user_id) VALUES (:u) ON CONFLICT DO NOTHING"),
            {"u": user_id},
        )


@pytest.mark.asyncio
async def test_balance_is_scoped_to_callers_own_org(db_app):
    from app import ledger
    from app.db import session

    async with session() as db:
        await ledger.grant_credits(db, ORG, 7, "monthly_grant")
        await ledger.grant_credits(db, OTHER_ORG, 99, "monthly_grant")
        await db.commit()

    async with _as(MEMBER, org=ORG) as c:
        r = await c.get("/api/v1/billing/balance")
    assert r.status_code == 200, r.text
    assert r.json() == {"orgId": ORG, "balance": 7}


@pytest.mark.asyncio
async def test_ledger_list_only_shows_callers_org(db_app):
    from app import ledger
    from app.db import session

    async with session() as db:
        await ledger.grant_credits(db, ORG, 5, "monthly_grant")
        await ledger.grant_credits(db, OTHER_ORG, 5, "monthly_grant")
        await db.commit()

    async with _as(MEMBER, org=ORG) as c:
        r = await c.get("/api/v1/billing/ledger")
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 1
    assert body[0]["delta"] == 5


@pytest.mark.asyncio
async def test_reconcile_requires_org_admin(db_app):
    async with _as(MEMBER, org=ORG, roles=["member"]) as c:
        r = await c.get("/api/v1/billing/balance/reconcile")
    assert r.status_code == 403

    async with _as(ADMIN, org=ORG, roles=["org_admin"]) as c:
        r = await c.get("/api/v1/billing/balance/reconcile")
    assert r.status_code == 200, r.text
    assert r.json()["matches"] is True


@pytest.mark.asyncio
async def test_package_list_hides_inactive_but_detail_still_resolves(db_app):
    from app.db import get_engine

    active_id, inactive_id = _id(), _id()
    async with get_engine().begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO credit_packages (id, name, credits, price_cents, active) "
                "VALUES (:id, 'Starter', 100, 10000, true)"
            ),
            {"id": active_id},
        )
        await conn.execute(
            text(
                "INSERT INTO credit_packages (id, name, credits, price_cents, active) "
                "VALUES (:id, 'Retired', 50, 5000, false)"
            ),
            {"id": inactive_id},
        )

    async with _as(MEMBER) as c:
        listed = await c.get("/api/v1/billing/packages")
        detail_active = await c.get(f"/api/v1/billing/packages/{active_id}")
        detail_inactive = await c.get(f"/api/v1/billing/packages/{inactive_id}")

    assert {p["id"] for p in listed.json()} == {active_id}
    assert detail_active.status_code == 200
    assert detail_inactive.status_code == 200
    assert detail_inactive.json()["active"] is False


@pytest.mark.asyncio
async def test_package_write_requires_platform_operator_not_org_admin(db_app):
    """org_admin must NOT be treated as a platform operator — only a row in
    platform_operators grants write access."""
    payload = {"name": "Pack", "credits": 10, "priceCents": 1000, "currency": "usd"}

    async with _as(ADMIN, org=ORG, roles=["org_admin"]) as c:
        r = await c.post("/api/v1/billing/packages", json=payload)
    assert r.status_code == 403, r.text

    await _grant_operator(OPERATOR)
    async with _as(OPERATOR, org=ORG, roles=["member"]) as c:
        r = await c.post("/api/v1/billing/packages", json=payload)
    assert r.status_code == 201, r.text
    assert r.json()["credits"] == 10


@pytest.mark.asyncio
async def test_deactivating_package_does_not_alter_historical_purchase_snapshot(db_app):
    from app.db import get_engine

    await _grant_operator(OPERATOR)
    async with _as(OPERATOR) as c:
        created = await c.post(
            "/api/v1/billing/packages",
            json={"name": "Pack", "credits": 20, "priceCents": 2000, "currency": "usd"},
        )
    package_id = created.json()["id"]

    purchase_id = _id()
    async with get_engine().begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO credit_purchases (id, org_id, package_id, credits, amount_cents, status) "
                "VALUES (:pid, :org, :package, 20, 2000, 'completed')"
            ),
            {"pid": purchase_id, "org": ORG, "package": package_id},
        )

    async with _as(OPERATOR) as c:
        r = await c.patch(f"/api/v1/billing/packages/{package_id}", json={"active": False, "priceCents": 9999})
    assert r.status_code == 200, r.text
    assert r.json()["active"] is False
    assert r.json()["priceCents"] == 9999

    async with get_engine().begin() as conn:
        row = (
            await conn.execute(
                text("SELECT credits, amount_cents FROM credit_purchases WHERE id = :pid"),
                {"pid": purchase_id},
            )
        ).first()
    assert (row.credits, row.amount_cents) == (20, 2000)


@pytest.mark.asyncio
async def test_pricing_defaults_seeded_by_migration(db_app):
    async with _as(MEMBER) as c:
        r = await c.get("/api/v1/billing/pricing")
    assert r.status_code == 200
    values = {row["key"]: row["value"] for row in r.json()}
    assert values["admin_monthly_credits"] == 3
    assert values["member_monthly_credits"] == 1
    assert values["admin_reference_price_cents"] == 800
    assert values["member_reference_price_cents"] == 500
    assert values["admin_current_price_cents"] == 300
    assert values["member_current_price_cents"] == 100


@pytest.mark.asyncio
async def test_pricing_write_requires_platform_operator_and_is_audited(db_app):
    from app.db import get_engine

    async with _as(ADMIN, org=ORG, roles=["org_admin"]) as c:
        r = await c.put("/api/v1/billing/pricing/admin_current_price_cents", json={"value": 250})
    assert r.status_code == 403, r.text

    await _grant_operator(OPERATOR)
    async with _as(OPERATOR) as c:
        r = await c.put("/api/v1/billing/pricing/admin_current_price_cents", json={"value": 250})
    assert r.status_code == 200, r.text
    assert r.json()["value"] == 250
    assert r.json()["updatedBy"] == OPERATOR

    async with get_engine().begin() as conn:
        outbox_row = (
            await conn.execute(
                text("SELECT payload FROM outbox WHERE topic = 'billing.pricing_changed.v1'")
            )
        ).first()
    assert outbox_row is not None
    assert outbox_row.payload["newValue"] == 250
    assert outbox_row.payload["changedBy"] == OPERATOR


@pytest.mark.asyncio
async def test_pricing_write_rejects_unknown_key(db_app):
    await _grant_operator(OPERATOR)
    async with _as(OPERATOR) as c:
        r = await c.put("/api/v1/billing/pricing/not_a_real_key", json={"value": 1})
    assert r.status_code == 404
