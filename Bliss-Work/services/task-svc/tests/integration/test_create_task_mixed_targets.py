"""`POST /tasks` allocating to people, channels, or BOTH — always ONE task.

A task's recipients are the people named plus the current members of every channel
named, each person once (task_assignees is keyed (task_id, assignee_id)). The
channels stay attached to the task (task_channels) rather than being flattened
into assignees, so a member who joins a channel later is still added to it.

messaging-svc is the only collaborator stubbed: `_resolve_channel_members` is
replaced with a fixed channel -> members table, since that is a network call to a
service this suite does not run. Everything else — schema, RLS, the batched
inserts, the consumer, the schedule worker — is the real code on a real Postgres.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
SENDER = "33333333-3333-3333-3333-333333333333"


def _id() -> str:
    return str(uuid.uuid4())


def _principal():
    from app.auth import Principal

    return Principal(user_id=SENDER, org_id=ORG, roles=["member"], username="sender")


async def _client(principal=None) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = principal or _principal
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


class _ChannelsTable(dict):
    """channel id -> members table, plus a parallel `names` table (channel id ->
    display name) for tests that assert on the channelName tagged onto
    channel-sourced task.assigned events. Unnamed channels resolve to ""."""

    def __init__(self) -> None:
        super().__init__()
        self.names: dict[str, str] = {}


@pytest.fixture
def channels(monkeypatch):
    """channel id -> what messaging-svc answers, served in place of it: a list of
    member ids, "dead" (404 — deleted, or the sender is no longer in it) or "down"
    (503 — messaging-svc unreachable)."""
    from fastapi import HTTPException

    from app import schedule_worker
    from app.routes import tasks_write

    table = _ChannelsTable()

    async def _resolve(channel_id: str, org_id: str, caller_id: str) -> tuple[list[str], str]:
        answer = table[channel_id]
        if answer == "dead":
            raise HTTPException(status_code=404, detail="channel not found")
        if answer == "down":
            raise HTTPException(status_code=503, detail="messaging service unreachable")
        return list(answer), table.names.get(channel_id, "")

    # The create path and the schedule worker each bound the name at import.
    monkeypatch.setattr(tasks_write, "_resolve_channel_members", _resolve)
    monkeypatch.setattr(schedule_worker, "_resolve_channel_members", _resolve)
    return table


async def _q(sql: str, **params) -> list:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        return (await conn.execute(text(sql), params)).all()


async def _task_count() -> int:
    return (await _q("SELECT count(*) AS n FROM tasks WHERE org_id = :o", o=ORG))[0].n


async def _assignees(task_id: str) -> list[str]:
    rows = await _q("SELECT assignee_id FROM task_assignees WHERE task_id = :t", t=task_id)
    return sorted(str(r.assignee_id) for r in rows)


async def _task_channels(task_id: str) -> list[str]:
    rows = await _q("SELECT channel_id FROM task_channels WHERE task_id = :t", t=task_id)
    return sorted(str(r.channel_id) for r in rows)


def _payload(row) -> dict:
    import json

    return json.loads(row.payload) if isinstance(row.payload, str) else row.payload


async def _assigned_events(task_id: str) -> list[str]:
    rows = await _q("SELECT payload FROM outbox WHERE kafka_key = :t", t=task_id)
    return sorted(_payload(r)["assigneeId"] for r in rows)


async def _assigned_event_by_assignee(task_id: str, assignee_id: str) -> dict:
    rows = await _q("SELECT payload FROM outbox WHERE kafka_key = :t", t=task_id)
    for r in rows:
        payload = _payload(r)
        if payload["assigneeId"] == assignee_id:
            return payload
    raise AssertionError(f"no task.assigned event for {assignee_id}")


async def _create(**body) -> httpx.Response:
    async with await _client() as c:
        return await c.post("/api/v1/tasks", json={"title": "Review report", **body})


# 1 ──────────────────────────────────────────────────────────────────────────
async def test_people_only_is_one_task_with_no_channels(db_app, seed_members, channels):
    a, b = _id(), _id()
    await seed_members(ORG, a, b)

    r = await _create(assigneeIds=[a, b])

    assert r.status_code == 201, r.text
    task_id = r.json()["taskId"]
    assert await _task_count() == 1
    assert await _assignees(task_id) == sorted([a, b])
    assert await _task_channels(task_id) == []
    assert (await _q("SELECT channel_id FROM tasks WHERE id = :t", t=task_id))[0].channel_id is None


# 2 ──────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("field", ["channelId", "channelIds"])
async def test_channel_only_is_one_task_attached_to_the_channel(db_app, channels, field):
    c, m1, m2 = _id(), _id(), _id()
    channels[c] = [m1, m2]

    r = await _create(**{field: c if field == "channelId" else [c]})

    assert r.status_code == 201, r.text
    task_id = r.json()["taskId"]
    assert await _task_count() == 1
    assert await _assignees(task_id) == sorted([m1, m2])
    assert await _task_channels(task_id) == [c]
    # The legacy single-channel column mirrors the (only) channel.
    assert str((await _q("SELECT channel_id FROM tasks WHERE id = :t", t=task_id))[0].channel_id) == c


# 3 ──────────────────────────────────────────────────────────────────────────
async def test_mixed_people_and_channel_is_exactly_one_task(db_app, seed_members, channels):
    a, b, c, m1, m2 = _id(), _id(), _id(), _id(), _id()
    await seed_members(ORG, a, b)
    channels[c] = [m1, m2]

    r = await _create(assigneeIds=[a, b], channelId=c)

    assert r.status_code == 201, r.text
    task_id = r.json()["taskId"]
    assert await _task_count() == 1
    assert await _assignees(task_id) == sorted([a, b, m1, m2])
    # The channel is a real relationship, not flattened into the people.
    assert await _task_channels(task_id) == [c]
    assert await _assigned_events(task_id) == sorted([a, b, m1, m2])


# 4 ──────────────────────────────────────────────────────────────────────────
async def test_person_who_is_also_a_channel_member_is_one_task_and_one_recipient(db_app, seed_members, channels):
    a, c, m1 = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c] = [a, m1]

    r = await _create(assigneeIds=[a], channelId=c)

    assert r.status_code == 201, r.text
    task_id = r.json()["taskId"]
    assert await _task_count() == 1
    assert await _assignees(task_id) == sorted([a, m1])
    # One notification for A, not two.
    assert await _assigned_events(task_id) == sorted([a, m1])


async def test_overlap_is_deduplicated_across_uuid_casing(db_app, seed_members, channels):
    """The request accepts any UUID casing and messaging-svc returns lowercase. The
    same person in both spellings must still be one recipient — a duplicate would
    violate task_assignees' key and fail the whole create."""
    a, c = _id(), _id()
    await seed_members(ORG, a)
    channels[c] = [a]

    r = await _create(assigneeIds=[a.upper()], channelId=c)

    assert r.status_code == 201, r.text
    assert await _assignees(r.json()["taskId"]) == [a]


# 5 ──────────────────────────────────────────────────────────────────────────
async def test_multiple_channels_are_one_task_with_one_row_per_channel(db_app, seed_members, channels):
    a, c1, c2, only1, only2, shared = _id(), _id(), _id(), _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c1] = [only1, shared]
    channels[c2] = [only2, shared]

    r = await _create(assigneeIds=[a], channelIds=[c1, c2])

    assert r.status_code == 201, r.text
    task_id = r.json()["taskId"]
    assert await _task_count() == 1
    assert await _task_channels(task_id) == sorted([c1, c2])
    assert await _assignees(task_id) == sorted([a, only1, only2, shared])  # `shared` once


# channel attribution on task.assigned ───────────────────────────────────────
async def test_channel_only_recipient_event_carries_channel_id_and_name(db_app, channels):
    c, m = _id(), _id()
    channels.names[c] = "Engineering"
    channels[c] = [m]

    r = await _create(channelId=c)

    assert r.status_code == 201, r.text
    evt = await _assigned_event_by_assignee(r.json()["taskId"], m)
    assert evt["channelId"] == c
    assert evt["channelName"] == "Engineering"


async def test_named_person_event_has_no_channel_fields(db_app, seed_members, channels):
    """A named assignee's event never carries channel attribution, even for a
    task that ALSO has channels attached — they were asked for by name."""
    a, c, m = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c] = [m]

    r = await _create(assigneeIds=[a], channelId=c)

    assert r.status_code == 201, r.text
    evt = await _assigned_event_by_assignee(r.json()["taskId"], a)
    assert "channelId" not in evt
    assert "channelName" not in evt


async def test_person_also_in_the_channel_is_treated_as_named_not_channel(db_app, seed_members, channels):
    """Named intent wins: being named directly AND a member of the chosen
    channel must not tag the event as channel-sourced."""
    a, c, m = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c] = [a, m]

    r = await _create(assigneeIds=[a], channelId=c)

    assert r.status_code == 201, r.text
    task_id = r.json()["taskId"]
    assert "channelId" not in (await _assigned_event_by_assignee(task_id, a))
    assert (await _assigned_event_by_assignee(task_id, m))["channelId"] == c


async def test_member_of_two_channels_is_tagged_with_the_first_one(db_app, channels):
    c1, c2, shared = _id(), _id(), _id()
    channels.names[c1] = "Alpha"
    channels.names[c2] = "Beta"
    channels[c1] = [shared]
    channels[c2] = [shared]

    r = await _create(channelIds=[c1, c2])

    assert r.status_code == 201, r.text
    evt = await _assigned_event_by_assignee(r.json()["taskId"], shared)
    assert evt["channelId"] == c1
    assert evt["channelName"] == "Alpha"


async def test_channelId_and_channelIds_merge_without_duplicating(db_app, channels):
    c1, c2, m = _id(), _id(), _id()
    channels[c1] = [m]
    channels[c2] = [m]

    r = await _create(channelId=c1, channelIds=[c1, c2.upper(), c2])

    assert r.status_code == 201, r.text
    assert await _task_channels(r.json()["taskId"]) == sorted([c1, c2])


async def test_too_many_channels_is_a_validation_error(db_app, channels):
    from app.schemas import MAX_CHANNELS_PER_TASK

    r = await _create(channelIds=[_id() for _ in range(MAX_CHANNELS_PER_TASK + 1)])

    assert r.status_code == 422, r.text
    assert await _task_count() == 0


# 6 ──────────────────────────────────────────────────────────────────────────
async def test_no_people_and_no_channel_is_rejected_and_writes_nothing(db_app, channels):
    for body in ({}, {"assigneeIds": [], "channelIds": []}, {"assigneeIds": [], "channelId": None}):
        r = await _create(**body)
        assert r.status_code == 400, r.text
        assert "at least one assignee" in r.json()["error"]["message"]
    assert await _task_count() == 0


async def test_only_empty_channels_is_rejected_and_writes_nothing(db_app, channels):
    c = _id()
    channels[c] = []

    r = await _create(channelIds=[c])

    assert r.status_code == 400, r.text
    assert await _task_count() == 0


async def test_empty_channel_plus_a_named_person_is_still_a_task(db_app, seed_members, channels):
    a, c = _id(), _id()
    await seed_members(ORG, a)
    channels[c] = []

    r = await _create(assigneeIds=[a], channelIds=[c])

    assert r.status_code == 201, r.text
    task_id = r.json()["taskId"]
    assert await _assignees(task_id) == [a]
    assert await _task_channels(task_id) == [c]  # a later joiner still lands on it


async def test_named_people_must_still_be_org_members_when_a_channel_is_also_named(db_app, channels):
    stranger, c, m = _id(), _id(), _id()  # `stranger` is in no org's projection
    channels[c] = [m]

    r = await _create(assigneeIds=[stranger], channelIds=[c])

    assert r.status_code == 400, r.text
    assert await _task_count() == 0


async def test_union_over_the_cap_is_rejected(db_app, seed_members, channels):
    from app.schemas import MAX_ASSIGNEES

    c1, c2 = _id(), _id()
    channels[c1] = [_id() for _ in range(MAX_ASSIGNEES // 2 + 1)]
    channels[c2] = [_id() for _ in range(MAX_ASSIGNEES // 2 + 1)]  # each fits; together they do not

    r = await _create(channelIds=[c1, c2])

    assert r.status_code == 400, r.text
    assert "too many assignees" in r.json()["error"]["message"]
    assert await _task_count() == 0


async def test_idempotent_replay_of_a_mixed_create_is_the_same_task(db_app, seed_members, channels):
    a, c, m = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c] = [m]
    body = {"title": "Once", "assigneeIds": [a], "channelIds": [c]}
    async with await _client() as cl:
        r1 = await cl.post("/api/v1/tasks", json=body, headers={"Idempotency-Key": "mixed-1"})
        r2 = await cl.post("/api/v1/tasks", json=body, headers={"Idempotency-Key": "mixed-1"})

    assert r1.json()["taskId"] == r2.json()["taskId"]
    assert await _task_count() == 1
    assert await _task_channels(r1.json()["taskId"]) == [c]


async def test_idempotency_key_is_scoped_to_sender(db_app, seed_members):
    from app.auth import Principal

    assignee = _id()
    await seed_members(ORG, assignee)
    body = {"title": "Actor-owned", "assigneeIds": [assignee]}

    def principal_b():
        return Principal(
            user_id="44444444-4444-4444-4444-444444444444",
            org_id=ORG,
            roles=["member"],
            username="sender-b",
        )

    async with await _client() as client_a:
        response_a = await client_a.post(
            "/api/v1/tasks",
            json=body,
            headers={"Idempotency-Key": "shared-key"},
        )
    async with await _client(principal_b) as client_b:
        response_b = await client_b.post(
            "/api/v1/tasks",
            json=body,
            headers={"Idempotency-Key": "shared-key"},
        )

    assert response_a.status_code == response_b.status_code == 201
    assert response_a.json()["taskId"] != response_b.json()["taskId"]
    assert await _task_count() == 2


async def test_idempotency_key_rejects_different_request_body(db_app, seed_members):
    assignee = _id()
    await seed_members(ORG, assignee)
    async with await _client() as client:
        first = await client.post(
            "/api/v1/tasks",
            json={"title": "Original", "assigneeIds": [assignee]},
            headers={"Idempotency-Key": "body-bound-key"},
        )
        replay = await client.post(
            "/api/v1/tasks",
            json={"title": "Different", "assigneeIds": [assignee]},
            headers={"Idempotency-Key": "body-bound-key"},
        )

    assert first.status_code == 201
    assert replay.status_code == 409
    assert "different request" in replay.json()["error"]["message"]
    assert await _task_count() == 1


# Later joiners ──────────────────────────────────────────────────────────────
async def _join(channel: str, user: str) -> None:
    from app.consumer import TaskSvcConsumer

    await TaskSvcConsumer()._handle_channel_member_joined(  # noqa: SLF001
        {"type": "channel.member.joined", "eventId": _id(), "orgId": ORG, "channelId": channel, "userId": user}
    )


async def test_joining_any_of_a_tasks_channels_adds_the_member_to_that_one_task(db_app, seed_members, channels):
    a, c1, c2, m = _id(), _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c1] = [m]
    channels[c2] = []
    task_id = (await _create(assigneeIds=[a], channelIds=[c1, c2])).json()["taskId"]

    late = _id()
    await _join(c2, late)  # the SECOND channel — the legacy column alone would miss it

    assert late in await _assignees(task_id)
    assert await _task_count() == 1
    # Joining again, or joining the other channel as the same person, adds no second row.
    await _join(c1, late)
    assert (await _assignees(task_id)).count(late) == 1


async def test_a_named_person_joining_the_tasks_channel_is_not_added_twice(db_app, seed_members, channels):
    a, c, m = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c] = [m]
    task_id = (await _create(assigneeIds=[a], channelIds=[c])).json()["taskId"]

    await _join(c, a)

    assert (await _assignees(task_id)).count(a) == 1
    assert len(await _assigned_events(task_id)) == 2  # a and m, from creation only


# Scheduled / recurring ──────────────────────────────────────────────────────
async def _schedule(**body) -> str:
    from datetime import datetime, timedelta, timezone

    when = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    r = await _create(allocation="SCHEDULED", scheduledFor=when, **body)
    assert r.status_code == 201, r.text
    return r.json()["scheduleId"]


async def test_scheduled_mixed_task_stores_both_targets_and_creates_no_task_yet(db_app, seed_members, channels):
    a, c1, c2 = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c1] = [_id()]
    channels[c2] = [_id()]

    schedule_id = await _schedule(assigneeIds=[a], channelIds=[c1, c2])

    row = (await _q("SELECT channel_id, channel_ids, assignee_ids FROM task_schedules WHERE id = :i", i=schedule_id))[0]
    assert [str(x) for x in row.assignee_ids] == [a]
    assert [str(x) for x in row.channel_ids] == [c1, c2]
    assert str(row.channel_id) == c1
    assert await _task_count() == 0


async def test_a_due_mixed_schedule_materializes_one_task_with_current_members(db_app, seed_members, channels):
    from app.schedule_worker import run_due_schedules_once

    a, c, m1 = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c] = [a, m1]
    schedule_id = await _schedule(assigneeIds=[a], channelIds=[c])
    channels[c] = [a, m1, _id()]  # someone joins before it fires: resolved at run time
    late_member = channels[c][2]
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text("UPDATE task_schedules SET next_run_at = now() - interval '1 minute' WHERE id = :i"),
            {"i": schedule_id},
        )

    assert await run_due_schedules_once() == 1

    assert await _task_count() == 1
    task_id = str((await _q("SELECT id FROM tasks WHERE schedule_id = :s", s=schedule_id))[0].id)
    assert await _assignees(task_id) == sorted([a, m1, late_member])
    assert await _task_channels(task_id) == [c]


async def test_schedule_list_reports_every_channel_and_the_named_people(db_app, seed_members, channels):
    a, c1, c2 = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c1] = [_id()]
    channels[c2] = [_id()]
    await _schedule(assigneeIds=[a], channelIds=[c1, c2])

    async with await _client() as cl:
        r = await cl.get("/api/v1/tasks/schedules")

    assert r.status_code == 200, r.text
    (item,) = r.json()
    assert item["channelIds"] == [c1, c2]
    assert item["channelId"] == c1
    assert [x["userId"] for x in item["assignees"]] == [a]


# Recurring, occurrences, late joiners, legacy rows ──────────────────────────
async def _make_due(schedule_id: str) -> None:
    """Make a schedule due now — one minute late, so a daily one yields exactly one
    occurrence rather than catching up on missed days."""
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text(
                "UPDATE task_schedules SET start_at = LEAST(start_at, now() - interval '1 minute'), "
                "next_run_at = now() - interval '1 minute' WHERE id = :i"
            ),
            {"i": schedule_id},
        )


async def test_a_recurring_mixed_schedule_keeps_every_channel_on_every_occurrence(db_app, seed_members, channels):
    from datetime import datetime, timedelta, timezone

    from app.schedule_worker import run_due_schedules_once

    a, c1, c2, m1, m2 = _id(), _id(), _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c1] = [a, m1]  # `a` is also in a channel: still one recipient per occurrence
    channels[c2] = [m2]
    start = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    r = await _create(
        allocation="RECURRING",
        recurrence={"startAt": start, "frequency": "DAILY", "interval": 1, "endCondition": "NO_END"},
        assigneeIds=[a],
        channelIds=[c1, c2],
    )
    assert r.status_code == 201, r.text
    schedule_id = r.json()["scheduleId"]

    for expected in (1, 2):
        await _make_due(schedule_id)
        assert await run_due_schedules_once() == 1
        assert await _task_count() == expected

    task_ids = [str(r.id) for r in await _q("SELECT id FROM tasks WHERE schedule_id = :s", s=schedule_id)]
    assert len(task_ids) == 2
    for task_id in task_ids:
        assert await _assignees(task_id) == sorted([a, m1, m2])
        assert await _task_channels(task_id) == sorted([c1, c2])
    sched = (await _q("SELECT status, occurrence_count FROM task_schedules WHERE id = :s", s=schedule_id))[0]
    assert (sched.status, sched.occurrence_count) == ("ACTIVE", 2)


async def test_a_member_joining_either_channel_after_an_occurrence_is_added_to_that_task(db_app, seed_members, channels):
    from app.schedule_worker import run_due_schedules_once

    a, c1, c2 = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c1] = [_id()]
    channels[c2] = [_id()]
    schedule_id = await _schedule(assigneeIds=[a], channelIds=[c1, c2])
    await _make_due(schedule_id)
    assert await run_due_schedules_once() == 1
    task_id = str((await _q("SELECT id FROM tasks WHERE schedule_id = :s", s=schedule_id))[0].id)

    late = _id()
    await _join(c2, late)

    assert late in await _assignees(task_id)


async def test_a_schedule_written_before_multi_channel_still_materializes_and_lists(db_app, channels):
    """Rows from before 012 (or from the previous release during a rolling deploy)
    have only the single `channel_id`, with `channel_ids` empty."""
    from app.db import get_engine
    from app.schedule_worker import run_due_schedules_once

    c, m = _id(), _id()
    channels[c] = [m]
    schedule_id = await _schedule(channelIds=[c])
    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(text("UPDATE task_schedules SET channel_ids = '{}' WHERE id = :i"), {"i": schedule_id})

    async with await _client() as cl:
        (item,) = (await cl.get("/api/v1/tasks/schedules")).json()
    assert item["channelIds"] == [c]
    assert item["channelId"] == c

    await _make_due(schedule_id)
    assert await run_due_schedules_once() == 1
    task_id = str((await _q("SELECT id FROM tasks WHERE schedule_id = :s", s=schedule_id))[0].id)
    assert await _assignees(task_id) == [m]
    assert await _task_channels(task_id) == [c]
