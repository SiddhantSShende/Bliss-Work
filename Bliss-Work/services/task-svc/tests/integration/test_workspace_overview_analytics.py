"""GET /tasks/analytics/overview — org-wide rollup behind the Workspace
Analytics dashboard: KPI totals, per-channel ranking, per-person workload,
and a day-bucketed activity series.

org_admin only (OrgAdminDep) — unlike the per-task/per-channel/per-project
analytics endpoints, which each require the caller to already be a party to
what they're asking about, this aggregates every channel and every member in
the org regardless of the caller's own channel membership.
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


async def _task(org: str, sender: str, title: str = "Task", created_at: datetime | None = None) -> str:
    from app.db import session, set_org_context
    from crypto import cryptor

    task_id = _id()
    async with session() as db:
        await set_org_context(db, org)
        enc = await cryptor().encrypt(db, org, title)
        if created_at is None:
            await db.execute(
                text("INSERT INTO tasks (id, org_id, sender_id, title_enc) VALUES (:t, :o, :s, :e)"),
                {"t": task_id, "o": org, "s": sender, "e": enc},
            )
        else:
            await db.execute(
                text(
                    "INSERT INTO tasks (id, org_id, sender_id, title_enc, created_at) "
                    "VALUES (:t, :o, :s, :e, :c)"
                ),
                {"t": task_id, "o": org, "s": sender, "e": enc, "c": created_at},
            )
        await db.commit()
    return task_id


async def _attach_channel(org: str, task_id: str, channel_id: str) -> None:
    from app.db import session, set_org_context

    async with session() as db:
        await set_org_context(db, org)
        await db.execute(
            text("INSERT INTO task_channels (task_id, org_id, channel_id) VALUES (:t, :o, :c)"),
            {"t": task_id, "o": org, "c": channel_id},
        )
        await db.commit()


async def _assignee_row(
    org: str,
    task_id: str,
    assignee_id: str,
    status: str,
    completed_at: datetime | None = None,
) -> None:
    from app.db import session, set_org_context

    assert status in ("SENT", "IGNORED", "ACKNOWLEDGED", "COMPLETED", "LEFT", "MISSED")
    async with session() as db:
        await set_org_context(db, org)
        await db.execute(
            text(
                "INSERT INTO task_assignees (task_id, org_id, assignee_id, status, completed_at) "
                f"VALUES (:t, :o, :a, '{status}', :ca)"
            ),
            {"t": task_id, "o": org, "a": assignee_id, "ca": completed_at},
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


async def test_non_admin_is_rejected(db_app):
    r = await _get(SENDER, roles=["member"])
    assert r.status_code == 403


async def test_empty_org_is_all_zero_not_divide_by_zero(db_app):
    r = await _get(SENDER)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["completion"]["totalUniqueTasks"] == 0
    assert body["completion"]["uniqueTaskCompletionRate"] == 0.0
    assert body["overdueUniqueTasks"] == 0
    assert body["inProgressUniqueTasks"] == 0
    assert body["workload"] == []
    assert body["channels"] == []


async def test_kpi_totals_completed_overdue_in_progress(db_app):
    ch = _id()
    assignee = _id()

    # Completed task.
    t1 = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t1, ch)
    await _assignee_row(ORG_A, t1, assignee, "COMPLETED", completed_at=datetime.now(timezone.utc))

    # Overdue task (one MISSED row).
    t2 = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t2, ch)
    await _assignee_row(ORG_A, t2, assignee, "MISSED")

    # Plain in-progress task.
    t3 = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t3, ch)
    await _assignee_row(ORG_A, t3, assignee, "SENT")

    # Abandoned task — excluded from all four KPIs.
    t4 = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t4, ch)
    await _assignee_row(ORG_A, t4, assignee, "LEFT")

    r = await _get(SENDER)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["completion"]["totalUniqueTasks"] == 4
    assert body["completion"]["completedUniqueTasks"] == 1
    assert body["completion"]["abandonedUniqueTasks"] == 1
    assert body["overdueUniqueTasks"] == 1
    assert body["inProgressUniqueTasks"] == 1


async def test_channel_ranking_sorted_by_total_desc(db_app):
    big, small = _id(), _id()
    assignee = _id()
    for _ in range(3):
        t = await _task(ORG_A, SENDER)
        await _attach_channel(ORG_A, t, big)
        await _assignee_row(ORG_A, t, assignee, "COMPLETED")
    t = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t, small)
    await _assignee_row(ORG_A, t, assignee, "SENT")

    r = await _get(SENDER)
    channels = {c["channelId"]: c for c in r.json()["channels"]}
    assert channels[big]["totalUniqueTasks"] == 3
    assert channels[big]["completedUniqueTasks"] == 3
    assert channels[big]["completionRate"] == 100.0
    assert channels[small]["totalUniqueTasks"] == 1
    assert channels[small]["completedUniqueTasks"] == 0
    assert list(r.json()["channels"])[0]["channelId"] == big


async def test_per_person_workload(db_app):
    ch = _id()
    a, b = _id(), _id()
    t1 = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t1, ch)
    await _assignee_row(ORG_A, t1, a, "COMPLETED")
    t2 = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t2, ch)
    await _assignee_row(ORG_A, t2, a, "SENT")
    await _assignee_row(ORG_A, t2, b, "ACKNOWLEDGED")

    r = await _get(SENDER)
    workload = {w["assigneeId"]: w for w in r.json()["workload"]}
    assert workload[a]["assignedCount"] == 2
    assert workload[a]["completedCount"] == 1
    assert workload[a]["inProgressCount"] == 1
    assert workload[b]["assignedCount"] == 1
    assert workload[b]["inProgressCount"] == 1


async def test_channel_filter_scopes_every_section(db_app):
    ch_a, ch_b = _id(), _id()
    assignee = _id()
    t1 = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t1, ch_a)
    await _assignee_row(ORG_A, t1, assignee, "COMPLETED")
    t2 = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t2, ch_b)
    await _assignee_row(ORG_A, t2, assignee, "SENT")

    r = await _get(SENDER, channelId=ch_a)
    body = r.json()
    assert body["completion"]["totalUniqueTasks"] == 1
    assert body["completion"]["completedUniqueTasks"] == 1
    assert [c["channelId"] for c in body["channels"]] == [ch_a]


async def test_date_range_filters_by_task_created_at(db_app):
    ch = _id()
    assignee = _id()
    old = await _task(ORG_A, SENDER, created_at=datetime.now(timezone.utc) - timedelta(days=60))
    await _attach_channel(ORG_A, old, ch)
    await _assignee_row(ORG_A, old, assignee, "COMPLETED")
    recent = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, recent, ch)
    await _assignee_row(ORG_A, recent, assignee, "COMPLETED")

    r = await _get(SENDER, **{"from": _today().isoformat(), "to": _today().isoformat()})
    assert r.json()["completion"]["totalUniqueTasks"] == 1

    r = await _get(
        SENDER,
        **{"from": (_today() - timedelta(days=90)).isoformat(), "to": _today().isoformat()},
    )
    assert r.json()["completion"]["totalUniqueTasks"] == 2


async def test_daily_activity_buckets_by_completed_at_day(db_app):
    ch = _id()
    assignee = _id()
    t = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t, ch)
    completed_at = datetime.now(timezone.utc)
    await _assignee_row(ORG_A, t, assignee, "COMPLETED", completed_at=completed_at)

    r = await _get(SENDER, **{"from": _today().isoformat(), "to": _today().isoformat()})
    daily = {d["day"]: d for d in r.json()["dailyActivity"]}
    today_key = _today().isoformat()
    assert today_key in daily
    assert daily[today_key]["tasksCreated"] == 1
    assert daily[today_key]["tasksCompleted"] == 1


async def test_another_org_is_invisible(db_app):
    ch = _id()
    t = await _task(ORG_B, SENDER)
    await _attach_channel(ORG_B, t, ch)
    await _assignee_row(ORG_B, t, _id(), "COMPLETED")

    r = await _get(SENDER, org=ORG_A)
    assert r.status_code == 200, r.text
    assert r.json()["completion"]["totalUniqueTasks"] == 0
