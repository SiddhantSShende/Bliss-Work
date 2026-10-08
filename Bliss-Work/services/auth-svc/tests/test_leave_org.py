"""Leaving an organization: who is allowed to, and what it does when they are.

`leave_org_tx` is the only self-service membership change in the product, and
the two refusals it carries are the interesting part. Both protect somebody who
would otherwise be stranded with no way back — an org with no admin left, or an
identity with no org left — and neither is repairable from inside the product,
which is exactly the shape of rule that is worth pinning without a database.

The collaborators that touch Postgres are stubbed. What is under test here is
the decision and the order it is made in, not the SQL.
"""
from __future__ import annotations

import pytest

HTTPException = pytest.importorskip("fastapi").HTTPException
members_service = pytest.importorskip(
    "app.routes.members_service",
    reason="auth-svc deps (fastapi/pydantic) not installed locally; CI installs requirements.txt.",
)

IDENTITY = "identity-1"
ORG_A, ORG_B = "org-a", "org-b"
ME_IN_A, ME_IN_B, COLLEAGUE = "me-in-a", "me-in-b", "colleague"


def _membership(org_id: str, user_id: str, *roles: str) -> dict:
    return {"userId": user_id, "orgId": org_id, "orgName": org_id, "roles": list(roles)}


@pytest.fixture
def leaving(monkeypatch):
    """Call `leave_org_tx` against stubbed I/O; report what it wrote."""
    written: dict = {}

    async def _noop(*_args, **_kwargs) -> None:
        return None

    async def _apply_status(_conn, org_id, user_id, new_status):
        written["status"] = (org_id, user_id, new_status)

    async def _audit(_conn, **kwargs):
        written["audit"] = kwargs

    async def _emit(_conn, org_id, actor_id, event_type, user_id, **_extra):
        written["event"] = (org_id, actor_id, event_type, user_id)

    monkeypatch.setattr(members_service, "_lock_identity", _noop)
    monkeypatch.setattr(members_service, "_lock_org_admins", _noop)
    monkeypatch.setattr(members_service, "_apply_status", _apply_status)
    monkeypatch.setattr(members_service, "_emit", _emit)
    monkeypatch.setattr(members_service, "_note_if_orphaned", _noop)
    monkeypatch.setattr(members_service.service, "write_audit", _audit)

    async def _call(memberships: list[dict], admins: set[str], org_id: str = ORG_A):
        async def _memberships_for_identity(_conn, _identity_id):
            return memberships

        async def _active_admin_ids(_conn, _org_id):
            return admins

        monkeypatch.setattr(
            members_service.service, "memberships_for_identity", _memberships_for_identity
        )
        monkeypatch.setattr(members_service, "_active_admin_ids", _active_admin_ids)
        return await members_service.leave_org_tx(None, IDENTITY, org_id)

    # Exposed so a test can assert on what a REFUSED leave wrote (nothing).
    _call.written = written
    return _call


async def test_member_of_two_orgs_can_leave_one(leaving):
    user_id = await leaving(
        [_membership(ORG_A, ME_IN_A, "member"), _membership(ORG_B, ME_IN_B, "member")],
        admins={COLLEAGUE},
    )
    written = leaving.written
    assert user_id == ME_IN_A
    # Removed, not deleted: history keeps pointing at this row, and a re-invite
    # has to be able to bring it back.
    assert written["status"] == (ORG_A, ME_IN_A, "removed")
    assert written["audit"]["action"] == "member.left"
    # Audited against the membership being given up, NOT the one the caller is
    # signed in to — audit_log is per-org, and those are two different users rows.
    assert written["audit"]["org_id"] == ORG_A
    assert written["audit"]["actor_id"] == ME_IN_A
    assert written["event"] == (ORG_A, ME_IN_A, "user.removed", ME_IN_A)


async def test_an_admin_can_leave_while_another_admin_remains(leaving):
    user_id = await leaving(
        [
            _membership(ORG_A, ME_IN_A, "org_admin"),
            _membership(ORG_B, ME_IN_B, "member"),
        ],
        admins={ME_IN_A, COLLEAGUE},
    )
    assert user_id == ME_IN_A
    assert leaving.written["status"] == (ORG_A, ME_IN_A, "removed")


async def test_the_last_admin_cannot_leave(leaving):
    with pytest.raises(HTTPException) as exc:
        await leaving(
            [
                _membership(ORG_A, ME_IN_A, "org_admin"),
                _membership(ORG_B, ME_IN_B, "member"),
            ],
            admins={ME_IN_A},
        )
    assert getattr(exc.value, "status_code", None) == 409
    assert "last admin" in str(exc.value.detail)


async def test_the_only_membership_cannot_be_left(leaving):
    # Refused even though this member is not an admin and orphans nothing: the
    # identity would have nowhere left to sign in and nobody able to re-invite it.
    with pytest.raises(HTTPException) as exc:
        await leaving([_membership(ORG_A, ME_IN_A, "member")], admins={COLLEAGUE})
    assert getattr(exc.value, "status_code", None) == 409
    assert "only organization" in str(exc.value.detail)


async def test_leaving_an_org_you_do_not_belong_to_is_a_404(leaving):
    with pytest.raises(HTTPException) as exc:
        await leaving(
            [_membership(ORG_B, ME_IN_B, "member")], admins=set(), org_id=ORG_A
        )
    assert getattr(exc.value, "status_code", None) == 404


async def test_a_refused_leave_writes_nothing(leaving):
    with pytest.raises(HTTPException):
        await leaving([_membership(ORG_A, ME_IN_A, "member")], admins={COLLEAGUE})
    # Every guard runs before the first write, so a refusal is a no-op rather
    # than a half-applied removal that only the caller's rollback undoes.
    assert leaving.written == {}
