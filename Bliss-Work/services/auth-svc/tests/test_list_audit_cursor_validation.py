"""GET /auth/audit?before= must reject a malformed cursor with 400, not crash
into a 500.

── The bug ─────────────────────────────────────────────────────────────────
`before` was only validated as `str, max_length=64` — never as a UUID —
before being handed straight to `CAST(:before AS uuid)` in the query. A
non-UUID value makes Postgres/asyncpg raise, which is not an HTTPException
and falls through to the generic unhandled-exception handler: malformed
client input turning into an opaque 500.

The fix validates `before` (same idiom as
`directory_service.parse_user_ids`'s `UUID(token)`) BEFORE the function ever
opens a database connection, so this is provable without one: calling
`list_audit` with a bad cursor must raise HTTPException(400) without ever
reaching `engine.connect()`.
"""
from __future__ import annotations

import pytest

members = pytest.importorskip(
    "app.routes.members",
    reason="auth-svc deps (fastapi/pydantic) not installed locally; CI installs requirements.txt.",
)

from fastapi import HTTPException  # noqa: E402


class _UnreachableEngine:
    """Stands in for `members.engine`: any attempt to open a connection
    means validation did NOT short-circuit before the database, which is
    exactly the bug this file guards against."""

    def connect(self):
        raise AssertionError(
            "list_audit reached the database despite a malformed `before` cursor"
        )


class _Principal:
    user_id = "actor-1"
    org_id = "org-1"
    roles = ["org_admin"]
    username = "admin"


@pytest.fixture(autouse=True)
def _no_db(monkeypatch):
    monkeypatch.setattr(members, "engine", _UnreachableEngine())


@pytest.mark.parametrize(
    "bad_cursor",
    [
        "not-a-uuid",
        "1; DROP TABLE audit_log",
        "0189f4a1-0000-7000-8000",  # truncated
        "'--",
    ],
)
async def test_a_malformed_cursor_is_a_400_not_a_500(bad_cursor):
    with pytest.raises(HTTPException) as exc:
        await members.list_audit(before=bad_cursor, principal=_Principal())
    assert exc.value.status_code == 400
