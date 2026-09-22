"""org_admin gating on org-wide integration connections.

Token-paste connections (Slack today) and org-wide disconnects are a shared,
organization-wide credential — any member could previously create one (and
silently overwrite the org's existing credential for that provider, via the
ON CONFLICT upsert in _upsert_connection) or revoke one, with no role check at
all. This mirrors the org_admin gate routes/app_creds.py already has on the
org's OAuth app credentials.

A user's OWN (owner_user_id = their id) connection — e.g. a personal Outlook
OAuth connection — stays self-service and must NOT require org_admin.
"""

from __future__ import annotations

import httpx
import pytest
import uuid6
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
ME = "33333333-3333-3333-3333-333333333333"


def _principal(roles: list[str]):
    from app.auth import Principal

    return Principal(user_id=ME, org_id=ORG, roles=roles, username="me", plan="enterprise")


async def _client(principal):
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: principal
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def _seed_connection(*, owner_user_id: str | None) -> str:
    """Insert a connection row directly, bypassing connect_start (which for
    Slack would call out to the real API) — this file is about the route's
    authorization, not provider validation."""
    from app.db import get_engine

    conn_id = str(uuid6.uuid7())
    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text(
                """
                INSERT INTO integration_connections
                    (id, org_id, owner_user_id, created_by, scope_kind, provider,
                     status, display_label)
                VALUES (:id, :o, :owner, :u, :scope, 'slack', 'connected', 'T')
                """
            ),
            {
                "id": conn_id,
                "o": ORG,
                "owner": owner_user_id,
                "u": ME,
                "scope": "org" if owner_user_id is None else "user",
            },
        )
    return conn_id


async def test_token_paste_connect_start_requires_org_admin(db_app):
    async with await _client(_principal([])) as c:
        r = await c.post("/api/v1/integrations/slack/connect/start", json={})
        assert r.status_code == 403, r.text
        assert "org_admin" in r.json()["error"]["message"]


async def test_token_paste_connect_start_admin_reaches_past_the_gate(db_app):
    # An org_admin must NOT be stopped by the new gate — proven by getting past
    # it to the NEXT check (missing credentials), not by a real Slack call.
    async with await _client(_principal(["org_admin"])) as c:
        r = await c.post("/api/v1/integrations/slack/connect/start", json={})
        assert r.status_code == 400, r.text
        assert "botToken" in r.json()["error"]["message"]


async def test_disconnect_org_wide_connection_requires_org_admin(db_app):
    conn_id = await _seed_connection(owner_user_id=None)

    async with await _client(_principal([])) as c:
        # Same 404 a nonexistent id would get — not a 403 that would confirm
        # an org-wide connection exists.
        assert (await c.delete(f"/api/v1/integrations/{conn_id}")).status_code == 404

    async with await _client(_principal(["org_admin"])) as c:
        assert (await c.delete(f"/api/v1/integrations/{conn_id}")).status_code == 204


async def test_disconnect_own_connection_does_not_require_org_admin(db_app):
    conn_id = await _seed_connection(owner_user_id=ME)

    async with await _client(_principal([])) as c:
        assert (await c.delete(f"/api/v1/integrations/{conn_id}")).status_code == 204
