"""Phase 4: credit-commitment gating on invite accept / role change / removal.

billing_client's HTTP calls are mocked here — these tests are about auth-svc's
OWN ordering/compensation logic (gate before the tx, compensate on failure,
release after commit), not billing-svc's affordability math (covered by
billing-svc's own test_membership_commitment.py).
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app import billing_client, service
from app.routes import auth as auth_routes
from app.routes import invites as invites_routes
from app.routes import members as members_routes
from app.routing import placement
from app.schemas import AcceptInviteRequest, ChangeRoleRequest
from app.security.auth_dep import Principal
from crypto import cryptor, init_cryptor
from app.config import settings

pytestmark = pytest.mark.integration


@asynccontextmanager
async def _noop_failed_attempts():
    yield


@pytest.fixture(autouse=True)
def _stub_record_failed_attempts(monkeypatch: pytest.MonkeyPatch):
    """`service.record_failed_attempts` does not exist anywhere in this
    codebase today (see routes/account_service.py's own docstring: "neither
    of which exists in this codebase ... would raise AttributeError if that
    path were ever hit") — a pre-existing gap, unrelated to phase 4, that
    every route calling accept_invite/leave_org trips over. Stubbed here so
    these billing-wiring tests can exercise those routes without tripping
    an unrelated, already-known issue."""
    monkeypatch.setattr(service, "record_failed_attempts", _noop_failed_attempts, raising=False)


@pytest.fixture(autouse=True)
def _init_crypto():
    init_cryptor(settings)


@pytest.fixture(autouse=True)
def _jwt_signing_key(tmp_path, monkeypatch: pytest.MonkeyPatch):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from app.security import keys

    priv = Ed25519PrivateKey.generate()
    priv_path = tmp_path / "priv.pem"
    priv_path.write_bytes(
        priv.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    pub_path = tmp_path / "pub.pem"
    pub_path.write_bytes(
        priv.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    )
    monkeypatch.setattr(settings, "jwt_private_key_path", str(priv_path))
    monkeypatch.setattr(settings, "jwt_public_key_path", str(pub_path))
    keys._cached_private_key = None
    keys._cached_public_key = None


class _FakeRequest:
    client = None
    headers: dict = {}


def _id() -> str:
    return str(uuid.uuid4())


async def _seed_org(conn, name_suffix: str) -> str:
    org_id = _id()
    await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
    await conn.execute(
        text("INSERT INTO orgs (id, name, slug) VALUES (:id, :name, :slug)"),
        {"id": org_id, "name": f"Acme {name_suffix}", "slug": f"acme-{name_suffix}"},
    )
    return org_id


async def _role_id(conn, name: str) -> int:
    row = (await conn.execute(text("SELECT id FROM roles WHERE name = :n"), {"n": name})).first()
    return int(row.id)


async def _seed_active_member(conn, org_id: str, role: str, *, email: str | None = None) -> str:
    user_id = _id()
    email = email or f"{user_id}@example.com"
    await conn.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": org_id})
    email_enc = await cryptor().encrypt(conn, org_id, email)
    dn_enc = await cryptor().encrypt(conn, org_id, f"User {user_id[:8]}")
    await conn.execute(
        text(
            """
            INSERT INTO users (id, org_id, email_enc, email_bidx, username, password_hash,
                                display_name_enc, email_verified, status)
            VALUES (:id, :org, :email_enc, :bidx, :uname, 'x', :dn_enc, true, 'active')
            """
        ),
        {
            "id": user_id,
            "org": org_id,
            "email_enc": email_enc,
            "bidx": cryptor().blind_index(email),
            "uname": f"u-{user_id[:8]}",
            "dn_enc": dn_enc,
        },
    )
    rid = await _role_id(conn, role)
    await conn.execute(
        text("INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:u, :r, :o)"),
        {"u": user_id, "r": rid, "o": org_id},
    )
    return user_id


async def _seed_pending_invite(conn, org_id: str, email: str, role: str, token: str) -> None:
    role_id = await _role_id(conn, role)
    expires_at = datetime.now(timezone.utc) + timedelta(days=1)
    token_hash = service.sha256_bytes(token)
    await placement.record_invite_placement(conn, token_hash.hex(), home_site=settings.site_id, expires_at=expires_at)
    await conn.execute(
        text(
            """
            INSERT INTO invites (id, org_id, email, role_id, token_hash, invited_by, expires_at)
            VALUES (:id, :org, :email, :rid, :hash, :by, :exp)
            """
        ),
        {"id": _id(), "exp": expires_at, "org": org_id, "email": email, "rid": role_id, "hash": token_hash, "by": _id()},
    )


# ── invite accept ────────────────────────────────────────────────────────────


async def test_invite_accept_rejected_when_billing_denies_credit_blocks_user_creation(sa_engine, monkeypatch):
    monkeypatch.setattr(invites_routes, "engine", sa_engine)
    reserve = AsyncMock(side_effect=HTTPException(402, "insufficient credits"))
    monkeypatch.setattr(billing_client, "check_and_reserve_membership", reserve)

    token = service.new_refresh_secret()
    email = f"invite-{_id()}@example.com"
    async with sa_engine.begin() as conn:
        org_id = await _seed_org(conn, _id()[:8])
        await _seed_pending_invite(conn, org_id, email, "org_admin", token)

    body = AcceptInviteRequest(token=token, password="Valid-Password-123!", username="newadmin", displayName="New Admin")
    with pytest.raises(HTTPException) as exc_info:
        await invites_routes.accept_invite(body, _FakeRequest(), response=_FakeRequest())
    assert exc_info.value.status_code == 402
    reserve.assert_awaited_once()
    assert reserve.await_args.args[0] == org_id
    assert reserve.await_args.args[2] == "org_admin"

    async with sa_engine.begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        count = (
            await conn.execute(
                text("SELECT count(*) FROM users WHERE org_id = :o"), {"o": org_id}
            )
        ).scalar()
    assert count == 0  # no partially-provisioned membership


async def test_invite_accept_releases_reservation_when_tx_fails_after_billing_approved(sa_engine, monkeypatch):
    monkeypatch.setattr(invites_routes, "engine", sa_engine)
    reserve = AsyncMock(return_value=None)
    release = AsyncMock(return_value=None)
    monkeypatch.setattr(billing_client, "check_and_reserve_membership", reserve)
    monkeypatch.setattr(billing_client, "release_membership_commitment", release)

    token = service.new_refresh_secret()
    email = f"invite-{_id()}@example.com"
    async with sa_engine.begin() as conn:
        org_id = await _seed_org(conn, _id()[:8])
        # An ACTIVE member with this email already exists — accept_invite_tx's
        # own authoritative check (not my precheck) raises 409 here, AFTER the
        # billing reservation above already succeeded.
        await _seed_active_member(conn, org_id, "member", email=email)
        await _seed_pending_invite(conn, org_id, email, "member", token)

    body = AcceptInviteRequest(token=token, password="Valid-Password-123!", username="dup", displayName="Dup")
    with pytest.raises(HTTPException) as exc_info:
        await invites_routes.accept_invite(body, _FakeRequest(), response=_FakeRequest())
    assert exc_info.value.status_code == 409
    reserve.assert_awaited_once()
    release.assert_awaited_once()
    assert release.await_args.args[0] == org_id
    # Compensated for the SAME user_id the reservation was made against.
    assert release.await_args.args[1] == reserve.await_args.args[1]


# ── role change ──────────────────────────────────────────────────────────────


async def test_role_change_idempotent_noop_never_calls_billing(sa_engine, monkeypatch):
    monkeypatch.setattr(members_routes, "engine", sa_engine)
    reserve = AsyncMock(return_value=None)
    monkeypatch.setattr(billing_client, "check_and_reserve_membership", reserve)

    async with sa_engine.begin() as conn:
        org_id = await _seed_org(conn, _id()[:8])
        admin_id = await _seed_active_member(conn, org_id, "org_admin")
        target_id = await _seed_active_member(conn, org_id, "member")

    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="admin")
    member = await members_routes.change_role(
        _FakeRequest(), target_id, ChangeRoleRequest(role="member"), principal
    )
    assert member.id == target_id
    reserve.assert_not_awaited()


async def test_role_change_blocked_when_billing_denies_and_db_role_unchanged(sa_engine, monkeypatch):
    monkeypatch.setattr(members_routes, "engine", sa_engine)
    reserve = AsyncMock(side_effect=HTTPException(402, "insufficient credits"))
    monkeypatch.setattr(billing_client, "check_and_reserve_membership", reserve)

    async with sa_engine.begin() as conn:
        org_id = await _seed_org(conn, _id()[:8])
        admin_id = await _seed_active_member(conn, org_id, "org_admin")
        target_id = await _seed_active_member(conn, org_id, "member")

    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="admin")
    with pytest.raises(HTTPException) as exc_info:
        await members_routes.change_role(_FakeRequest(), target_id, ChangeRoleRequest(role="org_admin"), principal)
    assert exc_info.value.status_code == 402

    async with sa_engine.begin() as conn:
        await conn.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": org_id})
        role = (
            await conn.execute(
                text(
                    "SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :u"
                ),
                {"u": target_id},
            )
        ).scalar()
    assert role == "member"  # unchanged — the gated change never applied


async def test_role_change_restores_previous_cost_when_tx_refuses_to_apply(sa_engine, monkeypatch):
    """The pre-check sees an active, differently-roled member and approves the
    billing reservation for the NEW role — but the member was ACTUALLY
    suspended by a concurrent request in the gap between the pre-check and
    this request's own transaction, so change_role_tx's authoritative
    (re-read, re-verified) check refuses it. The compensating call must
    restore the OLD role's cost so billing-svc doesn't keep charging for a
    change that never happened.

    Simulated by patching ONLY the pre-check's `load_member` call (module
    attribute on `members_routes`) to return a stale "still active" snapshot
    — `change_role_tx` resolves its own `load_member` from
    `members_service`'s globals, so the real transaction still sees, and
    correctly refuses against, the true current state.
    """
    from app.schemas import MemberDTO

    monkeypatch.setattr(members_routes, "engine", sa_engine)
    reserve = AsyncMock(return_value=None)
    monkeypatch.setattr(billing_client, "check_and_reserve_membership", reserve)

    async with sa_engine.begin() as conn:
        org_id = await _seed_org(conn, _id()[:8])
        actor_id = await _seed_active_member(conn, org_id, "org_admin")
        target_id = await _seed_active_member(conn, org_id, "member")
        await conn.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": org_id})
        await conn.execute(text("UPDATE users SET status = 'suspended' WHERE id = :u"), {"u": target_id})

    stale_snapshot = MemberDTO(
        id=target_id, username="stale", displayName="Stale", email="stale@example.com",
        roles=["member"], status="active", emailVerified=True, createdAt="2024-01-01T00:00:00Z",
    )
    monkeypatch.setattr(members_routes, "load_member", AsyncMock(return_value=stale_snapshot))

    principal = Principal(user_id=actor_id, org_id=org_id, roles=["org_admin"], username="actor")
    with pytest.raises(HTTPException) as exc_info:
        await members_routes.change_role(_FakeRequest(), target_id, ChangeRoleRequest(role="org_admin"), principal)
    assert exc_info.value.status_code == 409

    # Reserved for the attempted new role, then restored to the old one.
    assert reserve.await_count == 2
    first_call, second_call = reserve.await_args_list
    assert first_call.args[1:] == (target_id, "org_admin")
    assert second_call.args[1:] == (target_id, "member")


# ── removal / leave ──────────────────────────────────────────────────────────


async def test_remove_member_releases_commitment_after_commit(sa_engine, monkeypatch):
    monkeypatch.setattr(members_routes, "engine", sa_engine)
    release = AsyncMock(return_value=None)
    monkeypatch.setattr(billing_client, "release_membership_commitment", release)

    async with sa_engine.begin() as conn:
        org_id = await _seed_org(conn, _id()[:8])
        admin_id = await _seed_active_member(conn, org_id, "org_admin")
        target_id = await _seed_active_member(conn, org_id, "member")

    principal = Principal(user_id=admin_id, org_id=org_id, roles=["org_admin"], username="admin")
    member = await members_routes.remove_member(_FakeRequest(), target_id, principal)
    assert member.status == "removed"
    release.assert_awaited_once_with(org_id, target_id)


async def test_leave_org_releases_commitment_for_the_leaving_org_only(sa_engine, monkeypatch):
    monkeypatch.setattr(auth_routes, "engine", sa_engine)
    release = AsyncMock(return_value=None)
    monkeypatch.setattr(billing_client, "release_membership_commitment", release)

    async with sa_engine.begin() as conn:
        org_a = await _seed_org(conn, _id()[:8])
        org_b = await _seed_org(conn, _id()[:8])

    identity_id = _id()
    async with sa_engine.begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text("INSERT INTO identities (id, email_bidx, password_hash) VALUES (:id, :bidx, 'x')"),
            {"id": identity_id, "bidx": cryptor().blind_index(f"{identity_id}@example.com")},
        )
        for org_id in (org_a, org_b):
            uid = _id()
            await conn.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": org_id})
            email_enc = await cryptor().encrypt(conn, org_id, f"{uid}@example.com")
            dn_enc = await cryptor().encrypt(conn, org_id, f"User {uid[:8]}")
            await conn.execute(
                text(
                    "INSERT INTO users (id, org_id, identity_id, email_enc, email_bidx, username, "
                    "password_hash, display_name_enc, email_verified, status) "
                    "VALUES (:id, :org, :iid, :email_enc, :bidx, :uname, 'x', :dn_enc, true, 'active')"
                ),
                {
                    "id": uid,
                    "org": org_id,
                    "iid": identity_id,
                    "email_enc": email_enc,
                    "bidx": cryptor().blind_index(uid),
                    "uname": f"u-{uid[:8]}",
                    "dn_enc": dn_enc,
                },
            )
            rid = await _role_id(conn, "org_admin" if org_id == org_a else "member")
            await conn.execute(
                text("INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:u, :r, :o)"),
                {"u": uid, "r": rid, "o": org_id},
            )
            if org_id == org_b:
                target_user_id = uid
        # A second, unrelated admin in org_b so the leaving member (above) is
        # never the org's last admin — would_orphan_org would otherwise
        # refuse the leave outright, before billing_client is ever reached.
        await _seed_active_member(conn, org_b, "org_admin")

    principal = Principal(user_id=target_user_id, org_id=org_b, roles=["member"], username="leaver")
    await auth_routes.leave_org(_FakeRequest(), org_b, None, principal)
    release.assert_awaited_once_with(org_b, target_user_id)
