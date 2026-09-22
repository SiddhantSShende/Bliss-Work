from __future__ import annotations

import json
import uuid

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
from ..schemas import CreateTaskRequest, CreateTaskResponse, MAX_ASSIGNEES
from .helpers import enqueue_outbox, resolve_username

router = APIRouter()

# Cap on candidate rows considered by the unscoped (no username) branch of
# delete_task_by_title_internal — see its docstring.
_CANDIDATE_LIMIT = 100


async def _resolve_channel_members(channel_id: str, org_id: str, caller_id: str) -> list[str]:
    """Call messaging-svc's internal endpoint to fetch the channel's current
    member ids. Falls back to an empty list (caller decides what to do) on
    any transport / auth failure — the caller's HTTPException converts that
    into a 400 so the user gets a clean error instead of a half-created task.

    org_id and caller_id (the user creating the task) are passed so
    messaging-svc can verify BOTH that the channel belongs to this org AND
    that caller_id is actually a member of it — task-svc has no
    channel_members table of its own to check that against, so this is the
    only gate against an org member naming a private/locked channel they
    never joined to fan a task out to its whole membership.
    """
    headers = {"X-Internal-Token": settings.messaging_internal_token}
    url = f"{settings.messaging_internal_base}/internal/channels/{channel_id}/members"
    params = {"orgId": org_id, "callerId": caller_id}
    async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0)) as client:
        try:
            resp = await client.get(url, headers=headers, params=params)
        except httpx.HTTPError as exc:
            log.warning("channel_members_fetch_failed", channel_id=channel_id, error=str(exc))
            raise HTTPException(status_code=503, detail="messaging service unreachable") from exc
    if resp.status_code == 404:
        # Same response whether the channel doesn't exist, belongs to another
        # org, or caller_id isn't a member of it — see the endpoint's docstring.
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
        # Defense in depth: messaging-svc already checked this server-side.
        raise HTTPException(status_code=404, detail="channel not found")
    return list(body.get("memberIds") or [])


async def _require_org_members(db: AsyncSession, org_id: str, user_ids: list[str]) -> None:
    """Every assignee the CLIENT named must be an active member of the caller's org.

    Without it a task can be pushed to a user id from another org: the assignee row
    is stamped with the caller's org, so RLS is satisfied, and ws-gateway routes
    task.assigned to the assignee by id alone. An id from another org, an id nobody
    has and a deactivated member all get the same 400, so the endpoint cannot be
    used to probe which ids exist.

    Checked against user_projection (the same mirror the assignee picker and the
    Available roster already rely on). Channel-derived assignees are not checked
    here: messaging-svc has already resolved them within the org.
    """
    rows = await db.execute(
        text(
            "SELECT user_id FROM user_projection "
            "WHERE org_id = :org AND active AND user_id = ANY(:ids)"
        ),
        {"org": org_id, "ids": user_ids},
    )
    members = {str(r.user_id) for r in rows}
    # Compared as canonical UUIDs: the request schema accepts any UUID spelling.
    if any(str(uuid.UUID(u)) not in members for u in user_ids):
        raise HTTPException(
            status_code=400,
            detail="every assignee must be an active member of your organisation",
        )


async def _insert_task_assignees(
    db: AsyncSession,
    *,
    org_id: str,
    task_id: str,
    assignee_ids: list[str],
    sender_id: str,
    sender_username: str,
    title: str,
    description: str,
) -> None:
    """Fan a newly-created task out to every assignee in ONE round trip per
    table instead of one INSERT per assignee.

    Both statements below batch every row into a single multi-VALUES INSERT
    (same dynamic-placeholder idiom tasks_read.py already uses for variable-
    length IN-lists) rather than looping a single-row INSERT once per
    assignee. Without this, the "assign to the whole channel" flow turns task
    creation into a transaction whose round-trip count — and lock-hold time —
    scales with channel size; the caller caps `len(assignee_ids)` at
    `MAX_ASSIGNEES` before calling this, so the statement text itself stays
    bounded too.

    The outbox INSERT duplicates the shape of helpers.enqueue_outbox rather
    than calling it in a loop, specifically to get the same one-round-trip
    batching for it — every OTHER call site in this service enqueues exactly
    one event, so that single-row helper stays the right tool for them.
    """
    assignee_params: dict[str, str] = {"tid": task_id, "org": org_id}
    assignee_values: list[str] = []
    outbox_params: dict[str, str] = {"otopic": events.TASK_TOPIC, "okey": task_id}
    outbox_values: list[str] = []

    for i, assignee_id in enumerate(assignee_ids):
        assignee_values.append(f"(:tid, :org, :aid{i}, 'SENT', 0)")
        assignee_params[f"aid{i}"] = assignee_id

        evt = events.task_assigned(
            org_id=org_id,
            task_id=task_id,
            assignee_id=assignee_id,
            sender_id=sender_id,
            status_version=0,
            sender_username=sender_username,
            title=title,
            description=description,
        )
        outbox_values.append(f"(:oid{i}, :otopic, :okey, CAST(:opayload{i} AS jsonb))")
        outbox_params[f"oid{i}"] = str(uuid6.uuid7())
        outbox_params[f"opayload{i}"] = json.dumps(evt)

    await db.execute(
        text(
            "INSERT INTO task_assignees (task_id, org_id, assignee_id, status, status_version) "
            f"VALUES {', '.join(assignee_values)}"
        ),
        assignee_params,
    )
    await db.execute(
        text(
            "INSERT INTO outbox (id, topic, kafka_key, payload) "
            f"VALUES {', '.join(outbox_values)}"
        ),
        outbox_params,
    )


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
        assignee_ids = [
            a
            for a in dict.fromkeys(
                await _resolve_channel_members(channel_id, org_id, sender_id)
            )
        ]
    else:
        # Self-assignment is allowed here, same as it already is via channel
        # mode above when the caller happens to be a member of the target
        # channel: the Acknowledge/Ignore lifecycle (transitions.py) only ever
        # looks up the real sender_id to stamp events with, it never assumes
        # that id differs from the assignee, so a self-assigned task flows
        # through unchanged.
        assignee_ids = [a for a in dict.fromkeys(body.assigneeIds)]
    if not assignee_ids:
        raise HTTPException(status_code=400, detail="at least one assignee required")
    if len(assignee_ids) > MAX_ASSIGNEES:
        # Channel mode is the realistic way to hit this — an explicit
        # assigneeIds list this long is already rejected at the pydantic
        # boundary (schemas.py). Fail clearly here rather than accepting a
        # request whose insert transaction would only time out later.
        raise HTTPException(
            status_code=400,
            detail=(
                f"too many assignees ({len(assignee_ids)}); "
                f"maximum is {MAX_ASSIGNEES} per task"
            ),
        )

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

        # Only a task actually being created gets here (an idempotent replay has
        # already returned), and it runs before encrypt() so a rejected request
        # never creates the org's key.
        if not channel_id:
            await _require_org_members(db, org_id, assignee_ids)

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

        await _insert_task_assignees(
            db,
            org_id=org_id,
            task_id=task_id,
            assignee_ids=assignee_ids,
            sender_id=sender_id,
            sender_username=sender_username,
            title=body.title,
            description=body.description or "",
        )

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

    Emits one `task.deleted` outbox event per deleted assignee (see
    events.task_deleted) so downstream projections that only close on a
    terminal task.* event — sticky-svc's desktop pins, messaging-svc's unified
    inbox — don't go stale forever for a task that was hard-deleted rather
    than carried through the normal lifecycle.

    Titles are stored encrypted (title_enc) under each org's own DEK, with no
    plaintext column and no search index, so matching by title means fetching
    candidate rows and decrypting each with its own org_id before comparing.

    Both branches are capped at _CANDIDATE_LIMIT candidate rows: an org-wide
    delete by title has no bound on how many tasks could match, and a single
    heavy sender's tasks can just as easily approach the size of an entire
    org, so decrypting every candidate on one internal-token call is an
    unbounded-cost query and an unbounded-blast-radius delete either way. A
    caller that hits the cap must narrow further instead of getting a
    silently-truncated delete.
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
            # Capped for the same reason as the unscoped branch below: a
            # heavy sender can have as many tasks as an entire org, and
            # nothing about naming one username bounds the decrypt loop or
            # the delete's blast radius on its own.
            candidates = (
                await db.execute(
                    text(
                        "SELECT t.id, t.org_id, t.title_enc FROM tasks t "
                        "JOIN user_projection u ON t.sender_id = u.user_id "
                        "WHERE u.username = :username AND t.org_id = :org_id "
                        "LIMIT :limit"
                    ),
                    {"username": username, "org_id": org_id, "limit": _CANDIDATE_LIMIT + 1},
                )
            ).all()
            if len(candidates) > _CANDIDATE_LIMIT:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"{username} has more than {_CANDIDATE_LIMIT} tasks in this org; "
                        "narrow further or delete in batches"
                    ),
                )
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

        # RETURNING captures the pre-delete rows so a task.deleted event can be
        # enqueued per surviving assignee below — sticky-svc's pins and
        # messaging-svc's inbox rows otherwise have no terminal event to close
        # on and go stale forever (this endpoint used to just delete rows and
        # tell no one).
        assignee_rows = (
            await db.execute(
                text(
                    "DELETE FROM task_assignees WHERE task_id = ANY(:ids) "
                    "RETURNING task_id, assignee_id, status_version"
                ),
                {"ids": matching_ids},
            )
        ).all()
        assignees_deleted = len(assignee_rows)

        task_rows = (
            await db.execute(
                text("DELETE FROM tasks WHERE id = ANY(:ids) RETURNING id, sender_id"),
                {"ids": matching_ids},
            )
        ).all()
        tasks_deleted = len(task_rows)

        sender_by_task = {str(row.id): str(row.sender_id) for row in task_rows}
        for row in assignee_rows:
            task_id = str(row.task_id)
            evt = events.task_deleted(
                org_id=org_id,
                task_id=task_id,
                assignee_id=str(row.assignee_id),
                sender_id=sender_by_task[task_id],
                status_version=row.status_version + 1,
            )
            await enqueue_outbox(db, events.TASK_TOPIC, task_id, evt)

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
