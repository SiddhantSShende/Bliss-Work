"""Report file opens/downloads to auth-svc's hash-chained audit log.

telemetry-svc keeps its own `security` row for every file act (ingest.
security_mirror_of); that is the Security FILTER on the activity timeline. The
member-detail Security TAB is a different store — auth-svc's `audit_log` — and
auth-svc is its only writer, so each act is also reported there through
auth-svc's internal API. Nothing is written to that log from here directly.

Delivery contract (the caller is routes/ingest.py):
  * Called AFTER the beacon's rows are committed, only for file acts.
  * Raises `AuditForwardError` on ANY failure to confirm the write. The route
    answers 503, the client keeps the batch and resends it unchanged, and the
    resend lands here again; auth-svc writes one row per `eventId`, so
    re-delivery is harmless. That resend is the whole retry mechanism — there is
    no queue here to lose.
"""
from __future__ import annotations

from datetime import datetime
from typing import Iterable

import httpx

from .config import settings
from .ingest import ActivityRow
from .logging_setup import log

_TIMEOUT_SECONDS = 3.0
_CONTEXT_KINDS = frozenset({"direct", "channel"})
# 400/422 only. 401/403 (a wrong shared secret) and 429/5xx are an operator's or
# a transient problem and DO fail the beacon, so the acts are not silently lost.
_PERMANENT_REFUSALS = frozenset({400, 422})

_client: httpx.AsyncClient | None = None


class AuditForwardError(RuntimeError):
    """auth-svc did not confirm the audit write."""


def _shared_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=_TIMEOUT_SECONDS)
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _text(value: object, limit: int) -> str | None:
    if value is None or str(value).strip() == "":
        return None
    return str(value)[:limit]


def file_audit_event(
    row: ActivityRow,
    event_id: str,
    *,
    auth_session_id: str | None,
    ip: str | None,
    user_agent: str | None,
    request_id: str | None,
) -> dict[str, object | None]:
    """One security row, shaped for auth-svc's `FileAuditEvent`.

    The chat/channel context is taken exactly as the client captured it; a kind
    this service does not know (or a context without a name) is left out rather
    than guessed, so the audit row never says "in undefined".
    """
    detail = row.detail
    kind = detail.get("contextKind")
    in_context = kind in _CONTEXT_KINDS
    occurred: datetime = row.occurred_at
    return {
        "eventId": event_id,
        "actorId": row.user_id,
        "action": row.action,
        "occurredAt": occurred.isoformat(),
        "platform": _text(row.source, 16),
        "fileId": _text(row.target_id, 128),
        "fileName": _text(detail.get("filename"), 255),
        "contextKind": kind if in_context else None,
        "contextId": _text(detail.get("contextId"), 128) if in_context else None,
        "contextName": _text(detail.get("contextName"), 255) if in_context else None,
        "activitySessionId": _text(row.session_id, 36),
        "sessionId": _text(auth_session_id, 64),
        "ip": _text(ip, 64),
        "userAgent": _text(user_agent, 512),
        "requestId": _text(request_id, 128),
    }


async def forward_file_events(
    org_id: str,
    events: Iterable[dict[str, object | None]],
    *,
    client: httpx.AsyncClient | None = None,
) -> None:
    batch = list(events)
    if not batch:
        return
    if not settings.auth_internal_token:
        # Unreachable in production (config refuses to boot without it). In a
        # dev stack without the secret there is nothing to authenticate with.
        log.warning("file_audit_forward_skipped_no_token", events=len(batch))
        return
    url = f"{settings.auth_internal_base.rstrip('/')}/internal/audit/file-events"
    try:
        resp = await (client or _shared_client()).post(
            url,
            json={"orgId": org_id, "events": batch},
            headers={"X-Internal-Token": settings.auth_internal_token},
        )
    except httpx.HTTPError as exc:
        log.warning("file_audit_forward_failed", error=type(exc).__name__, events=len(batch))
        raise AuditForwardError("auth-svc unreachable") from exc
    if resp.status_code in _PERMANENT_REFUSALS:
        # The payload itself is invalid. Resending the same bytes cannot succeed,
        # and failing the beacon would wedge the client behind its own retry — so
        # this is the one failure that is logged loudly and NOT retried.
        log.error("file_audit_forward_invalid", status=resp.status_code, events=len(batch))
        return
    if resp.status_code != 200:
        log.warning("file_audit_forward_rejected", status=resp.status_code, events=len(batch))
        raise AuditForwardError(f"auth-svc answered {resp.status_code}")
    result = resp.json()
    if result.get("rejected"):
        # A permanent answer (the actor is not a member of the org): retrying
        # cannot change it, so it is logged, not raised.
        log.warning("file_audit_events_rejected", rejected=result["rejected"], events=len(batch))
