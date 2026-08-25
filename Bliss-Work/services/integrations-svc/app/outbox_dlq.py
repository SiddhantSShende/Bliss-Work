"""Quarantine for outbox rows that can never be published.

Re-exports the shared implementation (services/shared/outbox_dlq) — identical
across every Python service's outbox poller. See outbox_dlq.outbox_dlq for
the why/how.
"""
from __future__ import annotations

from outbox_dlq import (
    MAX_PUBLISH_ATTEMPTS,
    MAX_PUBLISH_BYTES,
    payload_bytes,
    quarantine_oversize,
    record_publish_failure,
)

__all__ = [
    "MAX_PUBLISH_ATTEMPTS",
    "MAX_PUBLISH_BYTES",
    "payload_bytes",
    "quarantine_oversize",
    "record_publish_failure",
]
