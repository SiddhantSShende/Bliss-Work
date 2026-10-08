"""The shared engine must not leak bound SQL parameters into error text.

B-AUTH-18: a failing `INSERT INTO users (..., password_hash, ...)` raised a
DBAPIError whose ``str()`` embeds the bound parameters, and
``errors._unhandled_exception_handler`` logs the full traceback — so the
password hash landed in the logs. ``hide_parameters=True`` on the engine makes
SQLAlchemy replace them with ``[parameters: hidden]``.

Pure logic: no database is contacted (the exception is built by hand, exactly as
SQLAlchemy's cursor wrapper builds it).
"""
from __future__ import annotations

from sqlalchemy.exc import IntegrityError

from app import db

SECRET = "$argon2id$v=19$m=65536,t=3,p=4$SECRET-HASH-MUST-NOT-LEAK"


def test_engine_is_configured_to_hide_parameters():
    assert db.engine.sync_engine.hide_parameters is True


def test_error_text_for_a_failed_insert_omits_bound_parameters():
    engine = db.engine.sync_engine
    exc = IntegrityError(
        "INSERT INTO users (id, password_hash) VALUES ($1, $2)",
        {"id": "u1", "password_hash": SECRET},
        Exception("duplicate key value violates unique constraint"),
        hide_parameters=engine.hide_parameters,
    )
    rendered = str(exc)
    assert SECRET not in rendered
    assert "SQL parameters hidden" in rendered
    assert "INSERT INTO users" in rendered  # the SQL itself is still diagnosable
