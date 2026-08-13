"""Opaque keyset cursors for the activity timeline.

Keyset, not OFFSET: activity arrives continuously at the head of the timeline
(a heartbeat every 60s per open client), and with OFFSET every new arrival
shifts the page boundary — an admin scrolling a member's history would see a row
twice, or miss one entirely. Ordering by (occurred_at DESC, id DESC) and paging
on the tuple is stable no matter what lands mid-scroll.

Byte-identical to services/integrations-svc/app/cursor.py, which paginates the
mentions feed on the same tuple shape.

The cursor is base64url("{iso8601}|{uuid}") purely so clients treat it as
opaque and don't start constructing their own; it is NOT a security boundary.
It encodes a position in the caller's own feed, and every query re-filters by
org + user anyway, so a forged cursor can only move someone around inside
results they can already see.
"""

from __future__ import annotations

import base64
import binascii
from datetime import datetime


def encode_cursor(occurred_at: datetime, row_id: str) -> str:
    raw = f"{occurred_at.isoformat()}|{row_id}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(raw: str) -> tuple[datetime, str]:
    """Inverse of encode_cursor. Raises ValueError on anything malformed so the
    route can answer 400 rather than 500."""
    try:
        padded = raw + "=" * (-len(raw) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise ValueError("malformed cursor") from exc

    ts_str, sep, row_id = decoded.partition("|")
    if not sep or not row_id:
        raise ValueError("malformed cursor")
    # fromisoformat raises ValueError itself, which is exactly what we promise.
    return datetime.fromisoformat(ts_str), row_id
