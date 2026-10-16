"""Invite lifecycle bugs found in a deep review of the org module, against a
real Postgres.

    TEST_DATABASE_URL=postgresql://taskboard:taskboard_dev_pw@postgres:5432/authdb_scratch \\
        python -m pytest tests/integration/test_invites.py -q
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import HTTPException
from sqlalchemy import text

from app import service
from app.routes import invites as invites_routes
from app.routes.invites_service import accept_invite_tx
from app.routing import placement
from app.schemas import AcceptInviteRequest, CreateInviteRequest
from app.security import keys
from app.security.auth_dep import Principal
from crypto import cryptor, init_cryptor
from app.config import settings

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _init_crypto():
    init_cryptor(settings)


@pytest.fixture(autouse=True)
def _jwt_signing_key(tmp_path, monkeypatch: pytest.MonkeyPatch):
    """accept_invite_tx ends in a real session build (JWT mint) — provision a
    throwaway Ed25519 key on disk, same shape as test_keys_jwks.py, rather
    than relying on /keys/ed25519_private.pem existing in this environment."""
    priv_path = tmp_path / "ed25519_private.pem"
    private = Ed25519PrivateKey.generate()
    priv_path.write_bytes(
        private.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    monkeypatch.setattr(settings, "jwt_private_key_path", str(priv_path))
    keys._load_private_key.cache_clear()
    keys._private_pem.cache_clear()
    yield
    keys._load_private_key.cache_clear()
    keys._private_pem.cache_clear()


async def _seed_org(conn, name_suffix: str) -> str:
    org_id = str(uuid.uuid4())
    await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
    await conn.execute(
        text("INSERT INTO orgs (id, name, slug) VALUES (:id, :name, :slug)"),
        {"id": org_id, "name": f"Acme {name_suffix}", "slug": f"acme-{name_suffix}"},
    )
    return org_id


async def _role_id(conn, name: str) -> int:
    row = (await conn.execute(text("SELECT id FROM roles WHERE name = :n"), {"n": name})).first()
    return int(row.id)


async def _seed_pending_invite(conn, org_id: str, email: str, role: str, token: str) -> None:
    role_id = await _role_id(conn, role)
    expires_at = datetime.now(timezone.utc) + timedelta(days=1)
    token_hash = service.sha256_bytes(token)
    # accept_invite_tx looks the invite up in the routing directory FIRST, by
    # token hash alone (it has to work before the org — and therefore the
    # site — is known); without this row it answers 503 "retry" regardless of
    # what's in `invites`, matching a real create_invite_tx's own placement call.
    await placement.record_invite_placement(
        conn,
        token_hash.hex(),
        home_site=settings.site_id,
        expires_at=expires_at,
    )
    await conn.execute(
        text(
            """
            INSERT INTO invites (id, org_id, email, role_id, token_hash, invited_by, expires_at)
            VALUES (:id, :org, :email, :rid, :hash, :by, :exp)
            """
        ),
        {
            "id": str(uuid.uuid4()),
            "exp": expires_at,
            "org": org_id,
            "email": email,
            "rid": role_id,
            "hash": service.sha256_bytes(token),
            "by": str(uuid.uuid4()),
        },
    )


class _FakeRequest:
    """The tiny slice of fastapi.Request accept_invite_tx's request_context reads."""

    client = None
    headers: dict = {}


# ── #2: re-inviting a previously-removed member must not 500 ────────────────


async def test_accepting_an_invite_for_a_removed_member_reactivates_instead_of_500ing(sa_conn):
    org_id = await _seed_org(sa_conn, uuid.uuid4().hex[:8])
    email = f"comeback-{uuid.uuid4().hex[:8]}@example.com"
    email_bidx = cryptor().blind_index(email)
    old_user_id = str(uuid.uuid4())

    await sa_conn.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": org_id})
    await sa_conn.execute(
        text(
            """
            INSERT INTO users
                (id, org_id, email_enc, email_bidx, username, password_hash,
                 display_name_enc, email_verified, status, removed_at)
            VALUES (:id, :org, :enc, :bidx, :uname, 'x', :dn, true, 'removed', now())
            """
        ),
        {
            "id": old_user_id,
            "org": org_id,
            "enc": await cryptor().encrypt(sa_conn, org_id, email),
            "bidx": email_bidx,
            "uname": "old-username",
            "dn": await cryptor().encrypt(sa_conn, org_id, "Old Name"),
        },
    )

    token = service.new_refresh_secret()
    await _seed_pending_invite(sa_conn, org_id, email, "org_admin", token)
    await sa_conn.commit()

    body = AcceptInviteRequest(
        token=token, password="Correct-Horse-9-Battery!", username="new-username", displayName="New Name"
    )
    session, _raw_refresh, user_id = await accept_invite_tx(sa_conn, body, _FakeRequest())
    await sa_conn.commit()

    # Reactivated the SAME row, not a second one colliding on the unique index.
    assert user_id == old_user_id
    assert session.user.orgId == org_id

    # The commit above released the transaction-local app.org_id GUC.
    await sa_conn.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": org_id})
    row = (
        await sa_conn.execute(
            text("SELECT status, removed_at, username FROM users WHERE id = :id"), {"id": old_user_id}
        )
    ).first()
    assert row.status == "active"
    assert row.removed_at is None
    assert row.username == "new-username"

    roles = (
        await sa_conn.execute(
            text(
                "SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id "
                "WHERE ur.user_id = :id"
            ),
            {"id": old_user_id},
        )
    ).all()
    assert [r.name for r in roles] == ["org_admin"]  # the NEW invite's role, not a stale grant


async def test_accepting_an_invite_for_an_active_member_is_a_clean_conflict(sa_conn):
    org_id = await _seed_org(sa_conn, uuid.uuid4().hex[:8])
    email = f"already-here-{uuid.uuid4().hex[:8]}@example.com"

    await sa_conn.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": org_id})
    await sa_conn.execute(
        text(
            """
            INSERT INTO users (id, org_id, email_enc, email_bidx, username, password_hash,
                                display_name_enc, email_verified, status)
            VALUES (:id, :org, :enc, :bidx, 'existing', 'x', :dn, true, 'active')
            """
        ),
        {
            "id": str(uuid.uuid4()),
            "org": org_id,
            "enc": await cryptor().encrypt(sa_conn, org_id, email),
            "bidx": cryptor().blind_index(email),
            "dn": await cryptor().encrypt(sa_conn, org_id, "Existing"),
        },
    )
    token = service.new_refresh_secret()
    await _seed_pending_invite(sa_conn, org_id, email, "member", token)
    await sa_conn.commit()

    body = AcceptInviteRequest(
        token=token, password="Correct-Horse-9-Battery!", username="whoever", displayName="Whoever"
    )
    with pytest.raises(HTTPException) as exc_info:
        await accept_invite_tx(sa_conn, body, _FakeRequest())
    assert exc_info.value.status_code == 409


async def test_username_unique_race_returns_conflict_and_preserves_transaction(sa_conn):
    org_id = await _seed_org(sa_conn, uuid.uuid4().hex[:8])
    conflicting_email = f"existing-{uuid.uuid4().hex[:8]}@example.com"
    await sa_conn.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": org_id})
    await sa_conn.execute(
        text(
            """
            INSERT INTO users (id, org_id, email_enc, email_bidx, username, password_hash,
                               display_name_enc, email_verified, status)
            VALUES (:id, :org, :enc, :bidx, 'taken-name', 'x', :dn, true, 'active')
            """
        ),
        {
            "id": str(uuid.uuid4()),
            "org": org_id,
            "enc": await cryptor().encrypt(sa_conn, org_id, conflicting_email),
            "bidx": cryptor().blind_index(conflicting_email),
            "dn": await cryptor().encrypt(sa_conn, org_id, "Existing"),
        },
    )
    email = f"invite-{uuid.uuid4().hex[:8]}@example.com"
    token = service.new_refresh_secret()
    await _seed_pending_invite(sa_conn, org_id, email, "member", token)
    await sa_conn.commit()

    body = AcceptInviteRequest(
        token=token, password="Valid-Password-123!", username="taken-name", displayName="Invited"
    )
    with pytest.raises(HTTPException) as exc_info:
        await accept_invite_tx(sa_conn, body, _FakeRequest())
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == "username is already in use in this organization"
    assert (await sa_conn.execute(text("SELECT 1"))).scalar_one() == 1


# ── #1: invite create/revoke must re-verify admin status against the DB ─────


async def test_create_invite_rejects_a_demoted_admins_stale_jwt_claim(sa_engine):
    async with sa_engine.begin() as conn:
        org_id = await _seed_org(conn, uuid.uuid4().hex[:8])
        user_id = str(uuid.uuid4())
        await conn.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": org_id})
        await conn.execute(
            text(
                """
                INSERT INTO users (id, org_id, email_enc, email_bidx, username, password_hash,
                                    display_name_enc, email_verified, status)
                VALUES (:id, :org, 'x', :bidx, 'demoted', 'x', 'x', true, 'active')
                """
            ),
            {"id": user_id, "org": org_id, "bidx": cryptor().blind_index(f"{user_id}@x.test")},
        )
        member_role = await _role_id(conn, "member")
        # The DB says "member" — a demotion that already happened.
        await conn.execute(
            text("INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:u, :r, :o)"),
            {"u": user_id, "r": member_role, "o": org_id},
        )

    invites_routes.engine = sa_engine

    # The JWT claim still says org_admin — minted before the demotion, and not
    # yet expired.
    principal = Principal(user_id=user_id, org_id=org_id, roles=["org_admin"], username="demoted")
    body = CreateInviteRequest(email="new-admin@example.com", role="org_admin")

    with pytest.raises(HTTPException) as exc_info:
        await invites_routes.create_invite(_FakeRequest(), body, principal)
    assert exc_info.value.status_code == 403
