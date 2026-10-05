"""Organization switcher paging stays bounded and filters on the server."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

service = pytest.importorskip("app.service")


class Result:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows


class Connection:
    def __init__(self, rows):
        self.rows = rows
        self.statement = ""
        self.params = {}

    async def execute(self, statement, params):
        self.statement = str(statement)
        self.params = params
        return Result(self.rows)


def test_membership_page_filters_orders_and_fetches_one_lookahead(monkeypatch):
    rows = [
        SimpleNamespace(user_id=f"user-{index}", org_id=f"org-{index}", org_name=f"Org {index}")
        for index in range(3)
    ]
    conn = Connection(rows)
    role_lookups = []

    async def roles_for_user(_conn, user_id):
        role_lookups.append(user_id)
        return ["member"]

    monkeypatch.setattr(service, "roles_for_user", roles_for_user)
    items, has_more = asyncio.run(
        service.membership_page_for_identity(
            conn, "identity-1", search="  abc  ", limit=2, offset=4
        )
    )

    assert [item["orgId"] for item in items] == ["org-0", "org-1"]
    assert has_more is True
    assert role_lookups == ["user-0", "user-1"]
    assert conn.params == {
        "iid": "identity-1",
        "search": "abc",
        "fetch_limit": 3,
        "offset": 4,
    }
    assert "strpos(lower(o.name), lower(:search))" in conn.statement
    assert "ORDER BY lower(o.name), o.id" in conn.statement