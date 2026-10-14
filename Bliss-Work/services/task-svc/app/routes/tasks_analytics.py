from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text

from ..auth import OrgAdminDep, Principal, PrincipalDep
from crypto import cryptor
from ..db import session, set_org_context
from ..schemas import (
    AssigneeWorkloadDTO,
    ChannelAnalyticsDTO,
    ChannelPerformanceDTO,
    CompletionMetricsDTO,
    DailyActivityPointDTO,
    ProjectAnalyticsDTO,
    ProjectTaskAssigneeDTO,
    ProjectTaskStatus,
    ProjectTaskSummaryDTO,
    StatusBreakdownDTO,
    TaskAnalyticsAssigneeDTO,
    TaskAnalyticsDTO,
    WorkloadBreakdownDTO,
    WorkspaceOverviewDTO,
)
from .helpers import iso
from .projects_read import _AUTHORIZED_PROJECT
from .tasks_write import _resolve_channel_members

router = APIRouter()

_DEFAULT_TASKS_LIMIT = 20
_MAX_TASKS_LIMIT = 100
_DEFAULT_OVERVIEW_DAYS = 30
_MAX_OVERVIEW_RANGE_DAYS = 400
_OVERVIEW_CHANNELS_LIMIT = 10
_OVERVIEW_WORKLOAD_LIMIT = 20

# Rows never left/ignored their assignment — the ones that can still make a
# task "complete". See the module docstring in schemas.py for the full rule.
_REMAINING_STATUSES = ("SENT", "ACKNOWLEDGED", "COMPLETED", "MISSED")


def _unique_task_completion(total_unique: int, completed_unique: int, abandoned_unique: int) -> float:
    return (completed_unique / total_unique * 100) if total_unique else 0.0


def _rate(numerator: int, denominator: int) -> float:
    return (numerator / denominator * 100) if denominator else 0.0


@router.get("/tasks/{task_id}/analytics", response_model=TaskAnalyticsDTO)
async def task_analytics(task_id: str, principal: Principal = PrincipalDep) -> TaskAnalyticsDTO:
    """Snapshot analytics for one task: per-assignee timeline, status breakdown,
    and the two completion metrics (see schemas.py) applied to this single task.

    Visible to the task's sender (allocator) or any of its assignees — the same
    two parties /tasks/sent and /tasks/{id}/detail already expose this task to.
    No new visibility rule is introduced.
    """
    org_id, me = principal.org_id, principal.user_id
    async with session() as db:
        # RLS: bind org context before any statement.
        await set_org_context(db, org_id)

        task_row = (
            await db.execute(
                text("SELECT title_enc, sender_id FROM tasks WHERE id = :tid AND org_id = :org"),
                {"tid": task_id, "org": org_id},
            )
        ).first()
        if task_row is None:
            raise HTTPException(status_code=404, detail="task not found")
        sender_id = str(task_row.sender_id)

        rows = (
            await db.execute(
                text(
                    "SELECT ta.assignee_id, ta.status, ta.assigned_at, ta.acknowledged_at, "
                    "       ta.completed_at, ta.ignored_at, ta.left_at, ta.missed_at, "
                    "       COALESCE(up.username, '') AS assignee_username "
                    "FROM task_assignees ta "
                    "LEFT JOIN user_projection up "
                    "       ON up.user_id = ta.assignee_id AND up.org_id = ta.org_id "
                    "WHERE ta.org_id = :org AND ta.task_id = :tid "
                    "ORDER BY ta.assigned_at, ta.assignee_id"
                ),
                {"org": org_id, "tid": task_id},
            )
        ).all()
        if not rows:
            raise HTTPException(status_code=404, detail="task not found")
        if sender_id != me and not any(str(r.assignee_id) == me for r in rows):
            # Don't disclose existence to someone who is neither party.
            raise HTTPException(status_code=404, detail="task not found")

        title = await cryptor().decrypt(db, org_id, task_row.title_enc) or ""

    breakdown = StatusBreakdownDTO()
    assignees: list[TaskAnalyticsAssigneeDTO] = []
    completed_rows = 0
    remaining_rows = 0
    remaining_incomplete = 0
    for r in rows:
        field = r.status.lower()
        setattr(breakdown, field, getattr(breakdown, field) + 1)
        if r.status == "COMPLETED":
            completed_rows += 1
        if r.status in _REMAINING_STATUSES:
            remaining_rows += 1
            if r.status != "COMPLETED":
                remaining_incomplete += 1

        turnaround = None
        if r.status == "COMPLETED" and r.assigned_at is not None and r.completed_at is not None:
            turnaround = (r.completed_at - r.assigned_at).total_seconds()

        assignees.append(
            TaskAnalyticsAssigneeDTO(
                assigneeId=str(r.assignee_id),
                assigneeUsername=r.assignee_username,
                status=r.status,
                assignedAt=iso(r.assigned_at),
                acknowledgedAt=iso(r.acknowledged_at),
                completedAt=iso(r.completed_at),
                ignoredAt=iso(r.ignored_at),
                leftAt=iso(r.left_at),
                missedAt=iso(r.missed_at),
                turnaroundSeconds=turnaround,
            )
        )

    total = len(rows)
    is_completed_task = remaining_rows > 0 and remaining_incomplete == 0
    is_abandoned_task = remaining_rows == 0

    completion = CompletionMetricsDTO(
        totalAssignments=total,
        completedAssignments=completed_rows,
        assignmentCompletionRate=_rate(completed_rows, total),
        totalUniqueTasks=1,
        completedUniqueTasks=1 if is_completed_task else 0,
        abandonedUniqueTasks=1 if is_abandoned_task else 0,
        remainingUniqueTasks=0 if (is_completed_task or is_abandoned_task) else 1,
        uniqueTaskCompletionRate=100.0 if is_completed_task else 0.0,
    )

    return TaskAnalyticsDTO(
        taskId=task_id,
        title=title,
        senderId=sender_id,
        assignees=assignees,
        statusBreakdown=breakdown,
        completion=completion,
    )


@router.get("/tasks/channels/{channel_id}/analytics", response_model=ChannelAnalyticsDTO)
async def channel_analytics(channel_id: str, principal: Principal = PrincipalDep) -> ChannelAnalyticsDTO:
    """Snapshot analytics across every task attached to a channel (task_channels),
    joined to each task's assignee rows.

    task-svc has no channel_members table of its own, so authorization reuses
    the exact same messaging-svc membership check task creation already relies
    on (_resolve_channel_members in tasks_write.py) — a non-member, or a
    channel belonging to another org, gets the same 404 that check already
    raises. The call's member list itself is discarded; only its authorization
    side effect is used here.
    """
    org_id, me = principal.org_id, principal.user_id
    await _resolve_channel_members(channel_id, org_id, me)

    async with session() as db:
        # RLS: bind org context before any statement.
        await set_org_context(db, org_id)

        status_rows = (
            await db.execute(
                text(
                    "SELECT ta.status, COUNT(*) AS n "
                    "FROM task_channels tc "
                    "JOIN task_assignees ta ON ta.task_id = tc.task_id AND ta.org_id = tc.org_id "
                    "WHERE tc.org_id = :org AND tc.channel_id = :ch "
                    "GROUP BY ta.status"
                ),
                {"org": org_id, "ch": channel_id},
            )
        ).all()

        # Per-task completion rule, computed in SQL (not row-by-row in Python):
        # for every task attached to this channel, how many of its assignee
        # rows are still "remaining" (not LEFT/IGNORED), and of those, how many
        # are not yet COMPLETED.
        per_task_rows = (
            await db.execute(
                text(
                    "SELECT ta.task_id, "
                    "       COUNT(*) FILTER (WHERE ta.status NOT IN ('LEFT','IGNORED')) AS remaining, "
                    "       COUNT(*) FILTER ("
                    "           WHERE ta.status NOT IN ('LEFT','IGNORED') AND ta.status <> 'COMPLETED'"
                    "       ) AS remaining_incomplete "
                    "FROM task_channels tc "
                    "JOIN task_assignees ta ON ta.task_id = tc.task_id AND ta.org_id = tc.org_id "
                    "WHERE tc.org_id = :org AND tc.channel_id = :ch "
                    "GROUP BY ta.task_id"
                ),
                {"org": org_id, "ch": channel_id},
            )
        ).all()

        workload_rows = (
            await db.execute(
                text(
                    "SELECT ta.assignee_id, COALESCE(up.username, '') AS username, "
                    "       COUNT(*) AS assigned, "
                    "       COUNT(*) FILTER (WHERE ta.status = 'COMPLETED') AS completed "
                    "FROM task_channels tc "
                    "JOIN task_assignees ta ON ta.task_id = tc.task_id AND ta.org_id = tc.org_id "
                    "LEFT JOIN user_projection up "
                    "       ON up.user_id = ta.assignee_id AND up.org_id = ta.org_id "
                    "WHERE tc.org_id = :org AND tc.channel_id = :ch "
                    "GROUP BY ta.assignee_id, up.username "
                    "ORDER BY assigned DESC, ta.assignee_id"
                ),
                {"org": org_id, "ch": channel_id},
            )
        ).all()

    breakdown = StatusBreakdownDTO()
    total_assignments = 0
    completed_assignments = 0
    for r in status_rows:
        total_assignments += r.n
        if r.status == "COMPLETED":
            completed_assignments = r.n
        setattr(breakdown, r.status.lower(), r.n)

    total_unique = len(per_task_rows)
    completed_unique = sum(1 for r in per_task_rows if r.remaining > 0 and r.remaining_incomplete == 0)
    abandoned_unique = sum(1 for r in per_task_rows if r.remaining == 0)
    remaining_unique = total_unique - completed_unique - abandoned_unique

    completion = CompletionMetricsDTO(
        totalAssignments=total_assignments,
        completedAssignments=completed_assignments,
        assignmentCompletionRate=_rate(completed_assignments, total_assignments),
        totalUniqueTasks=total_unique,
        completedUniqueTasks=completed_unique,
        abandonedUniqueTasks=abandoned_unique,
        remainingUniqueTasks=remaining_unique,
        uniqueTaskCompletionRate=_unique_task_completion(total_unique, completed_unique, abandoned_unique),
    )

    workload = [
        AssigneeWorkloadDTO(
            assigneeId=str(r.assignee_id),
            assigneeUsername=r.username,
            assignedCount=r.assigned,
            completedCount=r.completed,
            completionRate=_rate(r.completed, r.assigned),
        )
        for r in workload_rows
    ]

    return ChannelAnalyticsDTO(
        channelId=channel_id,
        statusBreakdown=breakdown,
        completion=completion,
        workload=workload,
    )


@router.get("/tasks/projects/{project_id}/analytics", response_model=ProjectAnalyticsDTO)
async def project_analytics(
    project_id: str,
    principal: Principal = PrincipalDep,
    limit: int = Query(default=_DEFAULT_TASKS_LIMIT, ge=1, le=_MAX_TASKS_LIMIT),
    offset: int = Query(default=0, ge=0),
) -> ProjectAnalyticsDTO:
    """Snapshot analytics across every task in a project (tasks.project_id),
    joined to task_assignees. A task belongs to at most one project (a plain
    FK, no join-table fan-out on that side), so the only double-counting risk
    is the usual one-task/many-assignees join already solved below with
    GROUP BY task_id — the exact pattern channel_analytics uses above.

    Authorization reuses _AUTHORIZED_PROJECT from projects_read.py: visible to
    anyone who is the sender or an assignee of at least one task (or
    schedule) in the project — the same rule GET /projects/{id} already
    enforces. A project that doesn't exist, isn't yet channel-ready, or the
    caller cannot see all 404 alike, so existence is never disclosed.

    `tasks` (the per-task breakdown: title, sender, deadline, assignees) is
    paginated via limit/offset; every other field is computed over the WHOLE
    project so a partial page never skews the aggregate metrics.
    """
    org_id, me = principal.org_id, principal.user_id
    try:
        canonical_id = str(uuid.UUID(project_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="project not found") from exc

    async with session() as db:
        # RLS: bind org context before any statement.
        await set_org_context(db, org_id)

        project_row = (
            await db.execute(
                text(
                    "SELECT p.id FROM projects p "
                    "WHERE p.id = :id AND p.org_id = :org AND p.channel_id IS NOT NULL AND "
                    + _AUTHORIZED_PROJECT
                ),
                {"id": canonical_id, "org": org_id, "me": me},
            )
        ).first()
        if project_row is None:
            raise HTTPException(status_code=404, detail="project not found")

        status_rows = (
            await db.execute(
                text(
                    "SELECT ta.status, COUNT(*) AS n "
                    "FROM tasks t "
                    "JOIN task_assignees ta ON ta.task_id = t.id AND ta.org_id = t.org_id "
                    "WHERE t.org_id = :org AND t.project_id = :pid "
                    "GROUP BY ta.status"
                ),
                {"org": org_id, "pid": canonical_id},
            )
        ).all()

        # Per-task completion rule, computed in SQL: for every task in this
        # project, how many of its assignee rows are still "remaining" (not
        # LEFT/IGNORED), how many of those are not yet COMPLETED, and how many
        # are MISSED (this task's overdue signal).
        per_task_rows = (
            await db.execute(
                text(
                    "SELECT ta.task_id, "
                    "       COUNT(*) FILTER (WHERE ta.status NOT IN ('LEFT','IGNORED')) AS remaining, "
                    "       COUNT(*) FILTER ("
                    "           WHERE ta.status NOT IN ('LEFT','IGNORED') AND ta.status <> 'COMPLETED'"
                    "       ) AS remaining_incomplete, "
                    "       COUNT(*) FILTER (WHERE ta.status = 'MISSED') AS missed_count "
                    "FROM tasks t "
                    "JOIN task_assignees ta ON ta.task_id = t.id AND ta.org_id = t.org_id "
                    "WHERE t.org_id = :org AND t.project_id = :pid "
                    "GROUP BY ta.task_id"
                ),
                {"org": org_id, "pid": canonical_id},
            )
        ).all()

        workload_rows = (
            await db.execute(
                text(
                    "SELECT ta.assignee_id, COALESCE(up.username, '') AS username, "
                    "       COUNT(*) AS assigned, "
                    "       COUNT(*) FILTER (WHERE ta.status = 'COMPLETED') AS completed "
                    "FROM tasks t "
                    "JOIN task_assignees ta ON ta.task_id = t.id AND ta.org_id = t.org_id "
                    "LEFT JOIN user_projection up "
                    "       ON up.user_id = ta.assignee_id AND up.org_id = ta.org_id "
                    "WHERE t.org_id = :org AND t.project_id = :pid "
                    "GROUP BY ta.assignee_id, up.username "
                    "ORDER BY assigned DESC, ta.assignee_id"
                ),
                {"org": org_id, "pid": canonical_id},
            )
        ).all()

        task_rows = (
            await db.execute(
                text(
                    "SELECT t.id, t.title_enc, t.sender_id, COALESCE(up.username, '') AS sender_username, "
                    "       t.created_at, t.deadline_at "
                    "FROM tasks t "
                    "LEFT JOIN user_projection up ON up.user_id = t.sender_id AND up.org_id = t.org_id "
                    "WHERE t.org_id = :org AND t.project_id = :pid "
                    "ORDER BY t.created_at DESC, t.id DESC "
                    "LIMIT :limit OFFSET :offset"
                ),
                {"org": org_id, "pid": canonical_id, "limit": limit, "offset": offset},
            )
        ).all()

        assignee_rows = []
        if task_rows:
            task_ids = [str(r.id) for r in task_rows]
            assignee_rows = (
                await db.execute(
                    text(
                        "SELECT ta.task_id, ta.assignee_id, ta.status, ta.assigned_at, "
                        "       COALESCE(up.username, '') AS username "
                        "FROM task_assignees ta "
                        "LEFT JOIN user_projection up "
                        "       ON up.user_id = ta.assignee_id AND up.org_id = ta.org_id "
                        "WHERE ta.org_id = :org AND ta.task_id = ANY(:task_ids) "
                        "ORDER BY ta.assigned_at, ta.assignee_id"
                    ),
                    {"org": org_id, "task_ids": task_ids},
                )
            ).all()

        ciphertexts = [r.title_enc for r in task_rows]
        versions = {v for v in (cryptor().peek_version(blob) for blob in ciphertexts) if v is not None}
        await cryptor().warm_dek_versions(db, org_id, versions)

    titles = await asyncio.to_thread(cryptor().decrypt_batch_cached, org_id, ciphertexts)

    breakdown = StatusBreakdownDTO()
    total_assignments = 0
    completed_assignments = 0
    for r in status_rows:
        total_assignments += r.n
        if r.status == "COMPLETED":
            completed_assignments = r.n
        setattr(breakdown, r.status.lower(), r.n)

    per_task_by_id = {str(r.task_id): r for r in per_task_rows}
    total_unique = len(per_task_rows)
    completed_unique = sum(1 for r in per_task_rows if r.remaining > 0 and r.remaining_incomplete == 0)
    abandoned_unique = sum(1 for r in per_task_rows if r.remaining == 0)
    remaining_unique = total_unique - completed_unique - abandoned_unique
    overdue_unique = sum(1 for r in per_task_rows if r.missed_count > 0)

    completion = CompletionMetricsDTO(
        totalAssignments=total_assignments,
        completedAssignments=completed_assignments,
        assignmentCompletionRate=_rate(completed_assignments, total_assignments),
        totalUniqueTasks=total_unique,
        completedUniqueTasks=completed_unique,
        abandonedUniqueTasks=abandoned_unique,
        remainingUniqueTasks=remaining_unique,
        uniqueTaskCompletionRate=_unique_task_completion(total_unique, completed_unique, abandoned_unique),
    )

    workload = [
        AssigneeWorkloadDTO(
            assigneeId=str(r.assignee_id),
            assigneeUsername=r.username,
            assignedCount=r.assigned,
            completedCount=r.completed,
            completionRate=_rate(r.completed, r.assigned),
        )
        for r in workload_rows
    ]

    assignees_by_task: dict[str, list[ProjectTaskAssigneeDTO]] = {}
    for r in assignee_rows:
        assignees_by_task.setdefault(str(r.task_id), []).append(
            ProjectTaskAssigneeDTO(
                assigneeId=str(r.assignee_id),
                assigneeUsername=r.username,
                status=r.status,
                assignedAt=iso(r.assigned_at),
            )
        )

    tasks: list[ProjectTaskSummaryDTO] = []
    for row, title in zip(task_rows, titles, strict=True):
        task_id = str(row.id)
        per_task = per_task_by_id.get(task_id)
        task_status: ProjectTaskStatus
        if per_task is None or per_task.remaining == 0:
            task_status = "ABANDONED"
        elif per_task.remaining_incomplete == 0:
            task_status = "COMPLETED"
        else:
            task_status = "IN_PROGRESS"
        tasks.append(
            ProjectTaskSummaryDTO(
                taskId=task_id,
                title=title or "",
                senderId=str(row.sender_id),
                senderUsername=row.sender_username,
                createdAt=iso(row.created_at),
                deadlineAt=iso(row.deadline_at),
                overdue=bool(per_task is not None and per_task.missed_count > 0),
                taskStatus=task_status,
                assignees=assignees_by_task.get(task_id, []),
            )
        )

    return ProjectAnalyticsDTO(
        projectId=canonical_id,
        statusBreakdown=breakdown,
        completion=completion,
        workload=workload,
        overdueUniqueTasks=overdue_unique,
        tasks=tasks,
        tasksOffset=offset,
        tasksLimit=limit,
        tasksTotal=total_unique,
    )


def _parse_overview_day(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _overview_range(from_: str | None, to: str | None) -> tuple[date, date]:
    """Parse the range, defaulting to the last 30 days and bounding its width.

    The client sends absolute dates it computed in the VIEWER's timezone (the
    same rule the tasks export and telemetry-svc's analytics follow) — the
    server never interprets "last week". Reimplemented locally rather than
    imported from telemetry-svc: the two are separate deployable services.
    """
    end = _parse_overview_day(to) or datetime.now(timezone.utc).date()
    start = _parse_overview_day(from_) or (end - timedelta(days=_DEFAULT_OVERVIEW_DAYS - 1))
    if start > end:
        start, end = end, start
    if (end - start).days > _MAX_OVERVIEW_RANGE_DAYS:
        start = end - timedelta(days=_MAX_OVERVIEW_RANGE_DAYS)
    return start, end


@router.get("/tasks/analytics/overview", response_model=WorkspaceOverviewDTO)
async def workspace_overview(
    principal: Principal = OrgAdminDep,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    channelId: str | None = Query(default=None),
) -> WorkspaceOverviewDTO:
    """Workspace-wide rollup across every channel in the org: KPI totals, a
    per-channel completion ranking, per-person workload, and a day-bucketed
    activity series — the data behind the Analytics page's overview dashboard.

    org_admin only (OrgAdminDep), unlike the three endpoints above: this
    aggregates productivity data across every member and every channel in the
    org, including channels the caller never joined, which is a materially
    different exposure than task/channel/project analytics above, each of
    which requires the caller to already be a party (sender, assignee, or
    channel member) to what they're asking about. Same gate telemetry-svc's
    GET /telemetry/org/summary uses for the same reason.
    """
    org_id = principal.org_id
    start_day, end_day = _overview_range(from_, to)
    start = datetime.combine(start_day, time.min, tzinfo=timezone.utc)
    end = datetime.combine(end_day + timedelta(days=1), time.min, tzinfo=timezone.utc)

    channel_join = (
        "JOIN task_channels tc ON tc.task_id = t.id AND tc.org_id = t.org_id" if channelId else ""
    )
    channel_where = "AND tc.channel_id = :channel_id" if channelId else ""
    params: dict[str, object] = {"org": org_id, "start": start, "end": end}
    if channelId:
        params["channel_id"] = channelId

    async with session() as db:
        # RLS: bind org context before any statement.
        await set_org_context(db, org_id)

        status_rows = (
            await db.execute(
                text(
                    "SELECT ta.status, COUNT(*) AS n "
                    "FROM tasks t "
                    "JOIN task_assignees ta ON ta.task_id = t.id AND ta.org_id = t.org_id "
                    f"{channel_join} "
                    "WHERE t.org_id = :org AND t.created_at >= :start AND t.created_at < :end "
                    f"{channel_where} "
                    "GROUP BY ta.status"
                ),
                params,
            )
        ).all()

        # Same per-task "remaining / remaining_incomplete / missed_count" rule
        # as project_analytics above, scoped org-wide instead of per-project.
        per_task_rows = (
            await db.execute(
                text(
                    "SELECT ta.task_id, "
                    "       COUNT(*) FILTER (WHERE ta.status NOT IN ('LEFT','IGNORED')) AS remaining, "
                    "       COUNT(*) FILTER ("
                    "           WHERE ta.status NOT IN ('LEFT','IGNORED') AND ta.status <> 'COMPLETED'"
                    "       ) AS remaining_incomplete, "
                    "       COUNT(*) FILTER (WHERE ta.status = 'MISSED') AS missed_count "
                    "FROM tasks t "
                    "JOIN task_assignees ta ON ta.task_id = t.id AND ta.org_id = t.org_id "
                    f"{channel_join} "
                    "WHERE t.org_id = :org AND t.created_at >= :start AND t.created_at < :end "
                    f"{channel_where} "
                    "GROUP BY ta.task_id"
                ),
                params,
            )
        ).all()

        # Per (channel, task) — always joins task_channels (it IS the grouping
        # key), independent of the optional single-channel filter above.
        per_channel_rows = (
            await db.execute(
                text(
                    "SELECT tc.channel_id, t.id AS task_id, "
                    "       COUNT(*) FILTER (WHERE ta.status NOT IN ('LEFT','IGNORED')) AS remaining, "
                    "       COUNT(*) FILTER ("
                    "           WHERE ta.status NOT IN ('LEFT','IGNORED') AND ta.status <> 'COMPLETED'"
                    "       ) AS remaining_incomplete "
                    "FROM tasks t "
                    "JOIN task_channels tc ON tc.task_id = t.id AND tc.org_id = t.org_id "
                    "JOIN task_assignees ta ON ta.task_id = t.id AND ta.org_id = t.org_id "
                    "WHERE t.org_id = :org AND t.created_at >= :start AND t.created_at < :end "
                    f"{channel_where} "
                    "GROUP BY tc.channel_id, t.id"
                ),
                params,
            )
        ).all()

        workload_rows = (
            await db.execute(
                text(
                    "SELECT ta.assignee_id, COALESCE(up.username, '') AS username, "
                    "       COUNT(*) AS assigned, "
                    "       COUNT(*) FILTER (WHERE ta.status = 'COMPLETED') AS completed, "
                    "       COUNT(*) FILTER (WHERE ta.status IN ('SENT','ACKNOWLEDGED')) AS in_progress "
                    "FROM tasks t "
                    "JOIN task_assignees ta ON ta.task_id = t.id AND ta.org_id = t.org_id "
                    "LEFT JOIN user_projection up "
                    "       ON up.user_id = ta.assignee_id AND up.org_id = ta.org_id "
                    f"{channel_join} "
                    "WHERE t.org_id = :org AND t.created_at >= :start AND t.created_at < :end "
                    f"{channel_where} "
                    "GROUP BY ta.assignee_id, up.username "
                    "ORDER BY assigned DESC, ta.assignee_id "
                    "LIMIT :workload_limit"
                ),
                {**params, "workload_limit": _OVERVIEW_WORKLOAD_LIMIT},
            )
        ).all()

        # One row per calendar day in range (UTC, matching the >= start / <
        # end scope above), zero-filled where nothing happened that day.
        daily_rows = (
            await db.execute(
                text(
                    "WITH days AS ("
                    "    SELECT generate_series(CAST(:start_day AS date), CAST(:end_day AS date), "
                    "           interval '1 day')::date AS day"
                    "), created AS ("
                    "    SELECT (t.created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n "
                    "    FROM tasks t "
                    f"    {channel_join} "
                    "    WHERE t.org_id = :org AND t.created_at >= :start AND t.created_at < :end "
                    f"    {channel_where} "
                    "    GROUP BY 1"
                    "), completed AS ("
                    "    SELECT (ta.completed_at AT TIME ZONE 'UTC')::date AS day, "
                    "           COUNT(DISTINCT ta.task_id) AS n "
                    "    FROM task_assignees ta "
                    "    JOIN tasks t ON t.id = ta.task_id AND t.org_id = ta.org_id "
                    f"    {channel_join} "
                    "    WHERE t.org_id = :org AND ta.completed_at >= :start AND ta.completed_at < :end "
                    f"    {channel_where} "
                    "    GROUP BY 1"
                    ") "
                    "SELECT days.day, COALESCE(created.n, 0) AS created_n, COALESCE(completed.n, 0) AS completed_n "
                    "FROM days "
                    "LEFT JOIN created ON created.day = days.day "
                    "LEFT JOIN completed ON completed.day = days.day "
                    "ORDER BY days.day"
                ),
                {**params, "start_day": start_day, "end_day": end_day},
            )
        ).all()

    breakdown = StatusBreakdownDTO()
    total_assignments = 0
    completed_assignments = 0
    for r in status_rows:
        total_assignments += r.n
        if r.status == "COMPLETED":
            completed_assignments = r.n
        setattr(breakdown, r.status.lower(), r.n)

    total_unique = len(per_task_rows)
    completed_unique = sum(1 for r in per_task_rows if r.remaining > 0 and r.remaining_incomplete == 0)
    abandoned_unique = sum(1 for r in per_task_rows if r.remaining == 0)
    remaining_unique = total_unique - completed_unique - abandoned_unique
    overdue_unique = sum(1 for r in per_task_rows if r.missed_count > 0)
    # Always a subset of remaining_unique: a MISSED row keeps remaining_incomplete
    # > 0 (MISSED is in _REMAINING_STATUSES and is never COMPLETED), so an
    # overdue task can be neither "completed" nor "abandoned" above.
    in_progress_unique = remaining_unique - overdue_unique

    completion = CompletionMetricsDTO(
        totalAssignments=total_assignments,
        completedAssignments=completed_assignments,
        assignmentCompletionRate=_rate(completed_assignments, total_assignments),
        totalUniqueTasks=total_unique,
        completedUniqueTasks=completed_unique,
        abandonedUniqueTasks=abandoned_unique,
        remainingUniqueTasks=remaining_unique,
        uniqueTaskCompletionRate=_unique_task_completion(total_unique, completed_unique, abandoned_unique),
    )

    per_channel_totals: dict[str, dict[str, int]] = {}
    for r in per_channel_rows:
        bucket = per_channel_totals.setdefault(str(r.channel_id), {"total": 0, "completed": 0})
        bucket["total"] += 1
        if r.remaining > 0 and r.remaining_incomplete == 0:
            bucket["completed"] += 1

    channels = sorted(
        (
            ChannelPerformanceDTO(
                channelId=cid,
                totalUniqueTasks=bucket["total"],
                completedUniqueTasks=bucket["completed"],
                completionRate=_rate(bucket["completed"], bucket["total"]),
            )
            for cid, bucket in per_channel_totals.items()
        ),
        key=lambda c: c.totalUniqueTasks,
        reverse=True,
    )[:_OVERVIEW_CHANNELS_LIMIT]

    workload = [
        WorkloadBreakdownDTO(
            assigneeId=str(r.assignee_id),
            assigneeUsername=r.username,
            assignedCount=r.assigned,
            completedCount=r.completed,
            inProgressCount=r.in_progress,
            completionRate=_rate(r.completed, r.assigned),
        )
        for r in workload_rows
    ]

    daily_activity = [
        DailyActivityPointDTO(day=r.day.isoformat(), tasksCreated=r.created_n, tasksCompleted=r.completed_n)
        for r in daily_rows
    ]

    return WorkspaceOverviewDTO(
        statusBreakdown=breakdown,
        completion=completion,
        overdueUniqueTasks=overdue_unique,
        inProgressUniqueTasks=in_progress_unique,
        workload=workload,
        channels=channels,
        dailyActivity=daily_activity,
        rangeFrom=start_day.isoformat(),
        rangeTo=end_day.isoformat(),
    )
