"""GET /tasks/analytics/overview — workspace rollup behind the Analytics
Overview dashboard: KPI totals (each with a vs-previous-period delta and a
day-bucketed sparkline), a per-project completion ranking, per-person
workload, a day-bucketed activity series, and a day×status flow series.

Open to any authenticated member. org_admin gets the original unrestricted,
org-wide rollup. A non-admin gets the same rollup shape, but every row is
filtered to tasks they are already a party to (sender or assignee) — the
same "am I a party to this" rule the per-task/per-channel/per-project
analytics endpoints enforce individually.

This dashboard is project-wise (tasks.project_id), not channel-wise — the
retired channel filter/ranking is covered by its own per-channel route
(test_channel_analytics.py), not here.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG_A = "11111111-1111-1111-1111-111111111111"
ORG_B = "22222222-2222-2222-2222-222222222222"
SENDER = "33333333-3333-3333-3333-333333333333"


def _id() -> str:
    return str(uuid.uuid4())


def _principal(user_id: str, org_id: str = ORG_A, roles: list[str] | None = None):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=roles or ["org_admin"], username="u")


async def _client(user_id: str, org_id: str = ORG_A, roles: list[str] | None = None) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: _principal(user_id, org_id, roles)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _project(org: str, created_by: str, name: str | None = None) -> str:
    from app.db import session, set_org_context
    from app.projects import normalize_project_name, project_name_hash
    from crypto import cryptor

    project_id = _id()
    display_name = name or f"Project {project_id}"
    async with session() as db:
        await set_org_context(db, org)
        enc = await cryptor().encrypt(db, org, display_name)
        name_hash = project_name_hash(normalize_project_name(display_name))
        await db.execute(
            text(
                "INSERT INTO projects (id, org_id, name_enc, name_hash, created_by) "
                "VALUES (:p, :o, :e, :h, :c)"
            ),
            {"p": project_id, "o": org, "e": enc, "h": name_hash, "c": created_by},
        )
        await db.commit()
    return project_id


async def _task(
    org: str,
    sender: str,
    title: str = "Task",
    created_at: datetime | None = None,
    project_id: str | None = None,
) -> str:
    from app.db import session, set_org_context
    from crypto import cryptor

    task_id = _id()
    async with session() as db:
        await set_org_context(db, org)
        enc = await cryptor().encrypt(db, org, title)
        if created_at is None:
            await db.execute(
                text(
                    "INSERT INTO tasks (id, org_id, sender_id, title_enc, project_id) "
                    "VALUES (:t, :o, :s, :e, :p)"
                ),
                {"t": task_id, "o": org, "s": sender, "e": enc, "p": project_id},
            )
        else:
            await db.execute(
                text(
                    "INSERT INTO tasks (id, org_id, sender_id, title_enc, created_at, project_id) "
                    "VALUES (:t, :o, :s, :e, :c, :p)"
                ),
                {"t": task_id, "o": org, "s": sender, "e": enc, "c": created_at, "p": project_id},
            )
        await db.commit()
    return task_id


async def _assignee_row(
    org: str,
    task_id: str,
    assignee_id: str,
    status: str,
    completed_at: datetime | None = None,
    acknowledged_at: datetime | None = None,
    missed_at: datetime | None = None,
) -> None:
    from app.db import session, set_org_context

    assert status in ("SENT", "IGNORED", "ACKNOWLEDGED", "COMPLETED", "LEFT", "MISSED")
    async with session() as db:
        await set_org_context(db, org)
        await db.execute(
            text(
                "INSERT INTO task_assignees "
                "(task_id, org_id, assignee_id, status, completed_at, acknowledged_at, missed_at) "
                f"VALUES (:t, :o, :a, '{status}', :ca, :aa, :ma)"
            ),
            {"t": task_id, "o": org, "a": assignee_id, "ca": completed_at, "aa": acknowledged_at, "ma": missed_at},
        )
        await db.commit()


async def _get(
    as_user: str,
    org: str = ORG_A,
    roles: list[str] | None = None,
    **params: str,
) -> httpx.Response:
    async with await _client(as_user, org, roles) as c:
        return await c.get("/api/v1/tasks/analytics/overview", params=params)


def _today() -> date:
    return datetime.now(timezone.utc).date()


async def test_non_admin_is_accepted(db_app):
    r = await _get(SENDER, roles=["member"])
    assert r.status_code == 200, r.text


async def test_non_admin_only_sees_own_tasks(db_app):
    other_sender, other_assignee = _id(), _id()
    me_assignee = _id()

    # A task I sent — visible to me.
    mine = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, mine, me_assignee, "COMPLETED")

    # A task I'm assigned to (someone else sent it) — also visible to me.
    assigned_to_me = await _task(ORG_A, other_sender)
    await _assignee_row(ORG_A, assigned_to_me, SENDER, "SENT")

    # A task I have no part in — must stay invisible to a non-admin.
    not_mine = await _task(ORG_A, other_sender)
    await _assignee_row(ORG_A, not_mine, other_assignee, "COMPLETED")

    member_r = await _get(SENDER, roles=["member"])
    assert member_r.status_code == 200, member_r.text
    assert member_r.json()["completion"]["totalUniqueTasks"] == 2

    admin_r = await _get(SENDER, roles=["org_admin"])
    assert admin_r.json()["completion"]["totalUniqueTasks"] == 3


async def test_empty_org_is_all_zero_not_divide_by_zero(db_app):
    r = await _get(SENDER)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["completion"]["totalUniqueTasks"] == 0
    assert body["completion"]["uniqueTaskCompletionRate"] == 0.0
    assert body["overdueUniqueTasks"] == 0
    assert body["inProgressUniqueTasks"] == 0
    assert body["workload"] == []
    assert body["projectPerformance"] == []
    assert body["kpis"]["totalTasks"]["value"] == 0
    assert body["kpis"]["totalTasks"]["deltaPct"] is None
    # statusFlow/dailyActivity are zero-filled per day over the whole default
    # range (like the pre-existing dailyActivity), never an empty list.
    assert len(body["statusFlow"]) == len(body["dailyActivity"]) == 30
    assert all(v == 0 for d in body["statusFlow"] for k, v in d.items() if k != "day")


async def test_kpi_totals_completed_overdue_in_progress(db_app):
    assignee = _id()

    # Completed task.
    t1 = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, t1, assignee, "COMPLETED", completed_at=datetime.now(timezone.utc))

    # Overdue task (one MISSED row).
    t2 = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, t2, assignee, "MISSED")

    # Plain in-progress task.
    t3 = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, t3, assignee, "SENT")

    # Abandoned task — excluded from all four KPIs.
    t4 = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, t4, assignee, "LEFT")

    r = await _get(SENDER)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["completion"]["totalUniqueTasks"] == 4
    assert body["completion"]["completedUniqueTasks"] == 1
    assert body["completion"]["abandonedUniqueTasks"] == 1
    assert body["overdueUniqueTasks"] == 1
    assert body["inProgressUniqueTasks"] == 1

    kpis = body["kpis"]
    assert kpis["totalTasks"]["value"] == 4
    assert kpis["completed"]["value"] == 1
    assert kpis["inProgress"]["value"] == 1
    assert kpis["overdue"]["value"] == 1
    # Nothing was created in the preceding, equal-length window here.
    assert kpis["totalTasks"]["previousValue"] == 0
    assert kpis["totalTasks"]["deltaPct"] is None


async def test_project_ranking_sorted_by_total_desc(db_app):
    big = await _project(ORG_A, SENDER, "Big Project")
    small = await _project(ORG_A, SENDER, "Small Project")
    assignee = _id()
    for _ in range(3):
        t = await _task(ORG_A, SENDER, project_id=big)
        await _assignee_row(ORG_A, t, assignee, "COMPLETED")
    t = await _task(ORG_A, SENDER, project_id=small)
    await _assignee_row(ORG_A, t, assignee, "SENT")

    r = await _get(SENDER)
    projects = {p["projectId"]: p for p in r.json()["projectPerformance"]}
    assert projects[big]["totalUniqueTasks"] == 3
    assert projects[big]["completedUniqueTasks"] == 3
    assert projects[big]["completionRate"] == 100.0
    assert projects[big]["name"] == "Big Project"
    assert projects[small]["totalUniqueTasks"] == 1
    assert projects[small]["completedUniqueTasks"] == 0
    assert list(r.json()["projectPerformance"])[0]["projectId"] == big
    # No prior-period tasks for either project — nothing fabricated.
    assert projects[big]["trendPct"] is None


async def test_project_trend_compares_to_preceding_equal_length_window(db_app):
    project = await _project(ORG_A, SENDER, "Trending Project")
    assignee = _id()
    now = datetime.now(timezone.utc)

    # Previous 7-day window: one task, not completed (0% completion then).
    prev = await _task(ORG_A, SENDER, created_at=now - timedelta(days=10), project_id=project)
    await _assignee_row(ORG_A, prev, assignee, "SENT")

    # Current 7-day window: one task, completed (100% completion now).
    cur = await _task(ORG_A, SENDER, created_at=now - timedelta(days=1), project_id=project)
    await _assignee_row(ORG_A, cur, assignee, "COMPLETED")

    today = _today()
    r = await _get(SENDER, **{"from": (today - timedelta(days=6)).isoformat(), "to": today.isoformat()})
    body = r.json()
    row = next(p for p in body["projectPerformance"] if p["projectId"] == project)
    assert row["completionRate"] == 100.0
    assert row["trendPct"] == pytest.approx(100.0)


async def test_tasks_without_a_project_are_excluded_from_the_ranking(db_app):
    unassigned = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, unassigned, _id(), "COMPLETED")

    r = await _get(SENDER)
    body = r.json()
    assert body["completion"]["totalUniqueTasks"] == 1
    assert body["projectPerformance"] == []


async def test_per_person_workload(db_app):
    a, b = _id(), _id()
    t1 = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, t1, a, "COMPLETED")
    t2 = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, t2, a, "SENT")
    await _assignee_row(ORG_A, t2, b, "ACKNOWLEDGED")

    r = await _get(SENDER)
    workload = {w["assigneeId"]: w for w in r.json()["workload"]}
    assert workload[a]["assignedCount"] == 2
    assert workload[a]["completedCount"] == 1
    assert workload[a]["inProgressCount"] == 1
    assert workload[b]["assignedCount"] == 1
    assert workload[b]["inProgressCount"] == 1


async def test_non_admin_workload_excludes_other_members(db_app):
    """A non-admin SENDER must not see another assignee's individual workload,
    even for tasks they themselves sent — only their own assignee row (or none)."""
    other_assignee = _id()
    t1 = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, t1, other_assignee, "COMPLETED")
    t2 = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, t2, SENDER, "SENT")

    member_r = await _get(SENDER, roles=["member"])
    assert member_r.status_code == 200, member_r.text
    workload = {w["assigneeId"]: w for w in member_r.json()["workload"]}
    assert other_assignee not in workload
    assert workload[SENDER]["assignedCount"] == 1

    admin_r = await _get(SENDER, roles=["org_admin"])
    admin_workload = {w["assigneeId"]: w for w in admin_r.json()["workload"]}
    assert other_assignee in admin_workload
    assert SENDER in admin_workload


async def test_non_admin_with_no_own_assignments_sees_empty_workload(db_app):
    """A non-admin who only sends tasks to others (never assigned themselves)
    gets an empty workload list, not someone else's rows."""
    other_assignee = _id()
    t = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, t, other_assignee, "COMPLETED")

    r = await _get(SENDER, roles=["member"])
    assert r.status_code == 200, r.text
    assert r.json()["workload"] == []


async def test_project_filter_scopes_every_section(db_app):
    proj_a = await _project(ORG_A, SENDER, "Project A")
    proj_b = await _project(ORG_A, SENDER, "Project B")
    assignee = _id()
    t1 = await _task(ORG_A, SENDER, project_id=proj_a)
    await _assignee_row(ORG_A, t1, assignee, "COMPLETED")
    t2 = await _task(ORG_A, SENDER, project_id=proj_b)
    await _assignee_row(ORG_A, t2, assignee, "SENT")

    r = await _get(SENDER, projectId=proj_a)
    body = r.json()
    assert body["completion"]["totalUniqueTasks"] == 1
    assert body["completion"]["completedUniqueTasks"] == 1
    assert [p["projectId"] for p in body["projectPerformance"]] == [proj_a]


async def test_date_range_filters_by_task_created_at(db_app):
    assignee = _id()
    old = await _task(ORG_A, SENDER, created_at=datetime.now(timezone.utc) - timedelta(days=60))
    await _assignee_row(ORG_A, old, assignee, "COMPLETED")
    recent = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, recent, assignee, "COMPLETED")

    r = await _get(SENDER, **{"from": _today().isoformat(), "to": _today().isoformat()})
    assert r.json()["completion"]["totalUniqueTasks"] == 1

    r = await _get(
        SENDER,
        **{"from": (_today() - timedelta(days=90)).isoformat(), "to": _today().isoformat()},
    )
    assert r.json()["completion"]["totalUniqueTasks"] == 2


async def test_daily_activity_buckets_by_completed_at_day(db_app):
    assignee = _id()
    t = await _task(ORG_A, SENDER)
    completed_at = datetime.now(timezone.utc)
    await _assignee_row(ORG_A, t, assignee, "COMPLETED", completed_at=completed_at)

    r = await _get(SENDER, **{"from": _today().isoformat(), "to": _today().isoformat()})
    body = r.json()
    daily = {d["day"]: d for d in body["dailyActivity"]}
    today_key = _today().isoformat()
    assert today_key in daily
    assert daily[today_key]["tasksCreated"] == 1
    assert daily[today_key]["tasksCompleted"] == 1

    flow = {d["day"]: d for d in body["statusFlow"]}
    assert flow[today_key]["completed"] == 1
    assert flow[today_key]["sent"] == 1

    # The completed-event count also backs the "completed" KPI sparkline.
    assert body["kpis"]["completed"]["sparkline"] == [1]


async def test_status_flow_counts_missed_and_acknowledged_events_per_day(db_app):
    assignee = _id()
    now = datetime.now(timezone.utc)
    t1 = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, t1, assignee, "MISSED", missed_at=now)
    t2 = await _task(ORG_A, SENDER)
    await _assignee_row(ORG_A, t2, assignee, "ACKNOWLEDGED", acknowledged_at=now)

    r = await _get(SENDER, **{"from": _today().isoformat(), "to": _today().isoformat()})
    body = r.json()
    today_key = _today().isoformat()
    flow = {d["day"]: d for d in body["statusFlow"]}
    # Both rows were also SENT (assigned_at defaults to now() on insert).
    assert flow[today_key]["sent"] == 2
    assert flow[today_key]["missed"] == 1
    assert flow[today_key]["acknowledged"] == 1

    # missed_e/acknowledged_e double as the overdue/inProgress KPI sparklines.
    assert body["kpis"]["overdue"]["sparkline"] == [1]
    assert body["kpis"]["inProgress"]["sparkline"] == [1]


async def test_another_org_is_invisible(db_app):
    t = await _task(ORG_B, SENDER)
    await _assignee_row(ORG_B, t, _id(), "COMPLETED")

    r = await _get(SENDER, org=ORG_A)
    assert r.status_code == 200, r.text
    assert r.json()["completion"]["totalUniqueTasks"] == 0
