"""PATCH /auth/me must enqueue user.theme_prefs_changed whenever a theme write
happens, and skip it otherwise — this is the push half of theme sync: every
OTHER session this account has open relies on this event (relayed by
ws-gateway, see services/ws-gateway/internal/contract/contract.go) to re-pull
GET /auth/me immediately instead of waiting on its own focus/visibility poll.

update_me is an ordinary async function, not a FastAPI-wrapped endpoint, so it
is called directly here with a fake Principal/engine/connection — no TestClient
or dependency overrides needed.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

fastapi = pytest.importorskip("fastapi", reason="auth-svc deps not installed locally; CI installs requirements.txt.")

from app.routes import auth as auth_routes  # noqa: E402
from app.schemas import UpdateProfileRequest  # noqa: E402
from app.security.auth_dep import Principal  # noqa: E402


class _Conn:
    async def execute(self, *_a, **_k):
        return None


class _Ctx:
    async def __aenter__(self):
        return _Conn()

    async def __aexit__(self, *_exc):
        return False


class _Engine:
    def begin(self):
        return _Ctx()

    def connect(self):
        return _Ctx()


def _principal() -> Principal:
    return Principal(user_id="u1", org_id="o1", roles=["member"], username="ada")


def _patch_common(monkeypatch, *, dto):
    monkeypatch.setattr(auth_routes, "engine", _Engine())
    service = auth_routes.service
    monkeypatch.setattr(service, "set_org_guc", AsyncMock())
    monkeypatch.setattr(service, "update_display_name", AsyncMock())
    monkeypatch.setattr(service, "update_avatar", AsyncMock())
    monkeypatch.setattr(service, "update_theme_prefs", AsyncMock())
    monkeypatch.setattr(service, "update_custom_theme", AsyncMock())
    monkeypatch.setattr(service, "write_audit", AsyncMock())
    monkeypatch.setattr(service, "user_dto", AsyncMock(return_value=dto))
    enqueue = AsyncMock()
    monkeypatch.setattr(auth_routes, "enqueue_event", enqueue)
    return enqueue


@pytest.mark.asyncio
async def test_theme_prefs_change_enqueues_the_event(monkeypatch):
    from app.schemas import UserDTO

    dto = UserDTO(id="u1", orgId="o1", username="ada", displayName="Ada", email="a@x.io", roles=["member"])
    enqueue = _patch_common(monkeypatch, dto=dto)

    body = UpdateProfileRequest(
        themePrefs={"theme": "rose-dark", "customColors": None, "customActive": False},
        expectedThemeRevision=4,
    )
    await auth_routes.update_me(body, principal=_principal())

    auth_routes.service.update_theme_prefs.assert_awaited_once()
    assert auth_routes.service.update_theme_prefs.await_args.kwargs["expected_revision"] == 4

    enqueue.assert_called_once()
    _, kwargs = enqueue.call_args
    assert kwargs["topic"] == "auth.events"
    assert kwargs["kafka_key"] == "u1"
    assert kwargs["event"]["type"] == "user.theme_prefs_changed"
    assert kwargs["event"]["userId"] == "u1"


@pytest.mark.asyncio
async def test_custom_theme_only_change_also_enqueues_the_event(monkeypatch):
    from app.schemas import UserDTO

    dto = UserDTO(id="u1", orgId="o1", username="ada", displayName="Ada", email="a@x.io", roles=["member"])
    enqueue = _patch_common(monkeypatch, dto=dto)

    body = UpdateProfileRequest(customTheme={"colors": ["#112233"]})
    await auth_routes.update_me(body, principal=_principal())

    enqueue.assert_called_once()


@pytest.mark.asyncio
async def test_display_name_only_change_does_not_enqueue_a_theme_event(monkeypatch):
    from app.schemas import UserDTO

    dto = UserDTO(id="u1", orgId="o1", username="ada", displayName="Ada", email="a@x.io", roles=["member"])
    enqueue = _patch_common(monkeypatch, dto=dto)

    body = UpdateProfileRequest(displayName="Ada Lovelace")
    await auth_routes.update_me(body, principal=_principal())

    enqueue.assert_not_called()


@pytest.mark.asyncio
async def test_unchanged_theme_does_not_enqueue_an_event(monkeypatch):
    from app.schemas import UserDTO

    dto = UserDTO(id="u1", orgId="o1", username="ada", displayName="Ada", email="a@x.io", roles=["member"])
    enqueue = _patch_common(monkeypatch, dto=dto)
    auth_routes.service.update_theme_prefs.return_value = False

    body = UpdateProfileRequest(themePrefs={"theme": "rose", "customActive": False})
    await auth_routes.update_me(body, principal=_principal())

    enqueue.assert_not_called()


@pytest.mark.asyncio
async def test_stale_theme_write_returns_conflict_without_an_event(monkeypatch):
    from fastapi import HTTPException
    from app.schemas import UserDTO

    dto = UserDTO(id="u1", orgId="o1", username="ada", displayName="Ada", email="a@x.io", roles=["member"])
    enqueue = _patch_common(monkeypatch, dto=dto)
    auth_routes.service.update_theme_prefs.side_effect = auth_routes.service.ThemePrefsRevisionConflict

    body = UpdateProfileRequest(
        themePrefs={"theme": "rose", "customActive": False},
        expectedThemeRevision=3,
    )
    with pytest.raises(HTTPException) as exc:
        await auth_routes.update_me(body, principal=_principal())

    assert exc.value.status_code == 409
    enqueue.assert_not_called()
