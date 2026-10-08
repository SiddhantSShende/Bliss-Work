from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.routes import account_service


@pytest.mark.asyncio
async def test_password_reset_clears_identity_lockout(monkeypatch) -> None:
    service = account_service.service
    monkeypatch.setattr(service, "set_bypass_rls", AsyncMock())
    monkeypatch.setattr(account_service, "consume_token", AsyncMock(return_value=("user", "org")))
    monkeypatch.setattr(account_service, "password_meets_policy", lambda _password: True)
    monkeypatch.setattr(account_service, "hash_password_async", AsyncMock(return_value="new-hash"))
    monkeypatch.setattr(service, "identity_id_for_user", AsyncMock(return_value="identity"))
    monkeypatch.setattr(service, "set_identity_password", AsyncMock())
    reset_lockout = AsyncMock()
    monkeypatch.setattr(service, "reset_identity_lockout", reset_lockout)
    monkeypatch.setattr(service, "revoke_all_identity_tokens", AsyncMock())
    monkeypatch.setattr(account_service, "request_context", lambda _request: (None, None, None))
    monkeypatch.setattr(service, "write_audit", AsyncMock())

    conn = object()
    await account_service.reset_password_tx(
        conn,
        "reset-token",
        "New-Password-123!",
        SimpleNamespace(),
    )

    reset_lockout.assert_awaited_once_with(conn, "identity")
