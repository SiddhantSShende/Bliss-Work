"""Parsing rules for the batch user lookup (`GET /auth/users?ids=`).

This endpoint is the substrate the GraphQL gateway's user DataLoader batches
onto, so its parsing is load-bearing in a way a normal query param is not: the
gateway hands it whatever ids a rendered page happened to reference, including
duplicates, and a permissive ceiling here would quietly turn it into a faster
way to enumerate an organisation than the endpoint that is paged for that job.

Pure logic — no FastAPI, no database, no network.
"""
from __future__ import annotations

import pytest

from app.routes.directory_service import (
    MAX_BATCH_IDS,
    InvalidUserIds,
    parse_user_ids,
)

A = "0189f4a1-0000-7000-8000-000000000001"
B = "0189f4a1-0000-7000-8000-000000000002"
C = "0189f4a1-0000-7000-8000-000000000003"


def test_parses_a_comma_separated_list():
    assert parse_user_ids(f"{A},{B},{C}") == [A, B, C]


def test_a_single_id_needs_no_comma():
    assert parse_user_ids(A) == [A]


def test_duplicates_collapse_and_order_is_preserved():
    # The batching case: twenty inbox rows from the same sender must not become
    # twenty copies in the `= ANY(...)` scan and twenty AES-GCM decrypts.
    assert parse_user_ids(f"{B},{A},{B},{A},{B}") == [B, A]


def test_whitespace_and_empty_segments_are_tolerated():
    # A client building the list by string concatenation produces both.
    assert parse_user_ids(f" {A} , , {B}, ") == [A, B]


def test_uppercase_uuids_are_canonicalised():
    # Two spellings of one id must not survive as two entries past dedup.
    assert parse_user_ids(f"{A.upper()},{A}") == [A]


@pytest.mark.parametrize("raw", [None, "", "   ", ",", " , , "])
def test_an_empty_request_is_rejected_rather_than_returning_everyone(raw):
    # The dangerous failure mode: treating "no ids" as "no filter" would make
    # this endpoint dump the org. It must be an error, never an empty predicate.
    with pytest.raises(InvalidUserIds):
        parse_user_ids(raw)


@pytest.mark.parametrize(
    "raw",
    [
        "not-a-uuid",
        f"{A},not-a-uuid",
        "1; DROP TABLE users",
        f"{A}'--",
        "0189f4a1-0000-7000-8000",  # truncated
    ],
)
def test_non_uuid_input_is_refused(raw):
    with pytest.raises(InvalidUserIds):
        parse_user_ids(raw)


def test_the_error_never_echoes_the_offending_value():
    # It is attacker-controlled and lands in logs and response bodies.
    hostile = "<script>alert(1)</script>"
    with pytest.raises(InvalidUserIds) as exc:
        parse_user_ids(hostile)
    assert hostile not in str(exc.value)


def test_a_batch_at_the_ceiling_is_accepted():
    ids = [f"0189f4a1-0000-7000-8000-{i:012d}" for i in range(MAX_BATCH_IDS)]
    assert len(parse_user_ids(",".join(ids))) == MAX_BATCH_IDS


def test_a_batch_over_the_ceiling_is_refused():
    ids = [f"0189f4a1-0000-7000-8000-{i:012d}" for i in range(MAX_BATCH_IDS + 1)]
    with pytest.raises(InvalidUserIds):
        parse_user_ids(",".join(ids))


def test_the_ceiling_counts_distinct_ids_not_raw_tokens():
    # 400 tokens, 2 distinct. Counting tokens would refuse a legitimate render.
    assert parse_user_ids(",".join([A, B] * 200)) == [A, B]


def test_the_batch_ceiling_stays_well_below_the_directory_page():
    # Guards the property the ceiling exists for: this must never become the
    # cheap way to enumerate an org. Imported lazily — auth.py pulls FastAPI.
    auth_routes = pytest.importorskip(
        "app.routes.auth",
        reason="auth-svc deps (fastapi/pydantic) not installed locally; CI installs requirements.txt.",
    )
    assert MAX_BATCH_IDS < auth_routes.MAX_DIRECTORY_PAGE
