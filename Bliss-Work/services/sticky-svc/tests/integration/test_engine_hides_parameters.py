"""A real failing INSERT through the app's engine must not leak its bound values.

B-AUTH-18, end to end against a real Postgres: the unit test checks the flag,
this checks that the text SQLAlchemy actually raises (and the log/error paths
then write out) omits the parameter while keeping the SQL and Postgres' message.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.db import session

pytestmark = pytest.mark.integration

SECRET = "plaintext-title-MUST-NOT-LEAK"

async def _fail_insert_with(secret: str) -> Exception:
    """A real failing INSERT through the app's own engine, secret bound.

    Fails on a missing table on purpose: Postgres' own DETAIL line echoes the
    offending key/row for unique, check and NOT NULL violations
    ("Key (k)=(...) already exists"), which hide_parameters cannot and does not
    claim to remove. What it removes is SQLAlchemy's `[parameters: ...]` dump,
    which carries EVERY bound value, not only the key columns.
    """
    async with session() as db:
        with pytest.raises(DBAPIError) as caught:
            await db.execute(
                text("INSERT INTO hp_probe_missing (k, v) VALUES (:k, :v)"),
                {"k": "key", "v": secret},
            )
        await db.rollback()
    return caught.value


def _assert_hidden(exc: Exception) -> None:
    rendered = str(exc)
    assert SECRET not in rendered, "bound parameter leaked into the error text"
    assert "parameters hidden" in rendered
    assert "INSERT INTO hp_probe_missing" in rendered  # SQL stays diagnosable
    assert "does not exist" in rendered  # so does the Postgres message


async def test_a_failed_insert_error_text_omits_the_bound_value(db_app):
    _assert_hidden(await _fail_insert_with(SECRET))
