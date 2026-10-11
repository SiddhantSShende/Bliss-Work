"""`GET /auth/directory?q=` — the search walk in `service.user_dtos_for_org`.

Display name and email are encrypted at rest, so the search decrypts the org a
batch at a time and filters. These pin the part that is easy to get wrong:
`offset` counts MATCHES, a page never exceeds `limit`, the walk stops as soon as it
has enough, and a blank query is the plain single-page read.

The page read is replaced by an in-memory directory; the SQL and the decrypt are
exercised against a real database elsewhere (the end-to-end run).
"""
from __future__ import annotations

import pytest

pytest.importorskip("pydantic")
pytest.importorskip("sqlalchemy")

from app import service  # noqa: E402
from app.schemas import UserDTO  # noqa: E402


def _user(i: int, *, name: str | None = None, email: str | None = None) -> UserDTO:
    return UserDTO(
        id=f"0189f4a1-0000-7000-8000-{i:012d}",
        orgId="0189f4a1-0000-7000-8000-00000000ffff",
        orgName="Acme",
        username=f"user{i:04d}",
        displayName=name if name is not None else f"Member {i}",
        email=email if email is not None else f"user{i}@acme.test",
        roles=["member"],  # type: ignore[list-item]
    )


class Directory:
    """An org, in username order, that records every page read."""

    def __init__(self, users: list[UserDTO]):
        self.users = users
        self.reads: list[tuple[int, int]] = []

    async def page(self, conn, org_id, include_inactive, limit, offset):  # noqa: ARG002
        self.reads.append((limit, offset))
        return self.users[offset : offset + limit]


@pytest.fixture
def directory(monkeypatch):
    def install(users: list[UserDTO]) -> Directory:
        d = Directory(users)
        monkeypatch.setattr(service, "_directory_page", d.page)
        monkeypatch.setattr(service, "_DIRECTORY_SCAN_BATCH", 10)
        return d

    return install


async def search(q: str, *, limit: int = 5, offset: int = 0):
    return await service.user_dtos_for_org(None, "org", limit=limit, offset=offset, query=q)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_a_blank_query_is_the_plain_single_page_read(directory):
    d = directory([_user(i) for i in range(30)])
    got = await search("   ", limit=7, offset=3)
    assert [u.username for u in got] == [f"user{i:04d}" for i in range(3, 10)]
    assert d.reads == [(7, 3)]  # one read, with the caller's own limit/offset


@pytest.mark.asyncio
async def test_matches_name_username_and_email_case_insensitively(directory):
    directory([_user(1, name="Grace Hopper"), _user(2, email="GRACEFUL@acme.test"), _user(3), _user(4, name="Ada")])
    assert [u.username for u in await search("GRACE")] == ["user0001", "user0002"]
    assert [u.username for u in await search("user0004")] == ["user0004"]


@pytest.mark.asyncio
async def test_offset_counts_matches_not_rows_scanned(directory):
    # Every third member matches; 60 rows → 20 matches, spread over six scan batches.
    d = directory([_user(i, name="Zed Match" if i % 3 == 0 else f"Other {i}") for i in range(60)])
    first = await search("zed", limit=8, offset=0)
    second = await search("zed", limit=8, offset=8)
    third = await search("zed", limit=8, offset=16)
    assert [len(first), len(second), len(third)] == [8, 8, 4]
    ids = [u.id for u in first + second + third]
    assert len(ids) == len(set(ids)) == 20  # no gaps, no repeats across pages
    assert ids == sorted(ids)
    assert d.reads  # scanned in batches of the (patched) size
    assert all(limit == 10 for limit, _ in d.reads)


@pytest.mark.asyncio
async def test_the_walk_stops_as_soon_as_the_page_is_full(directory):
    d = directory([_user(i, name="Zed" if i < 5 else "Other") for i in range(500)])
    got = await search("zed", limit=3)
    assert len(got) == 3
    assert d.reads == [(10, 0)]  # the first batch already held enough; the other 49 were never read


@pytest.mark.asyncio
async def test_a_short_batch_ends_the_walk_and_no_match_is_empty(directory):
    d = directory([_user(i) for i in range(25)])
    assert await search("nobody-by-this-name") == []
    assert d.reads == [(10, 0), (10, 10), (10, 20)]  # the third batch came back short (5), so it stopped


@pytest.mark.asyncio
async def test_a_page_past_the_last_match_is_empty(directory):
    directory([_user(i, name="Zed" if i < 4 else "Other") for i in range(20)])
    assert await search("zed", limit=5, offset=4) == []
    assert len(await search("zed", limit=5, offset=2)) == 2
