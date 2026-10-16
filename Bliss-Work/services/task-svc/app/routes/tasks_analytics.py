from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text

from ..auth import Principal, PrincipalDep
from crypto import cryptor
from ..db import session, set_org_context
from ..schemas import (
    AssigneeWorkloadDTO,
    ChannelAnalyticsDTO,
    CompletionMetricsDTO,
    DailyActivityPointDTO,
    KpiTrendDTO,
    ProjectAnalyticsDTO,
    ProjectPerformanceDTO,
    ProjectTaskAssigneeDTO,
    ProjectTaskStatus,
    ProjectTaskSummaryDTO,
    StatusBreakdownDTO,
    StatusDayPointDTO,
    TaskAnalyticsAssigneeDTO,
    TaskAnalyticsDTO,
    WorkloadBreakdownDTO,
    WorkspaceKpiTrendsDTO,
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
_OVERVIEW_PROJECTS_LIMIT = 10
_OVERVIEW_WORKLOAD_LIMIT = 20

# Rows never left/ignored their assignment — the ones that can still make a
# task "complete". See the module docstring in schemas.py for the full rule.
_REMAINING_STATUSES = ("SENT", "ACKNOWLEDGED", "COMPLETED", "MISSED")


def _unique_task_completion(total_unique: int, completed_unique: int, abandoned_unique: int) -> float:
    return (completed_unique / total_unique * 100) if total_unique else 0.0


def _rate(numerator: int, denominator: int) -> float:
    return (numerator / denominator * 100) if denominator else 0.0


def _delta_pct(current: int, previous: int) -> float | None:
    """None (never 0 or Infinity) when there is nothing to compare against —
    a previous period with zero activity doesn't make "the trend" fabricated
    data."""
    return ((current - previous) / previous * 100) if previous else None


# The four unique-task aggregates every overview/project/channel endpoint
# derives from a `per_task_rows`-shaped result set (task_id, remaining,
# remaining_incomplete, missed_count) — factored out so workspace_overview can
# apply it to both the selected range and the immediately preceding one.
def _task_aggregates(rows: list) -> tuple[int, int, int, int, int]:
    total_unique = len(rows)
    completed_unique = sum(1 for r in rows if r.remaining > 0 and r.remaining_incomplete == 0)
    abandoned_unique = sum(1 for r in rows if r.remaining == 0)
    remaining_unique = total_unique - completed_unique - abandoned_unique
    overdue_unique = sum(1 for r in rows if r.missed_count > 0)
    # Always a subset of remaining_unique: a MISSED row keeps remaining_incomplete
    # > 0 (MISSED is in _REMAINING_STATUSES and is never COMPLETED), so an
    # overdue task can be neither "completed" nor "abandoned".
    in_progress_unique = remaining_unique - overdue_unique
    return total_unique, completed_unique, overdue_unique, in_progress_unique, abandoned_unique


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
    principal: Principal = PrincipalDep,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    projectId: str | None = Query(default=None),
) -> WorkspaceOverviewDTO:
    """Workspace-wide rollup: KPI totals (each with a vs-previous-period delta
    and a day-bucketed sparkline), a per-project completion ranking, per-person
    workload, a day-bucketed activity series, and a day×status "flow" series —
    the data behind the Analytics page's overview dashboard.

    Open to any authenticated member, but non-admins only ever see tasks they
    are already a party to (sender or assignee) — the same "am I a party to
    this" rule task_analytics/channel_analytics/project_analytics enforce
    above, just applied as a row filter instead of a single lookup, since this
    endpoint aggregates rather than fetching one task/channel/project. Members
    never see another member's projects or activity this way.

    Per-person workload is scoped further still: `member_where` alone would
    let a non-admin sender see their OWN assignees' individual workload rows
    (every task they sent passes `t.sender_id = :me`, and the workload query
    then groups by every assignee on those tasks) — a real disclosure of a
    colleague's completion stats, not merely "tasks I'm a party to". So the
    workload query additionally restricts non-admins to `ta.assignee_id = :me`:
    a member's Person Workload is always exactly their own row (or empty),
    never another member's, regardless of who sent the task.

    org_admin keeps the original unrestricted, org-wide rollup (including
    projects/members the caller never joined) — the same elevated view
    telemetry-svc's GET /telemetry/org/summary grants admins for the same
    reason.

    `tasks.project_id` is a plain nullable FK (a task belongs to at most one
    project), unlike the many-channels join table — so, unlike the retired
    channel filter, scoping by project needs no extra JOIN, just a WHERE.
    """
    org_id, me = principal.org_id, principal.user_id
    is_admin = "org_admin" in principal.roles
    start_day, end_day = _overview_range(from_, to)
    start = datetime.combine(start_day, time.min, tzinfo=timezone.utc)
    end = datetime.combine(end_day + timedelta(days=1), time.min, tzinfo=timezone.utc)
    # The immediately preceding, equal-length window — the baseline every KPI
    # and project trend is compared against. Never shown as its own range.
    prev_end = start
    prev_start = start - (end - start)

    project_where = "AND t.project_id = :project_id" if projectId else ""
    member_where = (
        ""
        if is_admin
        else (
            "AND (t.sender_id = :me OR EXISTS ("
            "SELECT 1 FROM task_assignees ta_mine WHERE ta_mine.org_id = t.org_id "
            "AND ta_mine.task_id = t.id AND ta_mine.assignee_id = :me"
            "))"
        )
    )
    # Person Workload only: see the docstring above — a non-admin's workload
    # rows are further restricted to their own assignee_id, never a colleague's.
    workload_where = "" if is_admin else "AND ta.assignee_id = :me"
    params: dict[str, object] = {"org": org_id, "start": start, "end": end, "me": me}
    prev_params: dict[str, object] = {"org": org_id, "start": prev_start, "end": prev_end, "me": me}
    if projectId:
        params["project_id"] = projectId
        prev_params["project_id"] = projectId

    # Same per-task "remaining / remaining_incomplete / missed_count" rule as
    # project_analytics above, scoped org-wide (or to one project) instead of
    # to a single project's own route.
    per_task_sql = text(
        "SELECT ta.task_id, "
        "       COUNT(*) FILTER (WHERE ta.status NOT IN ('LEFT','IGNORED')) AS remaining, "
        "       COUNT(*) FILTER ("
        "           WHERE ta.status NOT IN ('LEFT','IGNORED') AND ta.status <> 'COMPLETED'"
        "       ) AS remaining_incomplete, "
        "       COUNT(*) FILTER (WHERE ta.status = 'MISSED') AS missed_count "
        "FROM tasks t "
        "JOIN task_assignees ta ON ta.task_id = t.id AND ta.org_id = t.org_id "
        "WHERE t.org_id = :org AND t.created_at >= :start AND t.created_at < :end "
        f"{project_where} {member_where} "
        "GROUP BY ta.task_id"
    )
    # Per (project, task) — always grouped by project_id (it IS the ranking
    # key), independent of the optional single-project filter above. Tasks
    # with no project are excluded from the ranking (there is nothing to
    # name), the same way the retired per-channel ranking only ever covered
    # tasks attached to a channel.
    per_project_sql = text(
        "SELECT t.project_id, t.id AS task_id, "
        "       COUNT(*) FILTER (WHERE ta.status NOT IN ('LEFT','IGNORED')) AS remaining, "
        "       COUNT(*) FILTER ("
        "           WHERE ta.status NOT IN ('LEFT','IGNORED') AND ta.status <> 'COMPLETED'"
        "       ) AS remaining_incomplete "
        "FROM tasks t "
        "JOIN task_assignees ta ON ta.task_id = t.id AND ta.org_id = t.org_id "
        "WHERE t.org_id = :org AND t.created_at >= :start AND t.created_at < :end "
        "AND t.project_id IS NOT NULL "
        f"{project_where} {member_where} "
        "GROUP BY t.project_id, t.id"
    )

    async with session() as db:
        # RLS: bind org context before any statement.
        await set_org_context(db, org_id)

        status_rows = (
            await db.execute(
                text(
                    "SELECT ta.status, COUNT(*) AS n "
                    "FROM tasks t "
                    "JOIN task_assignees ta ON ta.task_id = t.id AND ta.org_id = t.org_id "
                    "WHERE t.org_id = :org AND t.created_at >= :start AND t.created_at < :end "
                    f"{project_where} {member_where} "
                    "GROUP BY ta.status"
                ),
                params,
            )
        ).all()

        per_task_rows = (await db.execute(per_task_sql, params)).all()
        prev_task_rows = (await db.execute(per_task_sql, prev_params)).all()
        per_project_rows = (await db.execute(per_project_sql, params)).all()
        prev_project_rows = (await db.execute(per_project_sql, prev_params)).all()

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
                    "WHERE t.org_id = :org AND t.created_at >= :start AND t.created_at < :end "
                    f"{project_where} {member_where} {workload_where} "
                    "GROUP BY ta.assignee_id, up.username "
                    "ORDER BY assigned DESC, ta.assignee_id "
                    "LIMIT :workload_limit"
                ),
                {**params, "workload_limit": _OVERVIEW_WORKLOAD_LIMIT},
            )
        ).all()

        # One row per calendar day in range (UTC, matching the >= start / <
        # end scope above), zero-filled where nothing happened that day.
        # `created`/`completed` are TASK-level (COUNT DISTINCT task_id) and
        # feed dailyActivity + the totalTasks/completed KPI sparklines, which
        # are themselves task-level counts. The six `*_e` CTEs are
        # ASSIGNEE-ROW-level event counts (one row per status transition,
        # matching StatusBreakdownDTO's own row-count semantics) and feed
        # statusFlow; `acknowledged_e`/`missed_e` additionally double as the
        # inProgress/overdue KPI sparklines — a real daily event count, not a
        # true per-day in-progress/overdue snapshot (task-svc has no status
        # history table to reconstruct one from).
        daily_rows = (
            await db.execute(
                text(
                    "WITH days AS ("
                    "    SELECT generate_series(CAST(:start_day AS date), CAST(:end_day AS date), "
                    "           interval '1 day')::date AS day"
                    "), created AS ("
                    "    SELECT (t.created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n "
                    "    FROM tasks t "
                    "    WHERE t.org_id = :org AND t.created_at >= :start AND t.created_at < :end "
                    f"    {project_where} {member_where} "
                    "    GROUP BY 1"
                    "), completed AS ("
                    "    SELECT (ta.completed_at AT TIME ZONE 'UTC')::date AS day, "
                    "           COUNT(DISTINCT ta.task_id) AS n "
                    "    FROM task_assignees ta "
                    "    JOIN tasks t ON t.id = ta.task_id AND t.org_id = ta.org_id "
                    "    WHERE t.org_id = :org AND ta.completed_at >= :start AND ta.completed_at < :end "
                    f"    {project_where} {member_where} "
                    "    GROUP BY 1"
                    "), sent_e AS ("
                    "    SELECT (ta.assigned_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n "
                    "    FROM task_assignees ta "
                    "    JOIN tasks t ON t.id = ta.task_id AND t.org_id = ta.org_id "
                    "    WHERE t.org_id = :org AND ta.assigned_at >= :start AND ta.assigned_at < :end "
                    f"    {project_where} {member_where} "
                    "    GROUP BY 1"
                    "), acknowledged_e AS ("
                    "    SELECT (ta.acknowledged_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n "
                    "    FROM task_assignees ta "
                    "    JOIN tasks t ON t.id = ta.task_id AND t.org_id = ta.org_id "
                    "    WHERE t.org_id = :org AND ta.acknowledged_at >= :start AND ta.acknowledged_at < :end "
                    f"    {project_where} {member_where} "
                    "    GROUP BY 1"
                    "), completed_e AS ("
                    "    SELECT (ta.completed_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n "
                    "    FROM task_assignees ta "
                    "    JOIN tasks t ON t.id = ta.task_id AND t.org_id = ta.org_id "
                    "    WHERE t.org_id = :org AND ta.completed_at >= :start AND ta.completed_at < :end "
                    f"    {project_where} {member_where} "
                    "    GROUP BY 1"
                    "), missed_e AS ("
                    "    SELECT (ta.missed_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n "
                    "    FROM task_assignees ta "
                    "    JOIN tasks t ON t.id = ta.task_id AND t.org_id = ta.org_id "
                    "    WHERE t.org_id = :org AND ta.missed_at >= :start AND ta.missed_at < :end "
                    f"    {project_where} {member_where} "
                    "    GROUP BY 1"
                    "), ignored_e AS ("
                    "    SELECT (ta.ignored_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n "
                    "    FROM task_assignees ta "
                    "    JOIN tasks t ON t.id = ta.task_id AND t.org_id = ta.org_id "
                    "    WHERE t.org_id = :org AND ta.ignored_at >= :start AND ta.ignored_at < :end "
                    f"    {project_where} {member_where} "
                    "    GROUP BY 1"
                    "), left_e AS ("
                    "    SELECT (ta.left_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n "
                    "    FROM task_assignees ta "
                    "    JOIN tasks t ON t.id = ta.task_id AND t.org_id = ta.org_id "
                    "    WHERE t.org_id = :org AND ta.left_at >= :start AND ta.left_at < :end "
                    f"    {project_where} {member_where} "
                    "    GROUP BY 1"
                    ") "
                    "SELECT days.day, "
                    "       COALESCE(created.n, 0) AS created_n, "
                    "       COALESCE(completed.n, 0) AS completed_n, "
                    "       COALESCE(sent_e.n, 0) AS sent_n, "
                    "       COALESCE(acknowledged_e.n, 0) AS acknowledged_n, "
                    "       COALESCE(completed_e.n, 0) AS completed_e_n, "
                    "       COALESCE(missed_e.n, 0) AS missed_n, "
                    "       COALESCE(ignored_e.n, 0) AS ignored_n, "
                    "       COALESCE(left_e.n, 0) AS left_n "
                    "FROM days "
                    "LEFT JOIN created ON created.day = days.day "
                    "LEFT JOIN completed ON completed.day = days.day "
                    "LEFT JOIN sent_e ON sent_e.day = days.day "
                    "LEFT JOIN acknowledged_e ON acknowledged_e.day = days.day "
                    "LEFT JOIN completed_e ON completed_e.day = days.day "
                    "LEFT JOIN missed_e ON missed_e.day = days.day "
                    "LEFT JOIN ignored_e ON ignored_e.day = days.day "
                    "LEFT JOIN left_e ON left_e.day = days.day "
                    "ORDER BY days.day"
                ),
                {**params, "start_day": start_day, "end_day": end_day},
            )
        ).all()

        # Names for the top-ranked projects only (decided below, before
        # decrypting) — never fetched for every project ever touched in range.
        totals_by_project: dict[str, dict[str, int]] = {}
        for r in per_project_rows:
            bucket = totals_by_project.setdefault(str(r.project_id), {"total": 0, "completed": 0})
            bucket["total"] += 1
            if r.remaining > 0 and r.remaining_incomplete == 0:
                bucket["completed"] += 1
        ranked_ids = sorted(
            totals_by_project, key=lambda pid: totals_by_project[pid]["total"], reverse=True
        )[:_OVERVIEW_PROJECTS_LIMIT]

        name_rows = []
        if ranked_ids:
            name_rows = (
                await db.execute(
                    text("SELECT id, name_enc FROM projects WHERE org_id = :org AND id = ANY(:ids)"),
                    {"org": org_id, "ids": ranked_ids},
                )
            ).all()
            ciphertexts = [r.name_enc for r in name_rows]
            versions = {v for v in (cryptor().peek_version(blob) for blob in ciphertexts) if v is not None}
            await cryptor().warm_dek_versions(db, org_id, versions)

    project_names = {}
    if name_rows:
        decrypted = await asyncio.to_thread(
            cryptor().decrypt_batch_cached, org_id, [r.name_enc for r in name_rows]
        )
        project_names = {str(r.id): (name or "") for r, name in zip(name_rows, decrypted, strict=True)}

    prev_totals_by_project: dict[str, dict[str, int]] = {}
    for r in prev_project_rows:
        bucket = prev_totals_by_project.setdefault(str(r.project_id), {"total": 0, "completed": 0})
        bucket["total"] += 1
        if r.remaining > 0 and r.remaining_incomplete == 0:
            bucket["completed"] += 1

    breakdown = StatusBreakdownDTO()
    total_assignments = 0
    completed_assignments = 0
    for r in status_rows:
        total_assignments += r.n
        if r.status == "COMPLETED":
            completed_assignments = r.n
        setattr(breakdown, r.status.lower(), r.n)

    total_unique, completed_unique, overdue_unique, in_progress_unique, abandoned_unique = _task_aggregates(
        per_task_rows
    )
    prev_total, prev_completed, prev_overdue, prev_in_progress, _prev_abandoned = _task_aggregates(
        prev_task_rows
    )

    completion = CompletionMetricsDTO(
        totalAssignments=total_assignments,
        completedAssignments=completed_assignments,
        assignmentCompletionRate=_rate(completed_assignments, total_assignments),
        totalUniqueTasks=total_unique,
        completedUniqueTasks=completed_unique,
        abandonedUniqueTasks=abandoned_unique,
        remainingUniqueTasks=total_unique - completed_unique - abandoned_unique,
        uniqueTaskCompletionRate=_unique_task_completion(total_unique, completed_unique, abandoned_unique),
    )

    project_performance = [
        ProjectPerformanceDTO(
            projectId=pid,
            name=project_names.get(pid, ""),
            totalUniqueTasks=totals_by_project[pid]["total"],
            completedUniqueTasks=totals_by_project[pid]["completed"],
            completionRate=_rate(totals_by_project[pid]["completed"], totals_by_project[pid]["total"]),
            trendPct=(
                _rate(totals_by_project[pid]["completed"], totals_by_project[pid]["total"])
                - _rate(prev_totals_by_project[pid]["completed"], prev_totals_by_project[pid]["total"])
                if prev_totals_by_project.get(pid, {}).get("total")
                else None
            ),
        )
        for pid in ranked_ids
    ]

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
    status_flow = [
        StatusDayPointDTO(
            day=r.day.isoformat(),
            sent=r.sent_n,
            acknowledged=r.acknowledged_n,
            completed=r.completed_e_n,
            missed=r.missed_n,
            ignored=r.ignored_n,
            left=r.left_n,
        )
        for r in daily_rows
    ]

    kpis = WorkspaceKpiTrendsDTO(
        totalTasks=KpiTrendDTO(
            value=total_unique,
            previousValue=prev_total,
            deltaPct=_delta_pct(total_unique, prev_total),
            sparkline=[r.created_n for r in daily_rows],
        ),
        completed=KpiTrendDTO(
            value=completed_unique,
            previousValue=prev_completed,
            deltaPct=_delta_pct(completed_unique, prev_completed),
            sparkline=[r.completed_n for r in daily_rows],
        ),
        inProgress=KpiTrendDTO(
            value=in_progress_unique,
            previousValue=prev_in_progress,
            deltaPct=_delta_pct(in_progress_unique, prev_in_progress),
            sparkline=[r.acknowledged_n for r in daily_rows],
        ),
        overdue=KpiTrendDTO(
            value=overdue_unique,
            previousValue=prev_overdue,
            deltaPct=_delta_pct(overdue_unique, prev_overdue),
            sparkline=[r.missed_n for r in daily_rows],
        ),
    )

    return WorkspaceOverviewDTO(
        statusBreakdown=breakdown,
        completion=completion,
        overdueUniqueTasks=overdue_unique,
        inProgressUniqueTasks=in_progress_unique,
        workload=workload,
        projectPerformance=project_performance,
        dailyActivity=daily_activity,
        kpis=kpis,
        statusFlow=status_flow,
        rangeFrom=start_day.isoformat(),
        rangeTo=end_day.isoformat(),
    )
