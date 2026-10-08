from __future__ import annotations

import httpx
import pytest

from app.routes import integrations
from app.providers import oauth, slack


class _FakeCryptor:
    async def decrypt(self, _db, _org_id: str, _encrypted: bytes) -> str:
        return "provider-token"


async def test_google_revocation_failure_is_best_effort(monkeypatch):
    revoked: list[str] = []

    async def fail_revocation(token: str) -> None:
        revoked.append(token)
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(integrations, "cryptor", lambda: _FakeCryptor())
    monkeypatch.setattr(integrations.oauth, "revoke_google_token", fail_revocation)

    await integrations._best_effort_provider_revocation(
        None, "org-id", "gmail", b"encrypted-access", None
    )
    assert revoked == ["provider-token"]


@pytest.mark.parametrize(
    "revoke,client_module,url",
    [
        (oauth.revoke_google_token, oauth.httpclient, "https://oauth2.googleapis.com/revoke"),
        (slack.revoke_token, slack.httpclient, "https://slack.com/api/auth.revoke"),
    ],
)
async def test_supported_provider_revoke_uses_expected_endpoint(
    monkeypatch, revoke, client_module, url
):
    captured: dict = {}

    class _FakeClient:
        async def post(self, request_url, **kwargs):
            captured.update(url=request_url, **kwargs)
            return httpx.Response(
                200,
                json={"ok": True},
                request=httpx.Request("POST", request_url),
            )

    monkeypatch.setattr(client_module, "shared", lambda: _FakeClient())
    await revoke("provider-token")
    assert captured["url"] == url
    if "slack.com" in url:
        assert captured["headers"]["Authorization"] == "Bearer provider-token"
    else:
        assert captured["data"] == {"token": "provider-token"}
