"""Batch user lookup: request parsing, with no HTTP or DB dependency.

Split out from `auth.py` so the parsing rules can be tested without FastAPI,
SQLAlchemy or a database — the same shape as `members_service.py`.
"""
from __future__ import annotations

from uuid import UUID

# A ceiling on one batch, and the reason it is 200 rather than 5000.
#
# This endpoint exists to resolve the handful of people visible on one screen —
# the senders of an inbox page, the assignees of a task list. That is bounded by
# rows rendered, and no page in the product renders more than a couple of
# hundred rows.
#
# It is DELIBERATELY far below MAX_DIRECTORY_PAGE (5000). `/auth/directory` is
# the enumeration endpoint and is paged for that job; this one must not become a
# faster way to enumerate an org, so a caller wanting everyone is pushed back to
# the endpoint whose cost is understood.
MAX_BATCH_IDS = 200


class InvalidUserIds(ValueError):
    """The `ids` query parameter could not be parsed. Carries a caller-safe
    message — it names the rule that was broken, never the offending value,
    which is attacker-controlled and would land in logs and error bodies."""


def parse_user_ids(raw: str | None) -> list[str]:
    """Parse `?ids=a,b,c` into a de-duplicated list of canonical UUID strings.

    De-duplication matters because the caller is typically a DataLoader batching
    one render: twenty inbox rows from the same sender arrive as twenty copies of
    one id, and passing those through would make the `= ANY(...)` scan and the
    per-row decrypt do the same work twenty times.

    Order is preserved so the response is stable for a given request, which keeps
    it cacheable and keeps tests deterministic. Callers must still match on `id`
    rather than position — missing users are omitted, not returned as nulls.
    """
    if raw is None:
        raise InvalidUserIds("ids is required")

    seen: set[str] = set()
    out: list[str] = []
    for part in raw.split(","):
        token = part.strip()
        if not token:
            continue  # tolerate "a,,b" and a trailing comma
        try:
            canonical = str(UUID(token))
        except ValueError:
            raise InvalidUserIds("ids must be a comma-separated list of UUIDs") from None
        if canonical in seen:
            continue
        seen.add(canonical)
        out.append(canonical)

    if not out:
        raise InvalidUserIds("ids is required")
    if len(out) > MAX_BATCH_IDS:
        raise InvalidUserIds(
            f"ids accepts at most {MAX_BATCH_IDS} ids per request; "
            "use /auth/directory to enumerate the organisation"
        )
    return out
