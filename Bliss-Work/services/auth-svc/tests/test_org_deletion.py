"""Org deletion: the invariants that keep it from firing by accident.

The QA report asked for an org to be auto-deleted once its last member was
removed. It is not built that way, and these tests pin the reasons rather than
just the code — every one of them would pass silently if someone later
"simplified" this into the automatic version.

The purge itself (seven databases, a blob volume, an event) is integration
territory. What is testable here is the shape of the decision: the table lists
are ordered so a partial run cannot dangle, the grace period is real, and the
confirmation is not a formality.
"""
from __future__ import annotations

import pytest

purge_orgs = pytest.importorskip(
    "app.jobs.purge_orgs",
    reason="auth-svc deps (fastapi/pydantic) not installed locally; CI installs requirements.txt.",
)
config = pytest.importorskip("app.config")
schemas = pytest.importorskip("app.schemas")
members_service = pytest.importorskip("app.routes.members_service")


# ── the invariant that makes auto-delete unreachable ─────────────────────────
def test_the_last_admin_still_cannot_be_removed():
    # If this ever returns False, "remove every member" becomes reachable — and
    # the whole argument for explicit deletion rests on it not being.
    assert members_service.would_orphan_org({"alice"}, "alice") is True


def test_removing_a_member_never_reaches_the_purge():
    # The orphan case is DETECTED, not acted on. members_service must not have
    # any path into the purge job — if it grows one, auto-delete is back in
    # through the side door and this is the test that says so.
    import inspect

    src = inspect.getsource(members_service)
    assert "purge_orgs" not in src
    assert "purge_org" not in src


# ── the grace period is real ─────────────────────────────────────────────────
def test_the_grace_period_is_at_least_a_day():
    # Below a day there is no nightly backup taken while the data still existed,
    # and no chance for a human to notice on the next working day. Both are the
    # point of having a grace period at all.
    assert config.settings.org_delete_grace_days >= 1


# ── confirmation is typed, not a boolean ─────────────────────────────────────
def test_delete_requires_a_slug_not_a_flag():
    fields = schemas.DeleteOrgRequest.model_fields
    assert "slug" in fields
    assert fields["slug"].annotation is str


def test_a_missing_slug_is_rejected_by_the_schema():
    with pytest.raises(Exception):
        schemas.DeleteOrgRequest()


# ── purge ordering ───────────────────────────────────────────────────────────
def test_users_are_deleted_after_everything_that_references_them():
    # Nothing here has ON DELETE CASCADE, so this order is the only thing
    # keeping a purge from failing halfway on a dangling reference.
    stmts = purge_orgs.PURGE_STATEMENTS
    users_at = next(i for i, s in enumerate(stmts) if s.startswith("DELETE FROM users"))
    for i, s in enumerate(stmts):
        if "SELECT id FROM users" in s or "user_roles" in s:
            assert i < users_at, f"{s!r} reads users but runs after they are deleted"


def test_identities_are_cleared_but_never_deleted():
    # One identity is the credential shared across every org a person belongs
    # to. Deleting it here would lock them out of workspaces this org has no
    # authority over — the same boundary members.py refuses to cross.
    joined = " ".join(purge_orgs.PURGE_STATEMENTS)
    assert "UPDATE identities" in joined
    assert "DELETE FROM identities" not in joined


def test_the_purge_job_exits_non_zero_when_it_fails(monkeypatch):
    # A swallowed failure is indistinguishable from "nothing was due", and the
    # difference is whether an erasure request was actually honoured.
    def boom(coro, *_a, **_k):
        # Close the coroutine we are refusing to run, or Python warns about it
        # never being awaited and the real assertion gets lost in the noise.
        coro.close()
        raise RuntimeError("database is gone")

    monkeypatch.setattr(purge_orgs.asyncio, "run", boom)
    monkeypatch.setattr(purge_orgs.sys, "argv", ["purge_orgs"])
    with pytest.raises(SystemExit) as exc:
        purge_orgs.main()
    assert exc.value.code == 1
