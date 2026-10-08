"""Helpers for keeping email addresses out of operational logs."""
from __future__ import annotations

import hashlib
import re

_EMAIL_IN_TEXT = re.compile(r"[^\s<>\"',;()]+@[^\s<>\"',;()]+")


def recipient_ref(address: str) -> str:
    """Return a stable opaque reference for correlating recipient log entries."""
    return hashlib.sha256(address.strip().lower().encode("utf-8")).hexdigest()[:16]


def redact_email_addresses(value: object) -> str:
    """Remove email-like strings from exception text before logging it."""
    return _EMAIL_IN_TEXT.sub("<email>", str(value))
