"""`POST /projects/{id}/complete` — mark a project COMPLETED once every task
filed under it is done.

Only the project's creator or an org_admin may complete it (see Principal.roles,
minted into the JWT by auth-svc — the same role gate require_org_admin uses).
Unlike the read routes in projects_read.py, this is NOT gated on
_AUTHORIZED_PROJECT (sender/assignee of a task or schedule in the project): an
org_admin completing a project they are not personally working in is exactly
the case that rule would wrongly exclude.

"Every task done" reuses the same per-task completed/abandoned/remaining rule
project_analytics (tasks_analytics.py) computes — a task counts only when it
is COMPLETED, never ABANDONED (every assignee left/ignored it is not "done",
it's unresolved work nobody is doing).
"""

from __future__ import annotations

import uuid

import uuid6
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from crypto import cryptor

from ..auth import Principal, PrincipalDep
from ..db import session, set_org_context
from ..projects import fetch_channel_members, normalize_project_name, project_name_hash
from ..schemas import CreateProjectRequest, ProjectDTO
from .projects_read import _can_complete, _channel_ids

router = APIRouter()


class LinkProjectChannelRequest(BaseModel):
    channelId: str = Field(min_length=1, max_length=64)


@router.post("/projects/{project_id}/complete", response_model=ProjectDTO)
async def complete_project(project_id: str, principal: Principal = PrincipalDep) -> ProjectDTO:
    org_id, me = principal.org_id, principal.user_id
    try:
        canonical_id = str(uuid.UUID(project_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="project not found") from exc

    async with session() as db:
        # RLS: bind org context before any statement.
        await set_org_context(db, org_id)

        # Locked so a double-click (or two devices) can't both pass the
        # completion check and race the UPDATE below.
        project = (
            await db.execute(
                text(
                    "SELECT id, name_enc, channel_id, created_by, status FROM projects "
                    "WHERE id = :id AND org_id = :org AND channel_id IS NOT NULL "
                    "FOR UPDATE"
                ),
                {"id": canonical_id, "org": org_id},
            )
        ).first()
        if project is None:
            raise HTTPException(status_code=404, detail="project not found")
        if not _can_complete(project, me, principal.roles):
            raise HTTPException(
                status_code=403,
                detail="only the project owner or an org admin can complete this project",
            )
        if project.status == "COMPLETED":
            raise HTTPException(status_code=409, detail="project is already completed")

        # Per-task completion rule, computed in SQL — the same one
        # project_analytics uses for its aggregate completion metrics, here
        # collapsed to just the two booleans this route needs.
        counts = (
            await db.execute(
                text(
                    "SELECT COUNT(*) AS total, "
                    "       COUNT(*) FILTER (WHERE remaining = 0) AS abandoned, "
                    "       COUNT(*) FILTER (WHERE remaining > 0 AND remaining_incomplete > 0) AS incomplete "
                    "FROM ("
                    "    SELECT t.id, "
                    "           COUNT(*) FILTER (WHERE ta.status NOT IN ('LEFT','IGNORED')) AS remaining, "
                    "           COUNT(*) FILTER ("
                    "               WHERE ta.status NOT IN ('LEFT','IGNORED') AND ta.status <> 'COMPLETED'"
                    "           ) AS remaining_incomplete "
                    "    FROM tasks t "
                    "    JOIN task_assignees ta ON ta.task_id = t.id AND ta.org_id = t.org_id "
                    "    WHERE t.org_id = :org AND t.project_id = :pid "
                    "    GROUP BY t.id"
                    ") per_task"
                ),
                {"org": org_id, "pid": canonical_id},
            )
        ).first()
        if counts.total == 0:
            raise HTTPException(status_code=409, detail="project has no tasks")
        if counts.abandoned > 0 or counts.incomplete > 0:
            raise HTTPException(status_code=409, detail="project has tasks that are not completed")

        name = await cryptor().decrypt(db, org_id, project.name_enc)

        updated = (
            await db.execute(
                text(
                    "UPDATE projects SET status = 'COMPLETED', completed_at = now(), completed_by = :me "
                    "WHERE id = :id AND org_id = :org AND status = 'ACTIVE' "
                    "RETURNING status"
                ),
                {"id": canonical_id, "org": org_id, "me": me},
            )
        ).first()
        if updated is None:
            # Lost the race to another request between the check above and here.
            raise HTTPException(status_code=409, detail="project is already completed")
        # Read channelIds before commit: set_org_context's app.org_id GUC is
        # transaction-scoped (SET LOCAL), so a query issued after commit runs
        # outside any org context and RLS silently returns zero rows.
        channel_ids = await _channel_ids(db, org_id, canonical_id)
        await db.commit()

        return ProjectDTO(
            id=canonical_id,
            name=name or "",
            channelId=str(project.channel_id),
            channelIds=channel_ids,
            status=updated.status,
            canComplete=True,
        )


@router.post("/projects/{project_id}/channels", response_model=ProjectDTO)
async def link_project_channel(
    project_id: str,
    body: LinkProjectChannelRequest,
    principal: Principal = PrincipalDep,
) -> ProjectDTO:
    """Add an existing channel to a project (Section 5/9 of the allocation
    spec: a project groups channels, it does not have to create new ones).

    Only the project's creator or an org_admin may change its channel set —
    same gate as complete_project. The channel itself must belong to this org,
    the caller must be a member of it (fetch_channel_members enforces both via
    messaging-svc), and it must have at least 2 members: a channel with only
    its creator isn't yet a real group to allocate work through.
    """
    org_id, me = principal.org_id, principal.user_id
    try:
        canonical_project_id = str(uuid.UUID(project_id))
        canonical_channel_id = str(uuid.UUID(body.channelId))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="project not found") from exc

    async with session() as db:
        await set_org_context(db, org_id)
        project = (
            await db.execute(
                text(
                    "SELECT id, name_enc, channel_id, created_by, status FROM projects "
                    "WHERE id = :id AND org_id = :org AND channel_id IS NOT NULL"
                ),
                {"id": canonical_project_id, "org": org_id},
            )
        ).first()
        if project is None:
            raise HTTPException(status_code=404, detail="project not found")
        if not _can_complete(project, me, principal.roles):
            raise HTTPException(
                status_code=403,
                detail="only the project owner or an org admin can change its channels",
            )

        member_ids = await fetch_channel_members(canonical_channel_id, org_id, me)
        if len(member_ids) < 2:
            raise HTTPException(
                status_code=400,
                detail="a channel needs at least 2 members to be added to a project",
            )

        await db.execute(
            text(
                "INSERT INTO project_channels (project_id, org_id, channel_id) "
                "VALUES (:pid, :org, :cid) ON CONFLICT DO NOTHING"
            ),
            {"pid": canonical_project_id, "org": org_id, "cid": canonical_channel_id},
        )
        name = await cryptor().decrypt(db, org_id, project.name_enc)
        channel_ids = await _channel_ids(db, org_id, canonical_project_id)
        await db.commit()

        return ProjectDTO(
            id=canonical_project_id,
            name=name or "",
            channelId=str(project.channel_id),
            channelIds=channel_ids,
            status=project.status,
            canComplete=_can_complete(project, me, principal.roles),
        )


@router.post("/projects", response_model=ProjectDTO, status_code=201)
async def create_project(body: CreateProjectRequest, principal: Principal = PrincipalDep) -> ProjectDTO:
    """Standalone project creation (Section 6.4) — a project made on its own,
    not implicitly through a task's title/newProjectName. Every channel named
    must already have >=2 real members, checked up front so the whole request
    fails loudly on an ineligible pick rather than silently dropping it (the
    behavior task-creation's link_channels_to_project uses instead, where
    there is a task to fall back to — there is none here).

    A project needs at least one channel (schema-enforced): the first becomes
    `channelId`, the legacy primary column every existing reader expects
    non-null; all of them, including that one, are linked via project_channels.
    """
    org_id, me = principal.org_id, principal.user_id
    channel_ids = list(dict.fromkeys(str(uuid.UUID(c)) for c in body.channelIds))
    for channel_id in channel_ids:
        member_ids = await fetch_channel_members(channel_id, org_id, me)
        if len(member_ids) < 2:
            raise HTTPException(
                status_code=400,
                detail=f"channel {channel_id} needs at least 2 members to be part of a project",
            )

    name = normalize_project_name(body.name)
    name_hash = project_name_hash(name)
    project_id = str(uuid6.uuid7())

    async with session() as db:
        await set_org_context(db, org_id)
        name_enc = await cryptor().encrypt(db, org_id, name)
        try:
            await db.execute(
                text(
                    "INSERT INTO projects (id, org_id, name_enc, name_hash, channel_id, created_by) "
                    "VALUES (:id, :org, :name_enc, :name_hash, :channel, :creator)"
                ),
                {
                    "id": project_id,
                    "org": org_id,
                    "name_enc": name_enc,
                    "name_hash": name_hash,
                    "channel": channel_ids[0],
                    "creator": me,
                },
            )
        except IntegrityError:
            # Same name already exists for this org — a double-click/retry of
            # this exact request, or a genuine name collision; either way,
            # return the project that already won rather than erroring, same
            # philosophy as resolve_or_create_project's own race handling.
            await db.rollback()
            await set_org_context(db, org_id)
            existing = (
                await db.execute(
                    text(
                        "SELECT id, name_enc, channel_id, created_by, status FROM projects "
                        "WHERE org_id = :org AND name_hash = :name_hash"
                    ),
                    {"org": org_id, "name_hash": name_hash},
                )
            ).first()
            if existing is None:
                raise
            existing_name = await cryptor().decrypt(db, org_id, existing.name_enc)
            existing_channel_ids = await _channel_ids(db, org_id, str(existing.id))
            await db.commit()
            return ProjectDTO(
                id=str(existing.id),
                name=existing_name or name,
                channelId=str(existing.channel_id),
                channelIds=existing_channel_ids,
                status=existing.status,
                canComplete=_can_complete(existing, me, principal.roles),
            )

        for channel_id in channel_ids:
            await db.execute(
                text(
                    "INSERT INTO project_channels (project_id, org_id, channel_id) "
                    "VALUES (:pid, :org, :cid) ON CONFLICT DO NOTHING"
                ),
                {"pid": project_id, "org": org_id, "cid": channel_id},
            )
        await db.commit()

        return ProjectDTO(
            id=project_id,
            name=name,
            channelId=channel_ids[0],
            channelIds=channel_ids,
            status="ACTIVE",
            canComplete=True,
        )
