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

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from crypto import cryptor

from ..auth import Principal, PrincipalDep
from ..db import session, set_org_context
from ..schemas import ProjectDTO
from .projects_read import _can_complete

router = APIRouter()


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
        await db.commit()

        return ProjectDTO(
            id=canonical_id,
            name=name or "",
            channelId=str(project.channel_id),
            status=updated.status,
            canComplete=True,
        )
