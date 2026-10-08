"""The shared engine must not leak bound SQL parameters into error text.

B-AUTH-18: a failing statement raises a DBAPIError whose ``str()`` embeds the
bound parameters, and the service's error/log paths write that text out — so
bound values (task titles, payloads, ...) landed in the logs.
``hide_parameters=True`` on the engine makes SQLAlchemy replace them with
``[parameters: hidden]``. Modelled on auth-svc/tests/test_db_engine_hides_parameters.py.

Pure logic: the engine is built lazily by `init_engine()` without connecting,
and the exception is built by hand exactly as SQLAlchemy's cursor wrapper does.
The real failing-INSERT case is in tests/integration/test_engine_hides_parameters.py.
"""
from __future__ import annotations

from sqlalchemy.exc import IntegrityError

from app import db

SECRET = "plaintext-title-MUST-NOT-LEAK"


def test_engine_is_configured_to_hide_parameters(monkeypatch):
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr(db, "SessionLocal", None)
    engine = db.init_engine()
    try:
        assert engine.sync_engine.hide_parameters is True
    finally:
        engine.sync_engine.dispose()


def test_error_text_for_a_failed_insert_omits_bound_parameters(monkeypatch):
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr(db, "SessionLocal", None)
    engine = db.init_engine()
    try:
        exc = IntegrityError(
            "INSERT INTO outbox (id, payload) VALUES ($1, $2)",
            {"id": "u1", "payload": SECRET},
            Exception("duplicate key value violates unique constraint"),
            hide_parameters=engine.sync_engine.hide_parameters,
        )
    finally:
        engine.sync_engine.dispose()
    rendered = str(exc)
    assert SECRET not in rendered
    assert "SQL parameters hidden" in rendered
    assert "INSERT INTO outbox" in rendered  # the SQL itself is still diagnosable
