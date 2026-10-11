from __future__ import annotations

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from ..auth import Principal, PrincipalDep
from crypto import cryptor
from ..db import session, set_org_context
from ..schemas import (
    AssigneeWorkloadDTO,
    ChannelAnalyticsDTO,
    CompletionMetricsDTO,
    StatusBreakdownDTO,
    TaskAnalyticsAssigneeDTO,
    TaskAnalyticsDTO,
)
from .helpers import iso
from .tasks_write import _resolve_channel_members

router = APIRouter()

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
