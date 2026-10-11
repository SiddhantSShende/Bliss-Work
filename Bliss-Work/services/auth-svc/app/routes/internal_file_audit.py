"""Internal: file-access events from telemetry-svc into the hash-chained audit log.

The member-detail Security tab reads `audit_log` (routes/members.py `GET /audit`)
and auth-svc is its only writer, because the chain is per-org and serialised by
one advisory lock. telemetry-svc is where a file open/download is first seen, so
it reports each one here and this module appends it through the same
`service.write_audit` every other audit row uses — no second audit store.

Who is trusted for what
  * The CALLER is trusted to say "this org and this user" — it is another of our
    services, authenticated by `X-Internal-Token` (fail-closed, constant-time),
    and it takes the org and user from a verified JWT, never from a request body.
  * The FACT that a file was opened is not independently witnessed. It originates
    in the client, so the row says `reportedBy: client` in `meta`, exactly like
    telemetry's own self-reported rows. The actor is still real: a user that does
    not belong to the org is refused rather than written.

Delivery is at-least-once (telemetry fails the beacon when this call fails, and
the client resends it), so a write is idempotent on `meta.eventId`; see
migrations/0022_audit_file_event_id.sql.

Written with `target` = the actor, the convention for "something this member did"
(auth.login, auth.logout), which is also what puts it on THAT member's Security
tab: the tab filters `audit_log.target` by the member id.
"""
from __future__ import annotations

import os
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from internal_auth import internal_token_matches
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .. import service
from ..db import engine
from . import session_events

router = APIRouter(prefix="/internal", tags=["internal"])

_INTERNAL_TOKEN = os.getenv("AUTH_INTERNAL_TOKEN", "")

FileAction = Literal["file.opened", "file.downloaded"]


class FileAuditEvent(BaseModel):
    """One file open/download. Every field is bounded: a compromised caller must
    not be able to park arbitrary data in a table that is never pruned."""

    eventId: UUID
    actorId: UUID
    action: FileAction
    occurredAt: str | None = Field(default=None, max_length=40)
    platform: str | None = Field(default=None, max_length=16)
    fileId: str | None = Field(default=None, max_length=128)
    fileName: str | None = Field(default=None, max_length=255)
    contextKind: Literal["direct", "channel"] | None = None
    contextId: str | None = Field(default=None, max_length=128)
    contextName: str | None = Field(default=None, max_length=255)
    # telemetry's own session row; the auth session (refresh family) is `sessionId`.
    activitySessionId: str | None = Field(default=None, max_length=36)
    sessionId: str | None = Field(default=None, max_length=64)
    ip: str | None = Field(default=None, max_length=64)
    userAgent: str | None = Field(default=None, max_length=512)
    requestId: str | None = Field(default=None, max_length=128)


class FileAuditBatch(BaseModel):
    orgId: UUID
    events: list[FileAuditEvent] = Field(min_length=1, max_length=100)


class FileAuditResult(BaseModel):
    written: int
    duplicates: int
    rejected: int


def file_event_meta(ev: FileAuditEvent) -> dict:
    """`meta` for one event. Key names for the file/chat parts deliberately match
    telemetry's beacon `detail` (filename, contextKind/Id/Name) so the app renders
    both records with one set of labels."""
    extras: dict[str, object] = {
        "eventId": str(ev.eventId),
        "reportedBy": "client",
        "occurredAt": ev.occurredAt,
        "platform": ev.platform,
        "fileId": ev.fileId,
        "filename": ev.fileName,
        "contextKind": ev.contextKind,
        "contextId": ev.contextId,
        "contextName": ev.contextName,
        "activitySessionId": ev.activitySessionId,
    }
    return session_events.context_meta(
        session_id=ev.sessionId,
        ip=ev.ip,
        user_agent=ev.userAgent,
        request_id=ev.requestId,
        **{k: v for k, v in extras.items() if v is not None},
    )


async def record_file_events_tx(
    conn: AsyncConnection, org_id: str, events: list[FileAuditEvent]
) -> FileAuditResult:
    """Append each event to the org's chain unless it is already there.

    Assumes `service.set_org_guc(conn, org_id)` has run. The org's audit lock is
    taken BEFORE the existence check (it is re-entrant, so `write_audit` taking
    it again is free): checked outside the lock, two deliveries of one event could
    both see "absent" and both write.
    """
    await conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k)::bigint)"), {"k": f"audit:{org_id}"}
    )
    actor_ids = sorted({str(e.actorId) for e in events})
    members = {
        str(r.id)
        for r in (
            await conn.execute(
                text("SELECT id FROM users WHERE org_id = :o AND id = ANY(CAST(:ids AS uuid[]))"),
                {"o": org_id, "ids": actor_ids},
            )
        ).all()
    }
    written = duplicates = rejected = 0
    for ev in events:
        actor = str(ev.actorId)
        if actor not in members:
            rejected += 1
            continue
        seen = (
            await conn.execute(
                text(
                    # The action list repeats the partial index's predicate on
                    # purpose: without it the planner cannot use the index.
                    "SELECT 1 FROM audit_log WHERE org_id = :o AND meta ->> 'eventId' = :e "
                    "AND action IN ('file.opened', 'file.downloaded')"
                ),
                {"o": org_id, "e": str(ev.eventId)},
            )
        ).first()
        if seen is not None:
            duplicates += 1
            continue
        await service.write_audit(
            conn,
            org_id=org_id,
            actor_id=actor,
            action=ev.action,
            target=actor,
            meta=file_event_meta(ev),
        )
        written += 1
    return FileAuditResult(written=written, duplicates=duplicates, rejected=rejected)


async def require_internal_token(
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> None:
    """A dependency rather than a line in the handler: FastAPI resolves it before
    it validates the body, so an unauthenticated caller learns nothing about the
    request schema from a 422 — it gets the same 401 whatever it sends."""
    if not internal_token_matches(x_internal_token, _INTERNAL_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal token")


@router.post(
    "/audit/file-events",
    response_model=FileAuditResult,
    dependencies=[Depends(require_internal_token)],
)
async def record_file_events(body: FileAuditBatch) -> FileAuditResult:
    """Append file open/download events to an org's audit chain. Idempotent."""
    org_id = str(body.orgId)
    async with engine.begin() as conn:
        await service.set_org_guc(conn, org_id)
        return await record_file_events_tx(conn, org_id, body.events)
