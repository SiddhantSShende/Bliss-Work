from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.routes import account_service


def _fake_engine(identity_row):
    """A minimal stand-in for `..db.engine`: `.begin()` is an async context
    manager handing back a connection whose `execute(...)` always resolves to
    `identity_row` (mirroring the one query change_password_tx issues against
    `identities`) — enough for the control flow under test, since every real
    DB call downstream of it is itself mocked in `_patch_common`."""

    class _Conn:
        async def execute(self, *_a, **_k):
            return SimpleNamespace(first=lambda: identity_row)

    class _Ctx:
        async def __aenter__(self):
            return _Conn()

        async def __aexit__(self, *exc):
            return False

    class _Engine:
        def begin(self):
            return _Ctx()

    return _Engine()


def _patch_common(monkeypatch, *, password_ok: bool, policy_ok: bool = True, locked_until=None):
    service = account_service.service
    identity_row = SimpleNamespace(
        id="identity", password_hash="stored-hash", failed_login_count=0, locked_until=locked_until
    )
    monkeypatch.setattr(account_service, "engine", _fake_engine(identity_row))
    monkeypatch.setattr(service, "set_bypass_rls", AsyncMock())
    monkeypatch.setattr(service, "identity_id_for_user", AsyncMock(return_value="identity"))
    monkeypatch.setattr(account_service, "password_meets_policy", lambda _password: policy_ok)
    monkeypatch.setattr(account_service, "verify_password_async", AsyncMock(return_value=password_ok))
    monkeypatch.setattr(account_service, "hash_password_async", AsyncMock(return_value="new-hash"))
    monkeypatch.setattr(account_service, "request_context", lambda _request: (None, None, None))
    monkeypatch.setattr(service, "write_audit", AsyncMock())
    monkeypatch.setattr(service, "set_identity_password", AsyncMock())
    monkeypatch.setattr(service, "reset_identity_lockout", AsyncMock())
    monkeypatch.setattr(service, "revoke_all_identity_tokens", AsyncMock())
    monkeypatch.setattr(service, "register_failed_login", AsyncMock(return_value=0))
    return service


@pytest.mark.asyncio
async def test_correct_current_password_sets_the_new_hash(monkeypatch) -> None:
    service = _patch_common(monkeypatch, password_ok=True)

    await account_service.change_password_tx(
        "user", "org", "correct-current", "New-Password-123!", SimpleNamespace()
    )

    assert service.set_identity_password.await_args.args[1:] == ("identity", "new-hash")
    service.reset_identity_lockout.assert_awaited_once()
    service.revoke_all_identity_tokens.assert_awaited_once()
    service.register_failed_login.assert_not_called()


@pytest.mark.asyncio
async def test_wrong_current_password_is_rejected_without_changing_anything(monkeypatch) -> None:
    service = _patch_common(monkeypatch, password_ok=False)

    with pytest.raises(HTTPException) as exc_info:
        await account_service.change_password_tx(
            "user", "org", "wrong-current", "New-Password-123!", SimpleNamespace()
        )

    assert exc_info.value.status_code == 401
    service.register_failed_login.assert_awaited_once()
    service.set_identity_password.assert_not_called()
    service.revoke_all_identity_tokens.assert_not_called()


@pytest.mark.asyncio
async def test_weak_new_password_is_rejected_before_touching_the_database(monkeypatch) -> None:
    service = _patch_common(monkeypatch, password_ok=True, policy_ok=False)

    with pytest.raises(HTTPException) as exc_info:
        await account_service.change_password_tx(
            "user", "org", "correct-current", "short", SimpleNamespace()
        )

    assert exc_info.value.status_code == 422
    service.set_bypass_rls.assert_not_called()
    service.set_identity_password.assert_not_called()


@pytest.mark.asyncio
async def test_locked_identity_is_rejected_with_429(monkeypatch) -> None:
    service = _patch_common(
        monkeypatch,
        password_ok=True,
        locked_until=datetime.now(timezone.utc) + timedelta(minutes=5),
    )

    with pytest.raises(HTTPException) as exc_info:
        await account_service.change_password_tx(
            "user", "org", "correct-current", "New-Password-123!", SimpleNamespace()
        )

    assert exc_info.value.status_code == 429
    service.set_identity_password.assert_not_called()
    service.register_failed_login.assert_not_called()
