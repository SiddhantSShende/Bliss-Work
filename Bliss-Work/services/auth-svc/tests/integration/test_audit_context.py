"""Phase 9: audit-meta context (ip/user-agent/request-id/session-id) survives
the hash chain, and a mix of pre-Phase-9 rows (meta=None) and new rows (meta
carrying the new fields) still verifies end-to-end.

That mix is the whole point of routing this through the EXISTING `meta`
column rather than a new one (see docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase
9): a bare new column would be absent on every historical row, and
`verify_audit_chain` recomputes a fixed six-field signature — mixing "rows
with a 7th column" and "rows without" would break re-verification for every
org with history older than this phase.

Marked `integration` (needs Docker/Postgres); excluded from the unit gate.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app import service
from app.routes import session_events

pytestmark = pytest.mark.integration


async def test_mixed_old_and_new_rows_still_verify(sa_conn):
    org_id = str(uuid.uuid4())
    actor_id = str(uuid.uuid4())
    await service.set_org_guc(sa_conn, org_id)

    # Shaped like every entry written before this phase — no meta at all.
    await service.write_audit(
        sa_conn, org_id=org_id, actor_id=actor_id, action="auth.login", target=actor_id
    )

    # Shaped like a post-Phase-9 entry.
    meta = session_events.context_meta(
        session_id=str(uuid.uuid4()),
        ip="203.0.113.9",
        user_agent="Mozilla/5.0 (Test)",
        request_id="req-abc123",
    )
    await service.write_audit(
        sa_conn,
        org_id=org_id,
        actor_id=actor_id,
        action="auth.login",
        target=actor_id,
        meta=meta,
    )

    result = await service.verify_audit_chain(sa_conn, org_id)
    assert result == {"ok": True, "count": 2, "broken_at": None, "reason": None}


async def test_new_row_meta_round_trips_exactly(sa_conn):
    org_id = str(uuid.uuid4())
    actor_id = str(uuid.uuid4())
    await service.set_org_guc(sa_conn, org_id)

    session_id = str(uuid.uuid4())
    meta = session_events.context_meta(
        session_id=session_id,
        ip="198.51.100.7",
        user_agent="curl/8.0",
        request_id="req-xyz789",
    )
    await service.write_audit(
        sa_conn,
        org_id=org_id,
        actor_id=actor_id,
        action="auth.login",
        target=actor_id,
        meta=meta,
    )

    row = (
        await sa_conn.execute(
            text(
                "SELECT meta FROM audit_log WHERE org_id = :o "
                "AND action = 'auth.login' ORDER BY id DESC LIMIT 1"
            ),
            {"o": org_id},
        )
    ).first()

    assert row is not None
    stored = row.meta
    assert stored == {
        "sessionId": session_id,
        "ip": "198.51.100.7",
        "userAgent": "curl/8.0",
        "requestId": "req-xyz789",
    }
    # The hard constraint from the plan, checked against what actually made it
    # to disk: never a password, a raw token, or anything JWT-shaped (three
    # dot-separated segments — checked per-value, since the IP itself is
    # legitimately dotted) in this row.
    flat = " ".join(str(v) for v in stored.values())
    assert "password" not in flat.lower()
    for value in stored.values():
        assert len(str(value).split(".")) != 3, f"value {value!r} looks JWT-shaped"


async def test_write_audit_generates_ordered_uuidv7_ids(sa_conn):
    """migrations/0018_audit_log_uuid_id.sql: audit_log.id is now an
    app-generated UUIDv7 (service.new_uuid(), same convention as every other
    table), not a bigserial. Two things must still hold: each id is a real
    version-7 uuid, and `ORDER BY id` still returns rows in write order —
    write_audit's own "fetch the previous entry_hash" lookup and
    verify_audit_chain() both depend on that.
    """
    org_id = str(uuid.uuid4())
    actor_id = str(uuid.uuid4())
    await service.set_org_guc(sa_conn, org_id)

    targets = [f"target-{i}" for i in range(5)]
    for target in targets:
        await service.write_audit(
            sa_conn, org_id=org_id, actor_id=actor_id, action="auth.login", target=target
        )

    rows = (
        await sa_conn.execute(
            text("SELECT id, target FROM audit_log WHERE org_id = :o ORDER BY id ASC"),
            {"o": org_id},
        )
    ).all()

    assert [r.target for r in rows] == targets, "ORDER BY id must match write order"
    for r in rows:
        parsed = uuid.UUID(str(r.id))
        assert parsed.version == 7, f"expected a UUIDv7, got version {parsed.version}"

    # The hash chain itself must still verify — id ordering feeds directly
    # into how it's walked.
    result = await service.verify_audit_chain(sa_conn, org_id)
    assert result == {"ok": True, "count": len(targets), "broken_at": None, "reason": None}


async def test_verify_still_passes_with_no_context_at_all(sa_conn):
    """The generic/internal callers — `login_failed` with no request in scope,
    a pre-Phase-9 row — write `meta=None` or an empty context dict, and the
    chain must verify exactly as it always did."""
    org_id = str(uuid.uuid4())
    await service.set_org_guc(sa_conn, org_id)
    await service.write_audit(
        sa_conn,
        org_id=org_id,
        actor_id=None,
        action="auth.login_failed",
        target=None,
        meta=session_events.context_meta(),
    )
    result = await service.verify_audit_chain(sa_conn, org_id)
    assert result["ok"] is True
