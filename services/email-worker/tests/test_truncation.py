"""Pure-logic tests for the relay subject/body truncation contract.

``relay_consumer._send_for_event`` caps user-controlled strings before they land
in an email so oversized values can't blow up an SMTP header (the task *title*
goes into the Subject) or bloat the body:

    body  = (event.get("body")        or "")[:PREVIEW_LEN]            # message
    title = (event.get("title", "")   or "Untitled task")[:TITLE_LEN] # task
    desc  = (event.get("description", "") or "")[:PREVIEW_LEN]        # task

These tests import the REAL ``PREVIEW_LEN`` / ``TITLE_LEN`` constants from the
module (so the assertions track production if the limits ever change) and pin
the exact slice + empty-fallback behaviour. No DB/Kafka/Redis is touched; the
constants are plain module-level ints.
"""
from __future__ import annotations

import pytest

from app.relay_consumer import PREVIEW_LEN, TITLE_LEN


# --- helpers that mirror the production expressions verbatim -----------------
def _message_body(event: dict) -> str:
    return (event.get("body") or "")[:PREVIEW_LEN]


def _task_title(event: dict) -> str:
    return (event.get("title", "") or "Untitled task")[:TITLE_LEN]


def _task_description(event: dict) -> str:
    return (event.get("description", "") or "")[:PREVIEW_LEN]


def test_limits_are_sane_positive_ints() -> None:
    assert isinstance(PREVIEW_LEN, int) and PREVIEW_LEN > 0
    assert isinstance(TITLE_LEN, int) and TITLE_LEN > 0


@pytest.mark.parametrize(
    "raw_len, expected_len",
    [
        (0, 0),                       # empty stays empty
        (1, 1),                       # short under-cap passthrough
        (PREVIEW_LEN - 1, PREVIEW_LEN - 1),
        (PREVIEW_LEN, PREVIEW_LEN),   # exactly at the cap is untouched
        (PREVIEW_LEN + 1, PREVIEW_LEN),  # one over -> trimmed
        (PREVIEW_LEN * 5, PREVIEW_LEN),  # far over -> trimmed to cap
    ],
)
def test_message_body_truncated_to_preview_len(raw_len: int, expected_len: int) -> None:
    out = _message_body({"body": "x" * raw_len})
    assert len(out) == expected_len
    # Truncation must be a prefix slice, never a re-encode/replace.
    assert out == ("x" * raw_len)[:PREVIEW_LEN]


@pytest.mark.parametrize(
    "raw_len, expected_len",
    [
        (1, 1),
        (TITLE_LEN - 1, TITLE_LEN - 1),
        (TITLE_LEN, TITLE_LEN),
        (TITLE_LEN + 1, TITLE_LEN),
        (TITLE_LEN * 3, TITLE_LEN),
    ],
)
def test_task_title_truncated_to_title_len(raw_len: int, expected_len: int) -> None:
    out = _task_title({"title": "T" * raw_len})
    assert len(out) == expected_len
    assert out == ("T" * raw_len)[:TITLE_LEN]


@pytest.mark.parametrize(
    "raw_len, expected_len",
    [
        (0, 0),
        (PREVIEW_LEN, PREVIEW_LEN),
        (PREVIEW_LEN + 50, PREVIEW_LEN),
    ],
)
def test_task_description_truncated_to_preview_len(raw_len: int, expected_len: int) -> None:
    out = _task_description({"description": "d" * raw_len})
    assert len(out) == expected_len


@pytest.mark.parametrize(
    "event",
    [
        {},                       # key absent
        {"title": ""},            # empty string
        {"title": None},          # explicit null in the payload
    ],
)
def test_missing_or_empty_title_falls_back_to_default(event: dict) -> None:
    # An absent/empty/null title must not yield an empty Subject; the code
    # substitutes a non-empty default before capping.
    assert _task_title(event) == "Untitled task"


@pytest.mark.parametrize(
    "event",
    [
        {},
        {"body": ""},
        {"body": None},
    ],
)
def test_missing_or_empty_message_body_is_empty_string(event: dict) -> None:
    # Unlike the title, an empty message body legitimately renders as "".
    assert _message_body(event) == ""


@pytest.mark.parametrize(
    "event",
    [
        {},
        {"description": ""},
        {"description": None},
    ],
)
def test_missing_or_empty_description_is_empty_string(event: dict) -> None:
    assert _task_description(event) == ""
