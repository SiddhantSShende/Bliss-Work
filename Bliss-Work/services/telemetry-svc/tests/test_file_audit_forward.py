"""Reporting a file act to auth-svc's audit log (unit level: payload shape and the
HTTP contract; the stored end-to-end behaviour is in
tests/integration/test_file_audit_forwarding.py)."""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

httpx = pytest.importorskip("httpx")
audit_forward = pytest.importorskip(
    "app.audit_forward",
    reason="telemetry-svc dependencies are not installed locally; CI installs requirements.txt.",
)
from app.config import Settings, settings  # noqa: E402
from app.ingest import ActivityRow  # noqa: E402

AT = datetime(2026, 10, 9, 10, 0, tzinfo=timezone.utc)
CALL = dict(auth_session_id="fam-1", ip="203.0.113.9", user_agent="UA/1", request_id="req-1")


def _row(detail: dict, **over) -> ActivityRow:
    base = dict(
        org_id="org-1", user_id="u1", session_id="sess-1", occurred_at=AT, source="web",
        category="security", action="file.opened", target_kind="attachment", target_id="att-1",
        detail=detail,
    )
    base.update(over)
    return ActivityRow(**base)


def test_a_dm_row_becomes_an_audit_event_with_its_chat_and_request_metadata():
    ev = audit_forward.file_audit_event(
        _row({"filename": "image.png", "contextKind": "direct", "contextId": "cv-1",
              "contextName": "Divya Bhamri"}),
        "evt-1", **CALL,
    )
    assert ev == {
        "eventId": "evt-1", "actorId": "u1", "action": "file.opened",
        "occurredAt": AT.isoformat(), "platform": "web", "fileId": "att-1",
        "fileName": "image.png", "contextKind": "direct", "contextId": "cv-1",
        "contextName": "Divya Bhamri", "activitySessionId": "sess-1", "sessionId": "fam-1",
        "ip": "203.0.113.9", "userAgent": "UA/1", "requestId": "req-1",
    }


def test_a_channel_download_keeps_its_channel():
    ev = audit_forward.file_audit_event(
        _row({"filename": "Report.pdf", "contextKind": "channel", "contextId": "ch-1",
              "contextName": "GRC Development"}, action="file.downloaded"),
        "evt-2", **CALL,
    )
    assert (ev["action"], ev["contextKind"], ev["contextName"]) == ("file.downloaded", "channel", "GRC Development")


def test_a_legacy_row_without_context_sends_no_context_rather_than_a_placeholder():
    ev = audit_forward.file_audit_event(_row({"filename": "old.pdf", "channel": "ch-0"}), "evt-3", **CALL)
    assert (ev["contextKind"], ev["contextId"], ev["contextName"]) == (None, None, None)


def test_an_unknown_context_kind_is_dropped_whole_rather_than_guessed():
    ev = audit_forward.file_audit_event(
        _row({"contextKind": "group", "contextId": "g-1", "contextName": "Team"}), "evt-4", **CALL
    )
    assert (ev["contextKind"], ev["contextId"], ev["contextName"]) == (None, None, None)


def test_values_are_clamped_to_what_auth_svc_accepts_so_one_cannot_poison_a_batch():
    ev = audit_forward.file_audit_event(
        _row({"filename": "f" * 900, "contextKind": "channel", "contextId": "c" * 900,
              "contextName": "n" * 900}, target_id="t" * 900),
        "evt-5", auth_session_id="s" * 900, ip="1" * 900, user_agent="u" * 900, request_id="r" * 900,
    )
    limits = {"fileName": 255, "contextId": 128, "contextName": 255, "fileId": 128,
              "sessionId": 64, "ip": 64, "userAgent": 512, "requestId": 128}
    for key, limit in limits.items():
        assert len(ev[key]) == limit, key


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(settings, "auth_internal_token", "secret-token")
    monkeypatch.setattr(settings, "auth_internal_base", "http://auth.test:8001/")


async def test_the_events_are_posted_to_the_internal_endpoint_with_the_shared_secret(configured):
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"], seen["token"], seen["body"] = str(req.url), req.headers.get("x-internal-token"), json.loads(req.content)
        return httpx.Response(200, json={"written": 1, "duplicates": 0, "rejected": 0})

    async with _client(handler) as c:
        await audit_forward.forward_file_events("org-1", [{"eventId": "e1"}], client=c)

    assert seen == {
        "url": "http://auth.test:8001/internal/audit/file-events",
        "token": "secret-token",
        "body": {"orgId": "org-1", "events": [{"eventId": "e1"}]},
    }


async def test_nothing_is_sent_for_an_empty_batch(configured):
    def handler(req):
        raise AssertionError("no request expected")

    async with _client(handler) as c:
        await audit_forward.forward_file_events("org-1", [], client=c)


async def test_nothing_is_sent_when_the_secret_is_not_configured(monkeypatch):
    monkeypatch.setattr(settings, "auth_internal_token", "")

    def handler(req):
        raise AssertionError("no request expected")

    async with _client(handler) as c:
        await audit_forward.forward_file_events("org-1", [{"eventId": "e1"}], client=c)


@pytest.mark.parametrize("status", [401, 403, 429, 500, 502, 503])
async def test_an_unconfirmed_write_raises_so_the_beacon_is_retried(configured, status):
    async with _client(lambda req: httpx.Response(status)) as c:
        with pytest.raises(audit_forward.AuditForwardError):
            await audit_forward.forward_file_events("org-1", [{"eventId": "e1"}], client=c)


async def test_an_unreachable_auth_svc_raises(configured):
    def handler(req):
        raise httpx.ConnectError("down")

    async with _client(handler) as c:
        with pytest.raises(audit_forward.AuditForwardError):
            await audit_forward.forward_file_events("org-1", [{"eventId": "e1"}], client=c)


@pytest.mark.parametrize("status", [400, 422])
async def test_an_invalid_payload_is_not_retried_because_resending_cannot_fix_it(configured, status):
    async with _client(lambda req: httpx.Response(status)) as c:
        await audit_forward.forward_file_events("org-1", [{"eventId": "e1"}], client=c)


async def test_a_refused_actor_is_logged_not_retried(configured):
    body = {"written": 0, "duplicates": 0, "rejected": 1}
    async with _client(lambda req: httpx.Response(200, json=body)) as c:
        await audit_forward.forward_file_events("org-1", [{"eventId": "e1"}], client=c)


def _prod_settings(**over) -> Settings:
    base = dict(
        tb_env="production",
        data_master_passphrase="p" * 24, data_master_salt="s" * 24, data_blind_index_key="k" * 40,
        telemetry_database_url="postgresql://u:pw@db/telemetrydb?sslmode=verify-full",
        auth_internal_token="real-secret-value",
    )
    base.update(over)
    return Settings(**base)


def test_production_refuses_to_start_without_a_real_audit_secret():
    _prod_settings()  # a fully configured production boots
    for bad in ("", "dev-internal-token-auth"):
        with pytest.raises(ValueError, match="AUTH_INTERNAL_TOKEN"):
            _prod_settings(auth_internal_token=bad)
