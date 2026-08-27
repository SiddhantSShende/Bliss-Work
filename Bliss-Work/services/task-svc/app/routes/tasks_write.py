from __future__ import annotations

import json

import httpx
import uuid6
from fastapi import APIRouter, Header, HTTPException, status
from internal_auth import internal_token_matches
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import events
from ..auth import Principal, PrincipalDep
from ..config import settings
from crypto import cryptor
from ..db import session, set_org_context
from ..logging_setup import log
from ..schemas import CreateTaskRequest, CreateTaskResponse, _MAX_ASSIGNEES
from .helpers import enqueue_outbox, resolve_username

router = APIRouter()

# Cap on candidate rows considered by the unscoped (no username) branch of
# delete_task_by_title_internal — see its docstring.
_CANDIDATE_LIMIT = 100


async def _resolve_channel_members(channel_id: str, org_id: str) -> list[str]:
    """Call messaging-svc's internal endpoint to fetch the channel's current
    member ids. Falls back to an empty list (caller decides what to do) on
    any transport / auth failure — the caller's HTTPException converts that
    into a 400 so the user gets a clean error instead of a half-created task.

    The org_id from the caller's JWT is checked against the org_id the
    channel belongs to so a cross-org attacker can't fan-out via a channel
    they aren't in.
    """
    headers = {"X-Internal-Token": settings.messaging_internal_token}
    url = f"{settings.messaging_internal_base}/internal/channels/{channel_id}/members"
    async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0)) as client:
        try:
            resp = await client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            log.warning("channel_members_fetch_failed", channel_id=channel_id, error=str(exc))
            raise HTTPException(status_code=503, detail="messaging service unreachable") from exc
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="channel not found")
    if resp.status_code != 200:
        log.warning(
            "channel_members_unexpected_status",
            channel_id=channel_id,
            status=resp.status_code,
        )
        raise HTTPException(status_code=502, detail="messaging service error")
    body = resp.json()
    if body.get("orgId") != org_id:
        # Cross-org probe — pretend it doesn't exist.
        raise HTTPException(status_code=404, detail="channel not found")
    return list(body.get("memberIds") or [])


@router.post("/tasks", response_model=CreateTaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task(
    body: CreateTaskRequest,
    principal: Principal = PrincipalDep,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> CreateTaskResponse:
    org_id = principal.org_id
    sender_id = principal.user_id

    # Allocation surface: either explicit assignees OR a channelId. When a
    # channelId is supplied, we resolve its current members server-side so
    # the client can't lie about the recipient list AND so future joiners
    # can be auto-fanned via the ChannelMemberJoined consumer (using the
    # tasks.channel_id we persist below).
    channel_id = body.channelId
    if channel_id:
        assignee_ids = [a for a in dict.fromkeys(await _resolve_channel_members(channel_id, org_id))]
    else:
        assignee_ids = [a for a in dict.fromkeys(body.assigneeIds)]
        # A task always has a distinct sender and assignee — the
        # Acknowledge/Ignore lifecycle assumes someone else sent it. The People
        # picker excludes the caller from candidates, but that is client-side
        # only; this is the boundary that must hold regardless of what any
        # client (this one, a future one, or a raw API call) sends. Channel
        # mode is intentionally exempt: fanning a task to a channel the caller
        # is themselves a member of is a real, distinct product choice, not
        # this bug.
        if sender_id in assignee_ids:
            raise HTTPException(status_code=400, detail="cannot assign a task to yourself")
    if not assignee_ids:
        raise HTTPException(status_code=400, detail="at least one assignee required")

    async with session() as db:
        # RLS: bind the org context FIRST, before any statement (incl. the
        # encrypt() calls that read/write org_keys), so every INSERT below
        # passes the org_isolation WITH CHECK and reads stay scoped.
        await set_org_context(db, org_id)

        task_id = str(uuid6.uuid7())

        # Idempotency: claim the key FIRST to close the check-then-insert race.
        # We INSERT the (org, key) → task_id row up front; the unique
        # constraint means a concurrent (or replayed) request loses here, and
        # we then resolve + return the WINNING task instead of creating a
        # second one. The whole claim+inserts run in one transaction so a
        # failure after the claim rolls the key back too.
        if idempotency_key:
            try:
                await db.execute(
                    text(
                        "INSERT INTO idempotency_keys (org_id, key, task_id) "
                        "VALUES (:org, :key, :tid)"
                    ),
                    {"org": org_id, "key": idempotency_key, "tid": task_id},
                )
            except IntegrityError:
                # Duplicate key — return the task the winner created/owns.
                # The rollback clears the transaction-local org GUC, so re-bind
                # it before the lookup or RLS would fail the read closed.
                await db.rollback()
                await set_org_context(db, org_id)
                existing = (
                    await db.execute(
                        text(
                            "SELECT task_id FROM idempotency_keys "
                            "WHERE org_id = :org AND key = :key"
                        ),
                        {"org": org_id, "key": idempotency_key},
                    )
                ).first()
                if existing:
                    return CreateTaskResponse(taskId=str(existing.task_id))
                raise

        sender_username = await resolve_username(db, org_id, sender_id) or principal.username

        # Encrypt PII (title/description) at rest under the org's DEK. The DEK is
        # created lazily inside THIS write transaction on first use for the org.
        # The Kafka event below still carries plaintext (the relay + messaging
        # projection need it) — we keep the plaintext in-memory and only store
        # ciphertext.
        title_enc = await cryptor().encrypt(db, org_id, body.title)
        desc_enc = await cryptor().encrypt(db, org_id, body.description or "")

        await db.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc, channel_id) "
                "VALUES (:id, :org, :sender, :title_enc, :desc_enc, :ch)"
            ),
            {
                "id": task_id,
                "org": org_id,
                "sender": sender_id,
                "title_enc": title_enc,
                "desc_enc": desc_enc,
                "ch": channel_id,
            },
        )

        for assignee_id in assignee_ids:
            await db.execute(
                text(
                    "INSERT INTO task_assignees (task_id, org_id, assignee_id, status, status_version) "
                    "VALUES (:tid, :org, :aid, 'SENT', 0)"
                ),
                {"tid": task_id, "org": org_id, "aid": assignee_id},
            )
            evt = events.task_assigned(
                org_id=org_id,
                task_id=task_id,
                assignee_id=assignee_id,
                sender_id=sender_id,
                status_version=0,
                sender_username=sender_username,
                title=body.title,
                description=body.description or "",
            )
            await enqueue_outbox(db, events.TASK_TOPIC, task_id, evt)

        await db.commit()
        log.info(
            "task_created",
            task_id=task_id,
            assignees=len(assignee_ids),
            channel_id=channel_id,
        )
        return CreateTaskResponse(taskId=task_id)


@router.delete("/internal/tasks/by-title/{title}")
async def delete_task_by_title_internal(
    title: str,
    org_id: str,
    username: str | None = None,
    internal_token: str | None = Header(default=None, alias="X-Internal-Token"),
) -> dict:
    """Internal admin endpoint: delete tasks by title using internal token.

    This endpoint is for internal service-to-service calls and admin operations.
    Requires X-Internal-Token header matching the configured internal token.

    `org_id` is required (FastAPI 422s the request if it's missing — the same
    validation-error convention every other endpoint in this service already
    uses, see errors.py) and is bound as the RLS context via
    `set_org_context` before any query, so a caller can never scope this
    delete wider than one org — deliberately not a bypass-RLS cross-org admin
    operation, which is what this endpoint used to be.

    Deletes all tasks with the specified title in that org. If username is
    provided, only deletes tasks created by that username.

    Titles are stored encrypted (title_enc) under each org's own DEK, with no
    plaintext column and no search index, so matching by title means fetching
    candidate rows and decrypting each with its own org_id before comparing.

    The unscoped (no username) branch is capped at _CANDIDATE_LIMIT candidate
    rows: an org-wide delete by title has no bound on how many tasks could
    match, and decrypting every task in a large org on a single internal-token
    call is both an unbounded-cost query and an unbounded-blast-radius delete.
    A caller that hits the cap must narrow with `username` instead of getting
    a silently-truncated delete.
    """
    # Verify internal token (constant-time — a stolen internal secret should
    # not be discoverable via response-timing on this comparison).
    if not internal_token_matches(internal_token, settings.internal_token):
        raise HTTPException(status_code=403, detail="invalid internal token")

    async with session() as db:
        await set_org_context(db, org_id)

        if username:
            # Only tasks created by the specified username, in this org.
            # The explicit org_id filter is defense-in-depth alongside RLS.
            candidates = (
                await db.execute(
                    text(
                        "SELECT t.id, t.org_id, t.title_enc FROM tasks t "
                        "JOIN user_projection u ON t.sender_id = u.user_id "
                        "WHERE u.username = :username AND t.org_id = :org_id"
                    ),
                    {"username": username, "org_id": org_id},
                )
            ).all()
        else:
            # All tasks in this org (never across orgs), capped so a caller
            # can't force an unbounded decrypt loop / unbounded delete.
            candidates = (
                await db.execute(
                    text(
                        "SELECT id, org_id, title_enc FROM tasks "
                        "WHERE org_id = :org_id LIMIT :limit"
                    ),
                    {"org_id": org_id, "limit": _CANDIDATE_LIMIT + 1},
                )
            ).all()
            if len(candidates) > _CANDIDATE_LIMIT:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"org has more than {_CANDIDATE_LIMIT} tasks; "
                        "pass `username` to narrow the delete"
                    ),
                )

        matching_ids = [
            str(row.id)
            for row in candidates
            if await cryptor().decrypt(db, str(row.org_id), row.title_enc) == title
        ]

        if not matching_ids:
            await db.commit()
            return {
                "deleted_tasks": 0,
                "deleted_assignees": 0,
                "title": title,
                "username": username,
            }

        result = await db.execute(
            text("DELETE FROM task_assignees WHERE task_id = ANY(:ids)"),
            {"ids": matching_ids},
        )
        assignees_deleted = result.rowcount

        result = await db.execute(
            text("DELETE FROM tasks WHERE id = ANY(:ids) RETURNING id"),
            {"ids": matching_ids},
        )
        tasks_deleted = result.rowcount

        await db.commit()
        log.info(
            "tasks_deleted_by_title",
            title=title,
            username=username,
            tasks_count=tasks_deleted,
            assignees_count=assignees_deleted,
        )

        return {
            "deleted_tasks": tasks_deleted,
            "deleted_assignees": assignees_deleted,
            "title": title,
            "username": username,
        }
