from __future__ import annotations

import hashlib
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
from ..allocation import AllocationError, AllocationSelection, derive_title_and_project
from ..auth import Principal, PrincipalDep
from ..config import settings
from crypto import cryptor
from ..db import session, set_org_context
from ..logging_setup import log
from ..projects import (
    ProjectResolution,
    link_channels_to_project,
    resolve_or_create_project,
    sync_assignees_to_project_channel,
)
from ..schemas import CreateTaskRequest, CreateTaskResponse, MAX_ASSIGNEES
from .helpers import enqueue_outbox, resolve_display_name, resolve_username

router = APIRouter()

# Cap on candidate rows considered by the unscoped (no username) branch of
# delete_task_by_title_internal — see its docstring.
_CANDIDATE_LIMIT = 100


def _request_fingerprint(body: CreateTaskRequest) -> str:
    canonical = json.dumps(
        body.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def _resolve_channel_members(
    channel_id: str, org_id: str, caller_id: str
) -> tuple[list[str], str]:
    """Call messaging-svc's internal endpoint to fetch the channel's current
    member ids (and its display name, used to tag channel-sourced
    task.assigned events — see _resolve_recipients). Falls back to an empty
    list (caller decides what to do) on any transport / auth failure — the
    caller's HTTPException converts that into a 400 so the user gets a clean
    error instead of a half-created task.

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
    return list(body.get("memberIds") or []), str(body.get("name") or "")


# assignee_id (canonical UUID) -> (channel_id, channel_name) of the channel
# whose membership resolved them, for assignees reached ONLY via a channel.
ChannelOrigin = dict[str, tuple[str, str]]


async def _resolve_recipients(
    named_ids: list[str], channel_ids: list[str], org_id: str, caller_id: str
) -> tuple[list[str], ChannelOrigin]:
    """Everyone a task goes to: the people named, then the current members of every
    channel named — each person ONCE.

    This is what makes "A, plus #Engineering (which A is in)" one recipient, not
    two. Ids are compared as canonical UUIDs because the two sources spell them
    differently (the request accepts any UUID casing, messaging-svc returns
    lowercase), and task_assignees is keyed (task_id, assignee_id): a duplicate
    would not just double-notify, it would fail the whole INSERT.

    Also returns a channel-origin map (see ChannelOrigin) so the task.assigned
    event for a given assignee can say "you got this via #channel" — used by
    the channel-flavored email variant. Named intent always wins: a person
    named directly is never recorded as channel-sourced even if they also
    happen to be a member of one of the chosen channels. Reached via more than
    one channel, the first one in request order wins (same tie-break already
    used for the legacy single-channel `tasks.channel_id` mirror).
    """
    named_canonical = {str(uuid.UUID(r)) for r in named_ids}
    recipients = list(named_ids)
    channel_origin: ChannelOrigin = {}
    for channel_id in channel_ids:
        member_ids, channel_name = await _resolve_channel_members(channel_id, org_id, caller_id)
        for member_id in member_ids:
            canonical = str(uuid.UUID(member_id))
            if canonical not in named_canonical and canonical not in channel_origin:
                channel_origin[canonical] = (channel_id, channel_name)
        recipients.extend(member_ids)
    deduped = list(dict.fromkeys(str(uuid.UUID(r)) for r in recipients))
    return deduped, channel_origin


async def _insert_task_channels(
    db: AsyncSession, *, org_id: str, task_id: str, channel_ids: list[str]
) -> None:
    """Record the channels a task is allocated to (one row each, one statement).
    No-op for a people-only task. A repeated channel is ignored rather than raised:
    the schedule worker calls this, and a raise there is retried forever."""
    if not channel_ids:
        return
    params: dict[str, str] = {"tid": task_id, "org": org_id}
    values: list[str] = []
    for i, channel_id in enumerate(channel_ids):
        values.append(f"(:tid, :org, :ch{i})")
        params[f"ch{i}"] = channel_id
    await db.execute(
        text(
            f"INSERT INTO task_channels (task_id, org_id, channel_id) VALUES {', '.join(values)} "
            "ON CONFLICT (task_id, channel_id) DO NOTHING"
        ),
        params,
    )


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
    channel_origin: ChannelOrigin | None = None,
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

        origin = (channel_origin or {}).get(assignee_id)
        evt = events.task_assigned(
            org_id=org_id,
            task_id=task_id,
            assignee_id=assignee_id,
            sender_id=sender_id,
            status_version=0,
            sender_username=sender_username,
            title=title,
            description=description,
            channel_id=origin[0] if origin else None,
            channel_name=origin[1] if origin else None,
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


async def _insert_schedule(
    db: AsyncSession,
    *,
    schedule_id: str,
    project_id: str,
    org_id: str,
    sender_id: str,
    title_enc: bytes,
    description_enc: bytes,
    channel_ids: list[str],
    assignee_ids: list[str],
    body: CreateTaskRequest,
) -> None:
    recurrence = body.recurrence
    start_at = body.scheduledFor if body.allocation == "SCHEDULED" else recurrence.startAt  # type: ignore[union-attr]
    # A scheduled task carries one absolute deadline; a recurring series carries the
    # RULE its occurrences' deadlines are resolved from (app/deadlines.py).
    rule = recurrence.deadline if recurrence else None
    await db.execute(
        text(
            "INSERT INTO task_schedules ("
            "id, org_id, sender_id, title_enc, description_enc, channel_id, channel_ids, assignee_ids, "
            "project_id, kind, scheduled_for, start_at, frequency, frequency_interval, weekdays, "
            "monthly_rule, monthly_day, monthly_ordinal, monthly_weekday, end_condition, "
            "end_at, occurrence_limit, next_run_at, "
            "deadline_at, deadline_kind, deadline_amount, deadline_unit, deadline_time, deadline_tz"
            ") VALUES ("
            ":id, :org, :sender, :title, :description, :channel, CAST(:channels AS uuid[]), "
            "CAST(:assignees AS uuid[]), :project_id, "
            ":kind, :scheduled, :start, :frequency, :interval, :weekdays, :monthly_rule, "
            ":monthly_day, :monthly_ordinal, :monthly_weekday, :end_condition, :end_at, "
            ":occurrence_limit, :next_run, "
            ":deadline_at, :deadline_kind, :deadline_amount, :deadline_unit, :deadline_time, :deadline_tz"
            ")"
        ),
        {
            "id": schedule_id,
            "org": org_id,
            "sender": sender_id,
            "title": title_enc,
            "description": description_enc,
            "project_id": project_id,
            # channel_id is the legacy single-channel column (see 012): the first one.
            "channel": channel_ids[0] if channel_ids else None,
            "channels": channel_ids,
            "assignees": assignee_ids,
            "kind": body.allocation,
            "scheduled": body.scheduledFor,
            "start": start_at,
            "frequency": recurrence.frequency if recurrence else None,
            "interval": recurrence.interval if recurrence else None,
            "weekdays": recurrence.weekdays if recurrence else [],
            "monthly_rule": recurrence.monthlyRule if recurrence else None,
            "monthly_day": recurrence.monthlyDay if recurrence else None,
            "monthly_ordinal": recurrence.monthlyOrdinal if recurrence else None,
            "monthly_weekday": recurrence.monthlyWeekday if recurrence else None,
            "end_condition": recurrence.endCondition if recurrence else "NO_END",
            "end_at": recurrence.endAt if recurrence else None,
            "occurrence_limit": recurrence.occurrenceCount if recurrence else None,
            "next_run": start_at,
            "deadline_at": body.deadlineAt,
            "deadline_kind": rule.kind if rule else None,
            "deadline_amount": rule.amount if rule else None,
            "deadline_unit": rule.unit if rule else None,
            "deadline_time": rule.time_of_day() if rule and rule.kind == "FIXED_TIME" else None,
            "deadline_tz": rule.timeZone if rule else None,
        },
    )


async def _resolve_derived_title_and_project(
    db: AsyncSession,
    body: CreateTaskRequest,
    org_id: str,
    sender_id: str,
    channel_ids: list[str],
    named_ids: list[str],
) -> tuple[str, ProjectResolution | None]:
    """Smart Task Allocation (Section 8): decide the task's title, and which
    project (if any) it is filed under, from projectId/newProjectName plus
    the channel/people selection. Only called when the client omitted
    taskTitle — see CreateTaskRequest._validate_title_mode.

    Names are only fetched for the two single-item rules (A and C/D) that
    actually read a name; the multi-item and explicit-project rules only
    need counts, so a real lookup there would be wasted work.
    """
    channel_count = len(channel_ids)
    person_count = len(named_ids)

    existing_project_row = None
    existing_project_name: str | None = None
    if body.projectId:
        try:
            canonical_project_id = str(uuid.UUID(body.projectId))
        except ValueError as exc:
            raise HTTPException(status_code=404, detail="project not found") from exc
        existing_project_row = (
            await db.execute(
                text(
                    "SELECT id, name_enc, channel_id FROM projects "
                    "WHERE id = :id AND org_id = :org AND channel_id IS NOT NULL"
                ),
                {"id": canonical_project_id, "org": org_id},
            )
        ).first()
        if existing_project_row is None:
            raise HTTPException(status_code=404, detail="project not found")
        existing_project_name = await cryptor().decrypt(db, org_id, existing_project_row.name_enc)

    channel_names = [""] * channel_count
    if channel_count == 1 and person_count == 0 and existing_project_row is None:
        _, name = await _resolve_channel_members(channel_ids[0], org_id, sender_id)
        if not name:
            raise HTTPException(status_code=404, detail="channel not found")
        channel_names = [name]

    person_names = [""] * person_count
    if person_count == 1 and channel_count == 0 and existing_project_row is None:
        name = await resolve_display_name(db, org_id, named_ids[0])
        if not name:
            raise HTTPException(status_code=400, detail="assignee not found")
        person_names = [name]

    try:
        derived = derive_title_and_project(
            AllocationSelection(
                channel_names=channel_names,
                person_names=person_names,
                existing_project_id=str(existing_project_row.id) if existing_project_row else None,
                existing_project_name=existing_project_name,
                new_project_name=body.newProjectName,
            )
        )
    except AllocationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if derived.existing_project_id:
        return derived.title, ProjectResolution(
            str(existing_project_row.id),
            derived.title,
            str(existing_project_row.channel_id),
            False,
        )
    if derived.new_project_name:
        project = await resolve_or_create_project(org_id, sender_id, derived.new_project_name)
        # Rule B/E/G/H: make the merge real — every channel in the selection
        # that produced this new/resolved project gets linked into it, not
        # just its own auto-created channel. Uses the caller's own session
        # (org context already bound), separate from resolve_or_create_project's
        # own internal transaction above.
        await link_channels_to_project(db, org_id, project.project_id, channel_ids, sender_id)
        return project.name, project
    return derived.title, None


@router.post("/tasks", response_model=CreateTaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task(
    body: CreateTaskRequest,
    principal: Principal = PrincipalDep,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> CreateTaskResponse:
    org_id = principal.org_id
    sender_id = principal.user_id
    request_fingerprint = _request_fingerprint(body)

    # Allocation surface: explicit people, channels, or both — ONE task either way.
    # Each channel's current members are resolved server-side so the client can't
    # lie about the recipient list, and the channels stay attached to the task
    # (task_channels) so future joiners can be auto-fanned via the
    # ChannelMemberJoined consumer.
    #
    # Self-assignment is allowed, same as it is via a channel the caller is a
    # member of: the Acknowledge/Ignore lifecycle (transitions.py) only ever looks
    # up the real sender_id to stamp events with, it never assumes that id differs
    # from the assignee, so a self-assigned task flows through unchanged.
    named_ids = list(dict.fromkeys(str(uuid.UUID(a)) for a in body.assigneeIds))
    channel_ids = body.target_channel_ids()
    if not named_ids and not channel_ids and not body.projectId:
        raise HTTPException(status_code=400, detail="at least one assignee required")

    # Legacy mode (taskTitle given): resolve/create the project named by
    # `title` up front, exactly as before, and its auto-created channel is
    # never itself a recipient (see comment below). Derived mode (Smart Task
    # Allocation) resolves its title/project later, inside the DB session
    # where display-name lookups need org context — and never excludes a
    # channel this way, since every channel in a derived request is one the
    # user actually picked as a target (Section 7.1/7.3).
    project: ProjectResolution | None = None
    if body.taskTitle is not None:
        project = await resolve_or_create_project(org_id, sender_id, body.title)
        # The project channel is attached to the task but is not an assignment
        # target: its existing members may have been assigned to other project
        # tasks and must not be added to this task implicitly.
        recipient_channel_ids = [channel_id for channel_id in channel_ids if channel_id != project.channel_id]
    else:
        recipient_channel_ids = channel_ids

    assignee_ids, channel_origin = await _resolve_recipients(
        named_ids, recipient_channel_ids, org_id, sender_id
    )
    if not assignee_ids:
        # Only channels, and they are all empty.
        raise HTTPException(status_code=400, detail="at least one assignee required")
    if len(assignee_ids) > MAX_ASSIGNEES:
        # Channels are the realistic way to hit this — an explicit assigneeIds list
        # this long is already rejected at the pydantic boundary (schemas.py), and
        # the union of several channels is bounded by nothing else. Fail clearly
        # here rather than accepting a request whose insert transaction would only
        # time out later.
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
        # We INSERT the (org, sender, key) → task_id row up front; the unique
        # constraint means a concurrent (or replayed) request loses here, and
        # we then resolve + return the WINNING task instead of creating a
        # second one. The whole claim+inserts run in one transaction so a
        # failure after the claim rolls the key back too.
        if idempotency_key:
            try:
                await db.execute(
                    text(
                        "INSERT INTO idempotency_keys "
                        "(org_id, sender_id, key, request_fingerprint, task_id) "
                        "VALUES (:org, :sender, :key, :fingerprint, :tid)"
                    ),
                    {
                        "org": org_id,
                        "sender": sender_id,
                        "key": idempotency_key,
                        "fingerprint": request_fingerprint,
                        "tid": task_id,
                    },
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
                            "SELECT task_id, request_fingerprint FROM idempotency_keys "
                            "WHERE org_id = :org AND sender_id = :sender AND key = :key"
                        ),
                        {"org": org_id, "sender": sender_id, "key": idempotency_key},
                    )
                ).first()
                if existing and existing.request_fingerprint == request_fingerprint:
                    return CreateTaskResponse(taskId=str(existing.task_id))
                if existing:
                    raise HTTPException(
                        status_code=409,
                        detail="idempotency key was already used for a different request",
                    )
                legacy_collision = (
                    await db.execute(
                        text(
                            "SELECT 1 FROM idempotency_keys "
                            "WHERE org_id = :org AND key = :key"
                        ),
                        {"org": org_id, "key": idempotency_key},
                    )
                ).first()
                if legacy_collision:
                    # During the rollback window, old app versions may create
                    # rows without sender/fingerprint metadata. Do not return a
                    # task through that unbound key; ask the caller for a new one.
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            "idempotency key is unavailable during the "
                            "compatibility window; retry with a new key"
                        ),
                    )
                raise

        sender_username = await resolve_username(db, org_id, sender_id) or principal.username

        # Only a task actually being created gets here (an idempotent replay has
        # already returned), and it runs before encrypt() so a rejected request
        # never creates the org's key.
        # Only the people the CLIENT named are checked; channel members were
        # resolved within the org by messaging-svc.
        if named_ids:
            await _require_org_members(db, org_id, named_ids)

        if body.taskTitle is not None:
            final_title = body.taskTitle
        else:
            # Smart Task Allocation: derive the title (and resolve/create the
            # project, if any) now that org context is bound for the
            # display-name and project lookups it needs.
            final_title, project = await _resolve_derived_title_and_project(
                db, body, org_id, sender_id, channel_ids, named_ids
            )

        # Encrypt PII (title/description) at rest under the org's DEK. The DEK is
        # created lazily inside THIS write transaction on first use for the org.
        # The Kafka event below still carries plaintext (the relay + messaging
        # projection need it) — we keep the plaintext in-memory and only store
        # ciphertext.
        title_enc = await cryptor().encrypt(db, org_id, final_title)
        desc_enc = await cryptor().encrypt(db, org_id, body.description or "")

        if body.allocation != "NOW":
            # A deferred task stores the same assignment target, but does not
            # create task_assignees or emit task.assigned until the worker sees
            # next_run_at. The named people are stored as given; channel membership
            # is resolved again at that point.
            await _insert_schedule(
                db,
                schedule_id=task_id,
                org_id=org_id,
                sender_id=sender_id,
                title_enc=title_enc,
                description_enc=desc_enc,
                channel_ids=recipient_channel_ids,
                assignee_ids=named_ids,
                project_id=project.project_id if project else None,
                body=body,
            )
            await db.commit()
            log.info("task_schedule_created", schedule_id=task_id, kind=body.allocation)
            return CreateTaskResponse(taskId=task_id, scheduleId=task_id)

        await db.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc, channel_id, "
                "deadline_at, project_id) "
                "VALUES (:id, :org, :sender, :title_enc, :desc_enc, :ch, :deadline, :project)"
            ),
            {
                "deadline": body.deadlineAt,
                "id": task_id,
                "org": org_id,
                "sender": sender_id,
                "title_enc": title_enc,
                "desc_enc": desc_enc,
                # Legacy single-channel column (see 012) mirrors only an actual
                # assignment channel; the project channel is linked by project_id.
                "ch": recipient_channel_ids[0] if recipient_channel_ids else None,
                "project": project.project_id if project else None,
            },
        )
        # task_channels represents assignment targets. Its member-joined
        # consumer fans new channel members into every active task, so the
        # project channel belongs only in projects.channel_id, not this table.
        channels_to_attach = recipient_channel_ids
        await _insert_task_channels(
            db, org_id=org_id, task_id=task_id, channel_ids=channels_to_attach
        )

        await _insert_task_assignees(
            db,
            org_id=org_id,
            task_id=task_id,
            assignee_ids=assignee_ids,
            sender_id=sender_id,
            sender_username=sender_username,
            title=final_title,
            description=body.description or "",
            channel_origin=channel_origin,
        )

        if body.allocation == "NOW" and project is not None:
            await sync_assignees_to_project_channel(
                org_id, project.channel_id, sender_id, assignee_ids
            )
        await db.commit()
        log.info(
            "task_created",
            task_id=task_id,
            assignees=len(assignee_ids),
            channel_ids=channels_to_attach,
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
