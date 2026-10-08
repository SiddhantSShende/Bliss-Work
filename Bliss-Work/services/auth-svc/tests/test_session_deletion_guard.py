from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app import service


@pytest.mark.asyncio
async def test_build_session_rejects_pending_deletion_org(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "user_dto",
        AsyncMock(
            return_value=SimpleNamespace(
                id="user",
                orgId="org",
                roles=[],
                username="u",
                plan="free",
            )
        ),
    )
    monkeypatch.setattr(service, "org_pending_deletion", AsyncMock(return_value=True))

    with pytest.raises(HTTPException) as exc_info:
        await service.build_session(object(), "user")
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_refresh_rejects_pending_deletion_org_and_revokes_family(monkeypatch) -> None:
    token_row = SimpleNamespace(
        id="token",
        user_id="user",
        family_id="family",
        rotated_to=None,
        revoked=False,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    active_membership = SimpleNamespace(status="active")
    conn = SimpleNamespace(
        execute=AsyncMock(
            side_effect=[
                SimpleNamespace(first=lambda: token_row),
                SimpleNamespace(first=lambda: active_membership),
                SimpleNamespace(),
            ]
        )
    )
    monkeypatch.setattr(service, "org_pending_deletion", AsyncMock(return_value=True))

    with pytest.raises(service.RefreshError) as exc_info:
        await service.rotate_refresh_token(conn, "raw-refresh-token")
    assert exc_info.value.code == "deactivated"
    assert conn.execute.await_count == 3


@pytest.mark.asyncio
async def test_org_pending_deletion_fails_closed_for_missing_membership() -> None:
    result = SimpleNamespace(first=lambda: None)
    conn = SimpleNamespace(execute=AsyncMock(return_value=result))
    assert await service.org_pending_deletion(conn, "missing-user") is True


@pytest.mark.asyncio
async def test_org_pending_deletion_detects_each_deletion_state() -> None:
    for values, expected in (
        ((None, None, None), False),
        ((datetime.now(timezone.utc), None, None), True),
        ((None, datetime.now(timezone.utc), None), True),
        ((None, None, datetime.now(timezone.utc)), True),
    ):
        row = SimpleNamespace(
            delete_requested_at=values[0],
            purge_after=values[1],
            deleted_at=values[2],
        )
        result = SimpleNamespace(first=lambda: row)
        conn = SimpleNamespace(execute=AsyncMock(return_value=result))
        assert await service.org_pending_deletion(conn, "user") is expected
