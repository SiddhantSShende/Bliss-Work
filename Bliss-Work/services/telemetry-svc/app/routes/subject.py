"""Who is allowed to read whose activity.

This one function is the ENTIRE enforcement point of the transparency model:
every member may read their own record, and only an org_admin may read someone
else's. Every read route resolves its subject through it, so there is exactly one
place to audit and exactly one place that can be wrong.

Keeping it here — rather than as a FastAPI dependency per route — is deliberate.
A dependency is easy to forget on a new route and the omission looks like
nothing; a route that does not call `resolve_subject` has no user id to query
with and cannot be written by accident.
"""
from __future__ import annotations

from fastapi import HTTPException, status

from ..auth import Principal

# The path segment a client uses to mean "me" without knowing its own id.
SELF = "me"


def resolve_subject(principal: Principal, user_id: str | None) -> str:
    """The member whose activity the caller may read, or 403."""
    if user_id in (None, "", SELF, principal.user_id):
        return principal.user_id
    if "org_admin" not in principal.roles:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "you can only view your own activity",
        )
    return user_id


def require_admin(principal: Principal) -> None:
    """For the org-wide views, which have no single subject to resolve."""
    if "org_admin" not in principal.roles:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "org_admin role required")
