"""Unit coverage for ``app.projects._create_project_channel``'s HTTP mapping.

The integration suite (tests/integration/test_projects.py) always monkeypatches
``_create_project_channel`` itself, so it never exercises the status-code
branching below — including the exact failure seen in production on
2026-10-13: task-svc called messaging-svc's ``POST /internal/channels`` while
messaging-svc was still running an image built before that route existed, so
every call came back 404 and every "create a task under a new project name"
request failed with a generic 502. These tests pin that mapping so a stale
downstream route (or any other non-201 response) fails the same clear way
instead of silently changing shape.
"""
from __future__ import annotations

import pytest

httpx = pytest.importorskip(
    "httpx", reason="task-svc deps not installed locally; CI installs requirements.txt."
)
fastapi = pytest.importorskip(
    "fastapi", reason="task-svc deps not installed locally; CI installs requirements.txt."
)
HTTPException = fastapi.HTTPException

from app import projects  # noqa: E402  (import after the importorskip guards)

ORG_ID = "11111111-1111-1111-1111-111111111111"
CREATOR_ID = "22222222-2222-2222-2222-222222222222"


class _FakeResponse:
    def __init__(self, status_code: int, json_body: dict | None = None) -> None:
        self.status_code = status_code
        self._json_body = json_body if json_body is not None else {}

    def json(self) -> dict:
        return self._json_body

    @property
    def text(self) -> str:
        return str(self._json_body)


class _FakeAsyncClient:
    """Stands in for ``httpx.AsyncClient`` as an async context manager."""

    def __init__(self, response: _FakeResponse | Exception, record: list) -> None:
        self._response = response
        self._record = record

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *exc_info: object) -> bool:
        return False

    async def post(self, url: str, headers: dict | None = None, json: dict | None = None):
        self._record.append((url, headers, json))
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


def _stub_client(monkeypatch, response: _FakeResponse | Exception) -> list:
    calls: list = []

    def factory(**_kwargs):
        return _FakeAsyncClient(response, calls)

    monkeypatch.setattr(projects.httpx, "AsyncClient", factory)
    return calls


async def test_missing_route_on_the_callee_surfaces_as_502_not_a_silent_success(monkeypatch):
    """A stale messaging-svc image without POST /internal/channels returns a
    plain chi 404 — exactly today's production incident."""
    calls = _stub_client(monkeypatch, _FakeResponse(404, {"error": "not found"}))

    with pytest.raises(HTTPException) as exc_info:
        await projects._create_project_channel(ORG_ID, CREATOR_ID, "New Project")

    assert exc_info.value.status_code == 502
    assert "retry task creation" in exc_info.value.detail
    assert len(calls) == 1
    url, headers, body = calls[0]
    assert url.endswith("/internal/channels")
    assert body == {
        "orgId": ORG_ID,
        "name": "New Project",
        "isLocked": True,
        "creatorId": CREATOR_ID,
        "memberIds": [],
    }


async def test_successful_create_returns_the_channel_id(monkeypatch):
    channel_id = "33333333-3333-3333-3333-333333333333"
    _stub_client(monkeypatch, _FakeResponse(201, {"channelId": channel_id}))

    result = await projects._create_project_channel(ORG_ID, CREATOR_ID, "New Project")

    assert result == channel_id


async def test_invalid_success_body_is_a_distinct_502(monkeypatch):
    _stub_client(monkeypatch, _FakeResponse(201, {"channelId": "not-a-uuid"}))

    with pytest.raises(HTTPException) as exc_info:
        await projects._create_project_channel(ORG_ID, CREATOR_ID, "New Project")

    assert exc_info.value.status_code == 502
    assert "invalid" in exc_info.value.detail


async def test_other_server_error_is_also_a_502(monkeypatch):
    _stub_client(monkeypatch, _FakeResponse(500, {"error": "boom"}))

    with pytest.raises(HTTPException) as exc_info:
        await projects._create_project_channel(ORG_ID, CREATOR_ID, "New Project")

    assert exc_info.value.status_code == 502


async def test_unreachable_messaging_svc_is_a_retryable_503(monkeypatch):
    _stub_client(monkeypatch, httpx.ConnectError("connection refused"))

    with pytest.raises(HTTPException) as exc_info:
        await projects._create_project_channel(ORG_ID, CREATOR_ID, "New Project")

    assert exc_info.value.status_code == 503
    assert "unavailable" in exc_info.value.detail
