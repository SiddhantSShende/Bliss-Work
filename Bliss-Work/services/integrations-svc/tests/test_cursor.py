"""Keyset cursor round-tripping.

Losing sub-second precision here would make two mentions in the same second
page badly — one silently skipped or repeated forever.
"""

from datetime import datetime, timezone

import pytest

from app.cursor import decode_cursor, encode_cursor

ROW = "01919e8a-0000-7000-8000-000000000001"


def test_round_trip_preserves_microseconds_and_id():
    ts = datetime(2026, 7, 25, 10, 30, 45, 123456, tzinfo=timezone.utc)
    got_ts, got_id = decode_cursor(encode_cursor(ts, ROW))
    assert got_ts == ts
    assert got_id == ROW


def test_round_trip_preserves_timezone_offset():
    ts = datetime.fromisoformat("2026-07-25T10:30:45.5+05:30")
    got_ts, _ = decode_cursor(encode_cursor(ts, ROW))
    assert got_ts == ts


def test_cursor_is_url_safe_and_unpadded():
    ts = datetime(2026, 7, 25, tzinfo=timezone.utc)
    cur = encode_cursor(ts, ROW)
    assert "=" not in cur and "+" not in cur and "/" not in cur


def test_cursors_order_the_same_way_as_their_timestamps():
    older = datetime(2026, 7, 25, 10, 0, 0, tzinfo=timezone.utc)
    newer = datetime(2026, 7, 25, 11, 0, 0, tzinfo=timezone.utc)
    assert decode_cursor(encode_cursor(older, ROW))[0] < decode_cursor(encode_cursor(newer, ROW))[0]


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "!!!not base64!!!",
        "Zm9vYmFy",  # decodes to "foobar" — no separator
        "MjAyNi0wNy0yNQ",  # timestamp only, no "|id"
        "fDEyMw",  # "|123" — empty timestamp
        "bm90LWEtdGltZXN0YW1wfHgtaWQ",  # "not-a-timestamp|x-id"
    ],
)
def test_malformed_cursors_raise_valueerror_so_the_route_can_400(bad):
    with pytest.raises(ValueError):
        decode_cursor(bad)
