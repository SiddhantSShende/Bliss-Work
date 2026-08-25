"""Unit tests for ``shared_logging_setup``.

Verifies observable behavior — the actual JSON shape and level-filtering a
caller depends on — rather than inspecting structlog's internal config.
"""

from __future__ import annotations

import io
import json
import sys

import structlog

from shared_logging_setup import configure_logging


def _configure_and_capture(level: str, monkeypatch) -> io.StringIO:
    buf = io.StringIO()
    # PrintLoggerFactory reads sys.stdout at the moment each bound logger is
    # first created (then caches it), so stdout must be redirected BEFORE
    # configure_logging runs, not after.
    monkeypatch.setattr(sys, "stdout", buf)
    configure_logging(level)
    return buf


def test_emits_one_json_line_with_event_and_level(monkeypatch):
    buf = _configure_and_capture("info", monkeypatch)
    # A distinct logger name per test: cache_logger_on_first_use means a name
    # reused across tests would return the FIRST test's cached logger, still
    # bound to that test's (by-then-restored) stdout.
    log = structlog.get_logger("test-service-shape")
    log.info("something_happened", detail="x")

    line = buf.getvalue().strip()
    payload = json.loads(line)
    assert payload["event"] == "something_happened"
    assert payload["detail"] == "x"
    assert payload["level"] == "info"
    assert "timestamp" in payload


def test_level_filtering_drops_debug_below_info(monkeypatch):
    buf = _configure_and_capture("info", monkeypatch)
    log = structlog.get_logger("test-service-filter")
    log.debug("should_be_dropped")
    log.info("should_appear")

    lines = [line for line in buf.getvalue().splitlines() if line.strip()]
    assert len(lines) == 1
    assert json.loads(lines[0])["event"] == "should_appear"


def test_unknown_level_falls_back_to_info(monkeypatch):
    buf = _configure_and_capture("not-a-real-level", monkeypatch)
    log = structlog.get_logger("test-service-fallback")
    log.debug("dropped_at_info_default")
    log.info("kept_at_info_default")

    lines = [line for line in buf.getvalue().splitlines() if line.strip()]
    assert len(lines) == 1
    assert json.loads(lines[0])["event"] == "kept_at_info_default"
