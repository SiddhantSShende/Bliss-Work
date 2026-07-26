"""The claim→task hop.

The single most important assertion in this file is that the idempotency key is
DERIVED from the activity id. That one property is what makes "task created but
the claim wasn't recorded" self-healing instead of a duplicate-task generator.
"""

import httpx
import pytest

from app import task_client
from app.task_client import (
    TaskServiceError,
    build_task_text,
    claim_idempotency_key,
    create_task,
)

ACT = "01919e8a-0000-7000-8000-000000000001"
ACT2 = "01919e8a-0000-7000-8000-000000000002"
USER = "11111111-1111-1111-1111-111111111111"


# ── idempotency key ───────────────────────────────────────────────────────────
def test_key_is_stable_across_calls():
    # Retry, re-click, second device — all must collapse onto one task.
    assert claim_idempotency_key(ACT) == claim_idempotency_key(ACT)


def test_key_differs_per_activity():
    assert claim_idempotency_key(ACT) != claim_idempotency_key(ACT2)


def test_key_is_a_uuid():
    import uuid

    uuid.UUID(claim_idempotency_key(ACT))  # raises if malformed


def test_key_is_pinned_so_a_refactor_cannot_silently_change_it():
    # If this value ever changes, every already-claimed mention would mint a
    # SECOND task on retry. Freeze it.
    assert claim_idempotency_key(ACT) == "0684d2af-7602-5739-b579-8a1cb644c130"


# ── task text ─────────────────────────────────────────────────────────────────
def test_title_is_the_first_line_of_the_body():
    title, _ = build_task_text(
        body="Can you review the deploy?\nthanks",
        provider="slack",
        peer="U1",
        occurred_at="2026-07-25T10:00:00Z",
        permalink=None,
    )
    assert title == "Can you review the deploy? thanks"


def test_title_is_truncated_to_120_chars():
    title, _ = build_task_text(
        body="x" * 500, provider="slack", peer="U1", occurred_at="t", permalink=None
    )
    assert len(title) == 120


def test_empty_body_falls_back_to_a_descriptive_title():
    title, _ = build_task_text(
        body="", provider="gmail", peer="boss@acme.com", occurred_at="t", permalink=None
    )
    assert title == "Gmail mention from boss@acme.com"


def test_description_carries_provenance_because_tasks_have_no_source_column():
    _, desc = build_task_text(
        body="please look",
        provider="slack",
        peer="U1",
        occurred_at="2026-07-25T10:00:00Z",
        permalink="https://slack.com/archives/x",
    )
    assert "please look" in desc
    assert "via slack" in desc
    assert "2026-07-25T10:00:00Z" in desc
    assert "https://slack.com/archives/x" in desc


def test_description_omits_a_missing_permalink_without_leaving_blank_padding():
    _, desc = build_task_text(
        body="hi", provider="slack", peer="U1", occurred_at="t", permalink=None
    )
    assert not desc.endswith("\n")


def test_huge_body_is_capped():
    _, desc = build_task_text(
        body="y" * 10_000, provider="slack", peer="U1", occurred_at="t", permalink=None
    )
    assert desc.count("y") == 4000


# ── HTTP behavior ─────────────────────────────────────────────────────────────
class _FakeClient:
    """Stands in for httpx.AsyncClient; records the request it was given."""

    def __init__(self, handler):
        self._handler = handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, **kw):
        return self._handler(url, kw)


def _patch(monkeypatch, handler):
    monkeypatch.setattr(task_client.httpx, "AsyncClient", lambda **_kw: _FakeClient(handler))


def _resp(status_code, payload=None):
    return httpx.Response(status_code, json=payload if payload is not None else {})


async def test_forwards_the_callers_bearer_and_the_derived_key(monkeypatch):
    seen = {}

    def handler(url, kw):
        seen["url"] = url
        seen["headers"] = kw["headers"]
        seen["json"] = kw["json"]
        return _resp(201, {"taskId": "task-1"})

    _patch(monkeypatch, handler)
    task_id = await create_task(
        bearer="Bearer abc", activity_id=ACT, title="t", description="d", assignee_id=USER
    )

    assert task_id == "task-1"
    assert seen["url"].endswith("/api/v1/tasks")
    # The caller's own token — task-svc authorizes the human, not this service.
    assert seen["headers"]["Authorization"] == "Bearer abc"
    assert seen["headers"]["Idempotency-Key"] == claim_idempotency_key(ACT)
    # Assigned to the claimer: "allocated to me".
    assert seen["json"]["assigneeIds"] == [USER]


async def test_accepts_200_as_well_as_201(monkeypatch):
    # task-svc returns the ORIGINAL task on a duplicate idempotency key.
    _patch(monkeypatch, lambda *_: _resp(200, {"taskId": "task-orig"}))
    assert (
        await create_task(
            bearer="B", activity_id=ACT, title="t", description="d", assignee_id=USER
        )
        == "task-orig"
    )


async def test_missing_taskid_is_an_error_not_a_silent_none(monkeypatch):
    _patch(monkeypatch, lambda *_: _resp(201, {}))
    with pytest.raises(TaskServiceError):
        await create_task(
            bearer="B", activity_id=ACT, title="t", description="d", assignee_id=USER
        )


@pytest.mark.parametrize("code", [400, 401, 403, 422])
async def test_4xx_is_definitive_and_not_retried(monkeypatch, code):
    calls = {"n": 0}

    def handler(*_):
        calls["n"] += 1
        return _resp(code, {"detail": "nope"})

    _patch(monkeypatch, handler)
    with pytest.raises(TaskServiceError):
        await create_task(
            bearer="B", activity_id=ACT, title="t", description="d", assignee_id=USER
        )
    assert calls["n"] == 1, "a rejected body must not burn the retry budget"


async def test_transport_failure_surfaces_as_taskserviceerror(monkeypatch):
    def handler(*_):
        raise httpx.ConnectError("refused")

    _patch(monkeypatch, handler)
    # The route turns this into a 502 and leaves the mention pending.
    with pytest.raises(TaskServiceError):
        await create_task(
            bearer="B", activity_id=ACT, title="t", description="d", assignee_id=USER
        )
