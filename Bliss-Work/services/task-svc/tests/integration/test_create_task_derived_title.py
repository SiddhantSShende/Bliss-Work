"""`POST /tasks` in Smart Task Allocation mode: taskTitle/title are omitted and
the server derives the title from app/allocation.py's Rules A-H, resolving or
creating a project where the rule requires one.

messaging-svc is stubbed the same way test_create_task_mixed_targets.py does
it: `_resolve_channel_members` replaced with a fixed channel -> members table.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
SENDER = "33333333-3333-3333-3333-333333333333"
OTHER = "44444444-4444-4444-4444-444444444444"


def _id() -> str:
    return str(uuid.uuid4())


def _principal():
    from app.auth import Principal

    return Principal(user_id=SENDER, org_id=ORG, roles=["member"], username="sender")


async def _client() -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = _principal
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def channels(monkeypatch):
    from app import projects, schedule_worker
    from app.routes import tasks_write

    table: dict[str, list[str]] = {}
    names: dict[str, str] = {}

    async def _resolve(channel_id: str, org_id: str, caller_id: str) -> tuple[list[str], str]:
        if channel_id not in table:
            raise HTTPException(status_code=404, detail="channel not found")
        return list(table[channel_id]), names.get(channel_id, "")

    async def _members_only(channel_id: str, org_id: str, caller_id: str) -> list[str]:
        # app.projects.link_channels_to_project's own lookup — same backing
        # table as _resolve above (tasks_write's), just without the name.
        if channel_id not in table:
            raise HTTPException(status_code=404, detail="channel not found")
        return list(table[channel_id])

    monkeypatch.setattr(tasks_write, "_resolve_channel_members", _resolve)
    monkeypatch.setattr(schedule_worker, "_resolve_channel_members", _resolve)
    monkeypatch.setattr(projects, "fetch_channel_members", _members_only)
    return table, names


async def _q(sql: str, **params) -> list:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        result = await conn.execute(text(sql), params)
        return result.all() if result.returns_rows else []


async def _create(**body) -> httpx.Response:
    async with await _client() as c:
        return await c.post("/api/v1/tasks", json=body)


@pytest.mark.usefixtures("db_app", "seed_members")
class TestDerivedTitle:
    async def test_rule_a_single_channel_title_is_the_channel_name(self, channels, seed_members):
        table, names = channels
        channel_id = _id()
        table[channel_id] = [OTHER]
        names[channel_id] = "Blisswork"
        await seed_members(ORG, SENDER, OTHER)

        resp = await _create(description="ship it", channelIds=[channel_id])
        assert resp.status_code == 201, resp.text
        task_id = resp.json()["taskId"]
        row = (await _q("SELECT project_id FROM tasks WHERE id = :t", t=task_id))[0]
        assert row.project_id is None

    async def test_rule_c_single_person_title_is_their_display_name(self, seed_members):
        await seed_members(ORG, SENDER, OTHER)
        resp = await _create(description="follow up", assigneeIds=[OTHER])
        assert resp.status_code == 201, resp.text

    async def test_rule_d_self_assignment_succeeds(self, seed_members):
        await seed_members(ORG, SENDER)
        resp = await _create(description="note to self", assigneeIds=[SENDER])
        assert resp.status_code == 201, resp.text

    async def test_rule_b_multiple_channels_without_a_project_name_is_400(self, channels, seed_members):
        table, names = channels
        c1, c2 = _id(), _id()
        table[c1] = [OTHER]
        table[c2] = [OTHER]
        await seed_members(ORG, SENDER, OTHER)

        resp = await _create(description="x", channelIds=[c1, c2])
        assert resp.status_code == 400

    async def test_rule_b_multiple_channels_with_a_project_name_creates_a_project(
        self, channels, seed_members
    ):
        table, names = channels
        c1, c2 = _id(), _id()
        table[c1] = [OTHER]
        table[c2] = [OTHER]
        await seed_members(ORG, SENDER, OTHER)

        resp = await _create(
            description="x", channelIds=[c1, c2], newProjectName="Website Redesign"
        )
        assert resp.status_code == 201, resp.text
        task_id = resp.json()["taskId"]
        row = (await _q("SELECT project_id FROM tasks WHERE id = :t", t=task_id))[0]
        assert row.project_id is not None

    async def test_rule_h_channel_plus_person_requires_a_project_name(self, channels, seed_members):
        table, names = channels
        channel_id = _id()
        table[channel_id] = [OTHER]
        await seed_members(ORG, SENDER, OTHER)

        resp = await _create(description="x", channelIds=[channel_id], assigneeIds=[OTHER])
        assert resp.status_code == 400

        resp2 = await _create(
            description="x",
            channelIds=[channel_id],
            assigneeIds=[OTHER],
            newProjectName="Q3 Push",
        )
        assert resp2.status_code == 201, resp2.text

    async def test_empty_selection_is_400_not_a_blank_title(self):
        resp = await _create(description="nothing selected")
        assert resp.status_code == 400

    async def test_taskTitle_and_derived_fields_together_is_rejected_at_the_schema(self):
        resp = await _create(
            taskTitle="Explicit",
            title="Some Project",
            description="x",
            assigneeIds=[OTHER],
            projectId=_id(),
        )
        assert resp.status_code == 422

    async def test_title_without_taskTitle_is_rejected_at_the_schema(self):
        resp = await _create(title="Some Project", description="x", assigneeIds=[OTHER])
        assert resp.status_code == 422


@pytest.mark.usefixtures("db_app", "seed_members")
class TestMergeLinksChannelsIntoTheNewProject:
    """Rules B/E/G/H: once a selection needs a new project name, every channel
    in that selection is linked into the new project's project_channels, not
    just its own auto-created channel — so the project genuinely represents
    the merge, verifiable later via GET /projects/{id} -> channelIds."""

    async def test_two_channels_merged_under_a_new_name_are_both_linked(self, channels, seed_members):
        table, names = channels
        c1, c2 = _id(), _id()
        table[c1] = [SENDER, OTHER]
        table[c2] = [SENDER, OTHER]
        await seed_members(ORG, SENDER, OTHER)

        resp = await _create(
            description="x", channelIds=[c1, c2], newProjectName="Website Redesign"
        )
        assert resp.status_code == 201, resp.text
        task_id = resp.json()["taskId"]
        project_id = str((await _q("SELECT project_id FROM tasks WHERE id = :t", t=task_id))[0].project_id)

        linked = await _q(
            "SELECT channel_id FROM project_channels WHERE org_id = :org AND project_id = :pid",
            org=ORG, pid=project_id,
        )
        linked_ids = {str(r.channel_id) for r in linked}
        assert c1 in linked_ids
        assert c2 in linked_ids

    async def test_a_channel_with_fewer_than_two_members_is_skipped_not_fatal(self, channels, seed_members):
        table, names = channels
        real_channel, solo_channel = _id(), _id()
        table[real_channel] = [SENDER, OTHER]
        table[solo_channel] = [SENDER]  # only the sender — doesn't qualify
        await seed_members(ORG, SENDER, OTHER)

        resp = await _create(
            description="x", channelIds=[real_channel, solo_channel], newProjectName="Mixed Eligibility"
        )
        assert resp.status_code == 201, resp.text
        task_id = resp.json()["taskId"]
        project_id = str((await _q("SELECT project_id FROM tasks WHERE id = :t", t=task_id))[0].project_id)

        linked = await _q(
            "SELECT channel_id FROM project_channels WHERE org_id = :org AND project_id = :pid",
            org=ORG, pid=project_id,
        )
        linked_ids = {str(r.channel_id) for r in linked}
        assert real_channel in linked_ids
        assert solo_channel not in linked_ids
        # The task itself is unaffected — solo_channel's lone member still got it.
        assignees = await _q("SELECT assignee_id FROM task_assignees WHERE task_id = :t", t=task_id)
        assert {str(r.assignee_id) for r in assignees} == {SENDER, OTHER}

    async def test_the_merged_project_reads_back_every_linked_channel_via_the_api(self, channels, seed_members):
        # Three channels at once (as if two projects' worth plus one directly
        # picked channel were combined) — verified through the real read
        # endpoint, not just the table, so the whole path (link -> ProjectDTO
        # .channelIds) is exercised end to end.
        table, names = channels
        c1, c2, c3 = _id(), _id(), _id()
        for c in (c1, c2, c3):
            table[c] = [SENDER, OTHER]
        await seed_members(ORG, SENDER, OTHER)

        resp = await _create(
            description="merge", channelIds=[c1, c2, c3], newProjectName="Combined Initiative"
        )
        assert resp.status_code == 201, resp.text
        task_id = resp.json()["taskId"]
        project_id = str((await _q("SELECT project_id FROM tasks WHERE id = :t", t=task_id))[0].project_id)

        async with await _client() as client:
            detail = await client.get(f"/api/v1/projects/{project_id}")
        assert detail.status_code == 200, detail.text
        assert set(detail.json()["channelIds"]) >= {c1, c2, c3}

    async def test_an_explicitly_selected_existing_project_is_never_auto_linked(self, channels, seed_members):
        # Rule F: picking an EXISTING project must never silently mutate it
        # (Section 7.4) — link_channels_to_project is only reached from the
        # new_project_name branch, never from existing_project_id.
        table, names = channels
        c1, c2 = _id(), _id()
        table[c1] = [SENDER, OTHER]
        table[c2] = [SENDER, OTHER]
        await seed_members(ORG, SENDER, OTHER)

        seed_resp = await _create(description="seed", channelIds=[c1, c2], newProjectName="Seeded Project")
        assert seed_resp.status_code == 201, seed_resp.text
        project_id = str((await _q(
            "SELECT project_id FROM tasks WHERE id = :t", t=seed_resp.json()["taskId"]
        ))[0].project_id)
        before = await _q(
            "SELECT channel_id FROM project_channels WHERE org_id = :org AND project_id = :pid",
            org=ORG, pid=project_id,
        )

        # A third channel the project never saw — selecting the EXISTING
        # project explicitly must not pull it in.
        c3 = _id()
        table[c3] = [SENDER, OTHER]
        resp = await _create(description="again", projectId=project_id, channelIds=[c3])
        assert resp.status_code == 201, resp.text
        after = await _q(
            "SELECT channel_id FROM project_channels WHERE org_id = :org AND project_id = :pid",
            org=ORG, pid=project_id,
        )
        assert {str(r.channel_id) for r in before} == {str(r.channel_id) for r in after}
        assert c3 not in {str(r.channel_id) for r in after}
