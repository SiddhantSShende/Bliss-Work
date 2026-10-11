"""update_custom_theme's SQL must bind exactly :colors and :id.

SQLAlchemy's text() treats every `:word` as a bind parameter, including ones
inside a quoted SQL literal. A JSON default like '{"customColors":null}' therefore
declared bind parameters named `null` / `false`, and every PATCH /auth/me that
touched the custom theme died with "A value is required for bind parameter
'null'" (a 500). Route tests mock the service, so only compiling the real
statement catches this.
"""
from __future__ import annotations

import asyncio

import pytest

service = pytest.importorskip(
    "app.service",
    reason="auth-svc deps not installed locally; CI installs requirements.txt.",
)


class _RecordingConn:
    def __init__(self) -> None:
        self.calls: list[tuple[object, dict]] = []

    async def execute(self, stmt, params=None):
        self.calls.append((stmt, params or {}))


def test_update_custom_theme_binds_only_its_two_parameters():
    conn = _RecordingConn()
    asyncio.run(service.update_custom_theme(conn, "u-1", ["#65a30d"]))
    stmt, params = conn.calls[0]
    compiled = stmt.compile()
    assert set(compiled.params) == {"colors", "id"}
    # Same check SQLAlchemy runs at execute time: every declared bind has a value.
    compiled.construct_params(params)


def test_update_custom_theme_deletion_binds_json_null():
    conn = _RecordingConn()
    asyncio.run(service.update_custom_theme(conn, "u-1", None))
    stmt, params = conn.calls[0]
    assert params["colors"] == "null"
    stmt.compile().construct_params(params)
