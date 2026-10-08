"""Validation for event-derived identifiers used in internal URL paths."""
from __future__ import annotations

from uuid import UUID


def uuid_path_segment(value: object, field: str) -> str:
    """Return a canonical UUID path segment or fail without echoing input."""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a UUID")
    try:
        return str(UUID(value))
    except ValueError:
        raise ValueError(f"{field} must be a UUID") from None
