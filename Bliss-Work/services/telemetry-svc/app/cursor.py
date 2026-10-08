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
import uuid


def encode_cursor(occurred_at: datetime, row_id: str) -> str:
    raw = f"{occurred_at.isoformat()}|{row_id}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(raw: str) -> tuple[datetime, str]:
    """Inverse of encode_cursor. Raises ValueError on anything malformed so the
    route can answer 400 rather than 500."""
    if not raw or len(raw) > 128 or any(ch not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for ch in raw):
        raise ValueError("malformed cursor")
    try:
        padded = raw + "=" * (-len(raw) % 4)
        decoded_bytes = base64.b64decode(padded.encode("ascii"), altchars=b"-_", validate=True)
        decoded = decoded_bytes.decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise ValueError("malformed cursor") from exc

    if base64.urlsafe_b64encode(decoded_bytes).decode("ascii").rstrip("=") != raw:
        raise ValueError("malformed cursor")
    ts_str, sep, row_id = decoded.partition("|")
    if not sep or not row_id or "|" in row_id:
        raise ValueError("malformed cursor")
    try:
        occurred_at = datetime.fromisoformat(ts_str)
        if occurred_at.tzinfo is None or occurred_at.utcoffset() is None:
            raise ValueError("cursor timestamp must include a timezone")
        normalized_id = str(uuid.UUID(row_id))
    except (ValueError, OverflowError) as exc:
        raise ValueError("malformed cursor") from exc
    return occurred_at, normalized_id
