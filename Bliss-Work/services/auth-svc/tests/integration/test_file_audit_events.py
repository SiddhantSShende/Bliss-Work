"""File open/download events reach the member-detail Security tab.

telemetry-svc reports each file act to POST /internal/audit/file-events; it must
land in the real hash-chained `audit_log` — readable through the same
`GET /auth/audit?targetId=<member>` the Security tab uses — exactly once however
many times it is delivered, and only for a user who really belongs to the org.

Against a REAL Postgres at the RLS-scoped role (the policies and the partial
unique index are the thing under test). Marked `integration`.
"""
from __future__ import annotations

import json
import uuid

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app import service
# Imported first on purpose: importing app.routes.members (or invites_service)
# before this one trips an import cycle that exists independently of this file
# (members -> invites_service -> mfa_service -> account_service -> invites_service);
# the running app enters the cycle through here.
from app.routes import mfa_service  # noqa: F401  isort: skip
from app.routes import internal_file_audit as route
from app.routes import members as members_routes
from app.security.auth_dep import Principal

pytestmark = pytest.mark.integration

TOKEN = "t" * 32


async def _seed_org(sa_engine, *, members: int = 1) -> tuple[str, list[str]]:
    org_id = str(uuid.uuid4())
    user_ids = [str(uuid.uuid4()) for _ in range(members)]
    async with sa_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        await conn.execute(
            text("INSERT INTO orgs (id, name, slug) VALUES (:id, 'F Co', :slug)"),
            {"id": org_id, "slug": f"f-{org_id}"},
        )
        for i, uid in enumerate(user_ids):
            await conn.execute(
                text(
                    "INSERT INTO users (id, org_id, username, password_hash) "
                    "VALUES (:id, :org, :u, 'x')"
                ),
                {"id": uid, "org": org_id, "u": f"user-{i}"},
            )
    return org_id, user_ids


def _event(actor: str, **overrides) -> route.FileAuditEvent:
    fields = {
        "eventId": uuid.uuid4(),
        "actorId": actor,
        "action": "file.opened",
        "occurredAt": "2026-10-09T10:00:00+00:00",
        "platform": "web",
        "fileId": "att-1",
        "fileName": "report.pdf",
        "contextKind": "direct",
        "contextId": "conv-1",
        "contextName": "Divya Bhamri",
        "activitySessionId": str(uuid.uuid4()),
        "sessionId": str(uuid.uuid4()),
        "ip": "203.0.113.9",
        "userAgent": "Mozilla/5.0 (Test)",
        "requestId": "req-1",
    }
    fields.update(overrides)
    return route.FileAuditEvent(**fields)


async def _record(sa_engine, org_id: str, events: list[route.FileAuditEvent]) -> route.FileAuditResult:
    async with sa_engine.begin() as conn:
        await service.set_org_guc(conn, org_id)
        return await route.record_file_events_tx(conn, org_id, events)


async def _security_tab(monkeypatch, sa_engine, org_id: str, member_id: str):
    """What the member-detail Security tab fetches: the org audit trail scoped to
    one member as `target`."""
    monkeypatch.setattr(members_routes, "engine", sa_engine)
    admin = Principal(user_id=member_id, org_id=org_id, roles=["org_admin"], username="a")
    return await members_routes.list_audit(
        before=None, limit=50, action=None, targetId=member_id, principal=admin
    )


async def test_file_open_appears_on_the_members_security_tab(monkeypatch, sa_engine):
    org_id, [member] = await _seed_org(sa_engine)
    ev = _event(member)

    result = await _record(sa_engine, org_id, [ev])

    assert result == route.FileAuditResult(written=1, duplicates=0, rejected=0)
    page = await _security_tab(monkeypatch, sa_engine, org_id, member)
    [entry] = page.entries
    assert (entry.action, entry.actorId, entry.target) == ("file.opened", member, member)
    assert entry.meta == {
        "eventId": str(ev.eventId),
        "reportedBy": "client",
        "occurredAt": "2026-10-09T10:00:00+00:00",
        "platform": "web",
        "fileId": "att-1",
        "filename": "report.pdf",
        "contextKind": "direct",
        "contextId": "conv-1",
        "contextName": "Divya Bhamri",
        "activitySessionId": ev.activitySessionId,
        "sessionId": ev.sessionId,
        "ip": "203.0.113.9",
        "userAgent": "Mozilla/5.0 (Test)",
        "requestId": "req-1",
    }


async def test_download_in_a_channel_is_recorded_with_its_channel(monkeypatch, sa_engine):
    org_id, [member] = await _seed_org(sa_engine)

    await _record(
        sa_engine,
        org_id,
        [_event(member, action="file.downloaded", contextKind="channel", contextId="ch-1", contextName="GRC Development")],
    )

    [entry] = (await _security_tab(monkeypatch, sa_engine, org_id, member)).entries
    assert entry.action == "file.downloaded"
    assert entry.meta["contextKind"] == "channel"
    assert entry.meta["contextName"] == "GRC Development"


async def test_the_hash_chain_still_verifies_with_file_events_among_other_rows(sa_engine):
    org_id, [member] = await _seed_org(sa_engine)
    async with sa_engine.begin() as conn:
        await service.set_org_guc(conn, org_id)
        await service.write_audit(conn, org_id=org_id, actor_id=member, action="auth.login", target=member)
    await _record(sa_engine, org_id, [_event(member), _event(member, action="file.downloaded")])
    async with sa_engine.begin() as conn:
        await service.set_org_guc(conn, org_id)
        await service.write_audit(conn, org_id=org_id, actor_id=member, action="auth.logout", target=member)
        assert await service.verify_audit_chain(conn, org_id) == {
            "ok": True, "count": 4, "broken_at": None, "reason": None,
        }


async def test_redelivery_of_the_same_event_writes_one_row(monkeypatch, sa_engine):
    org_id, [member] = await _seed_org(sa_engine)
    ev = _event(member)

    first = await _record(sa_engine, org_id, [ev])
    again = await _record(sa_engine, org_id, [ev])
    same_batch = await _record(sa_engine, org_id, [ev, ev])

    assert first.written == 1
    assert (again.written, again.duplicates) == (0, 1)
    assert (same_batch.written, same_batch.duplicates) == (0, 2)
    assert len((await _security_tab(monkeypatch, sa_engine, org_id, member)).entries) == 1


async def test_two_distinct_acts_on_one_file_are_two_rows(monkeypatch, sa_engine):
    org_id, [member] = await _seed_org(sa_engine)

    result = await _record(sa_engine, org_id, [_event(member), _event(member)])

    assert result.written == 2
    assert len((await _security_tab(monkeypatch, sa_engine, org_id, member)).entries) == 2


async def test_an_actor_outside_the_org_is_refused_and_nothing_is_written(monkeypatch, sa_engine):
    org_id, [member] = await _seed_org(sa_engine)
    _other_org, [stranger] = await _seed_org(sa_engine)

    result = await _record(sa_engine, org_id, [_event(stranger), _event(member)])

    assert (result.written, result.rejected) == (1, 1)
    assert (await _security_tab(monkeypatch, sa_engine, org_id, stranger)).entries == []


async def test_an_event_without_context_stores_no_context_keys(monkeypatch, sa_engine):
    org_id, [member] = await _seed_org(sa_engine)

    await _record(
        sa_engine, org_id,
        [_event(member, contextKind=None, contextId=None, contextName=None, ip=None, userAgent=None)],
    )

    [entry] = (await _security_tab(monkeypatch, sa_engine, org_id, member)).entries
    assert not {"contextKind", "contextId", "contextName", "ip", "userAgent"} & set(entry.meta)
    assert None not in entry.meta.values()


async def test_the_unique_index_refuses_a_second_row_for_one_event(sa_engine):
    org_id, [member] = await _seed_org(sa_engine)
    ev = _event(member)
    await _record(sa_engine, org_id, [ev])

    with pytest.raises(IntegrityError):
        async with sa_engine.begin() as conn:
            await service.set_org_guc(conn, org_id)
            await service.write_audit(
                conn, org_id=org_id, actor_id=member, action="file.opened",
                target=member, meta={"eventId": str(ev.eventId)},
            )


def _http_app() -> FastAPI:
    app = FastAPI()
    app.include_router(route.router)
    return app


async def _post(payload: object, token: str | None) -> httpx.Response:
    headers = {} if token is None else {"X-Internal-Token": token}
    transport = httpx.ASGITransport(app=_http_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://auth") as c:
        return await c.post("/internal/audit/file-events", json=payload, headers=headers)


async def test_endpoint_accepts_the_internal_token_and_writes(monkeypatch, sa_engine):
    org_id, [member] = await _seed_org(sa_engine)
    monkeypatch.setattr(route, "engine", sa_engine)
    monkeypatch.setattr(route, "_INTERNAL_TOKEN", TOKEN)
    payload = {"orgId": org_id, "events": [json.loads(_event(member).model_dump_json())]}

    resp = await _post(payload, TOKEN)

    assert resp.status_code == 200
    assert resp.json() == {"written": 1, "duplicates": 0, "rejected": 0}


async def test_endpoint_answers_401_before_it_looks_at_the_body(monkeypatch, sa_engine):
    org_id, [member] = await _seed_org(sa_engine)
    monkeypatch.setattr(route, "engine", sa_engine)
    monkeypatch.setattr(route, "_INTERNAL_TOKEN", TOKEN)
    valid = {"orgId": org_id, "events": [json.loads(_event(member).model_dump_json())]}

    for token in (None, "", "wrong"):
        # An invalid body must not turn into a 422 that describes the schema.
        assert (await _post({}, token)).status_code == 401
        assert (await _post(valid, token)).status_code == 401


async def test_endpoint_fails_closed_when_no_secret_is_configured(monkeypatch, sa_engine):
    org_id, [member] = await _seed_org(sa_engine)
    monkeypatch.setattr(route, "engine", sa_engine)
    monkeypatch.setattr(route, "_INTERNAL_TOKEN", "")
    valid = {"orgId": org_id, "events": [json.loads(_event(member).model_dump_json())]}

    assert (await _post(valid, "")).status_code == 401


def test_only_the_two_file_actions_and_bounded_fields_are_accepted():
    actor = str(uuid.uuid4())
    for bad in ({"action": "file.deleted"}, {"fileName": "x" * 256}, {"contextKind": "group"}):
        with pytest.raises(ValidationError):
            _event(actor, **bad)
