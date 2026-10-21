"""Phase 4: the /internal/v1/billing/* HTTP surface auth-svc calls."""
from __future__ import annotations

import uuid

import httpx
import pytest

pytestmark = pytest.mark.integration

TOKEN = "test-internal-token"


def _id() -> str:
    return str(uuid.uuid4())


@pytest.fixture(autouse=True)
def _set_internal_token(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "internal_token", TOKEN)


def _client() -> httpx.AsyncClient:
    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_missing_or_wrong_internal_token_is_rejected(db_app):
    org, user = _id(), _id()
    async with _client() as c:
        r = await c.post(f"/internal/v1/billing/orgs/{org}/memberships/{user}", json={"role": "member"})
        assert r.status_code == 401
        r = await c.post(
            f"/internal/v1/billing/orgs/{org}/memberships/{user}",
            json={"role": "member"},
            headers={"X-Internal-Token": "wrong"},
        )
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_commitment_check_returns_402_json_when_unaffordable(db_app):
    org, user = _id(), _id()
    async with _client() as c:
        r = await c.post(
            f"/internal/v1/billing/orgs/{org}/memberships/{user}",
            json={"role": "org_admin"},
            headers={"X-Internal-Token": TOKEN},
        )
    assert r.status_code == 402, r.text
    assert "credits" in r.json()["error"]["message"]


@pytest.mark.asyncio
async def test_commitment_check_succeeds_and_release_is_idempotent(db_app):
    from app import ledger
    from app.db import session

    org, user = _id(), _id()
    async with session() as db:
        await ledger.grant_credits(db, org, 5, "test_seed")
        await db.commit()

    async with _client() as c:
        r = await c.post(
            f"/internal/v1/billing/orgs/{org}/memberships/{user}",
            json={"role": "member"},
            headers={"X-Internal-Token": TOKEN},
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True, "projectedTotal": 2, "balance": 5}

        r1 = await c.delete(f"/internal/v1/billing/orgs/{org}/memberships/{user}", headers={"X-Internal-Token": TOKEN})
        r2 = await c.delete(f"/internal/v1/billing/orgs/{org}/memberships/{user}", headers={"X-Internal-Token": TOKEN})
    assert r1.status_code == 200
    assert r2.status_code == 200


@pytest.mark.asyncio
async def test_unknown_role_returns_400(db_app):
    org, user = _id(), _id()
    async with _client() as c:
        r = await c.post(
            f"/internal/v1/billing/orgs/{org}/memberships/{user}",
            json={"role": "superuser"},
            headers={"X-Internal-Token": TOKEN},
        )
    assert r.status_code == 400
