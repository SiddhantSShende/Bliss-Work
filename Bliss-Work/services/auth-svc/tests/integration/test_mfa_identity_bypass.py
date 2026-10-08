"""B-AUTH-1 and B-AUTH-8 against a real Postgres.

B-AUTH-1: `POST /auth/orgs`, `POST /auth/invites/accept` and
`POST /auth/orgs/{id}/leave` authenticated an EXISTING identity by password
alone. The first two then handed back a full session with no `mfa_gate`, and
the third acted on every membership of the identity with no step-up. A holder of
just the password could therefore sidestep a second factor enrolled on another
membership of the same identity.

B-AUTH-8: `verify_step_up` (MFA-disable, backup-code regeneration, TOTP
overwrite) never counted a failure toward the identity lockout, so a stolen
access token could guess the password / TOTP without limit.

The route functions are called directly with `engine` pointed at the migrated
test database (same shape as test_create_org_lockout.py).
"""
from __future__ import annotations

import uuid

import pyotp
import pytest
from fastapi import HTTPException, Response
from sqlalchemy import text
from starlette.requests import Request

from app import service
from app.config import settings
from app.routes import auth as auth_routes
from app.routes import invites_service, mfa_challenge, mfa_service
from app.routing.placement import PlacementResult
from app.schemas import (
    AcceptInviteRequest,
    CreateOrgRequest,
    MfaPendingDTO,
    MfaStepUpRequest,
    SessionDTO,
)
from app.security.auth_dep import Principal
from app.security.passwords import hash_password_async
from crypto import cryptor, init_cryptor

pytestmark = pytest.mark.integration

PASSWORD = "Correct-Horse-9-Battery!"


@pytest.fixture(autouse=True)
def _init_crypto():
    init_cryptor(settings)


@pytest.fixture
async def real_engine(monkeypatch: pytest.MonkeyPatch, sa_engine):
    for module in (auth_routes, mfa_challenge, service):
        monkeypatch.setattr(module, "engine", sa_engine)

    async def _no_captcha(*_a, **_k):
        return None

    async def _stub_place_org(conn, org_id, **_kwargs):
        return PlacementResult(site=settings.site_id, reason="only-candidate", alerts=())

    monkeypatch.setattr(auth_routes.captcha_service, "verify_and_consume", _no_captcha)
    monkeypatch.setattr(auth_routes, "place_org", _stub_place_org)
    # Signing needs the deployed Ed25519 key file, which these tests have no use for.
    monkeypatch.setattr(service, "mint_access_token", lambda *_a, **_k: ("test-access-token", 300))
    return sa_engine


def _request() -> Request:
    return Request(
        {"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("127.0.0.1", 1)}
    )


async def _seed_membership(
    conn,
    identity_id: str,
    *,
    role: str,
    enrolled_secret: str | None = None,
    org_id: str | None = None,
) -> tuple[str, str]:
    """A membership in `org_id`, creating that org when none is given."""
    user_id = str(uuid.uuid4())
    await service.set_bypass_rls(conn)
    if org_id is None:
        org_id = str(uuid.uuid4())
        await conn.execute(
            text("INSERT INTO orgs (id, name, slug) VALUES (:id, 'Test Org', :slug)"),
            {"id": org_id, "slug": f"test-{org_id}"},
        )
    await conn.execute(
        text(
            "INSERT INTO users (id, org_id, identity_id, username, password_hash) "
            "VALUES (:id, :org, :iid, :un, 'x')"
        ),
        {"id": user_id, "org": org_id, "iid": identity_id, "un": f"user-{user_id[:8]}"},
    )
    role_id = (await conn.execute(text("SELECT id FROM roles WHERE name = :n"), {"n": role})).scalar()
    await conn.execute(
        text("INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:u, :r, :o)"),
        {"u": user_id, "r": role_id, "o": org_id},
    )
    if enrolled_secret is not None:
        await service.set_org_guc(conn, org_id)
        await conn.execute(
            text(
                "UPDATE users SET mfa_enrolled = true, mfa_enrolled_at = now(), "
                "mfa_totp_secret_enc = :s WHERE id = :id"
            ),
            {"s": await cryptor().encrypt(conn, org_id, enrolled_secret), "id": user_id},
        )
    return org_id, user_id


async def _seed_identity(engine, *, enrolled: bool) -> dict:
    """An identity with a member-role membership in org B (no MFA) and, when
    `enrolled`, an org-admin membership in org A with TOTP enrolled."""
    email = f"person-{uuid.uuid4().hex[:8]}@example.com"
    identity_id = str(uuid.uuid4())
    secret = pyotp.random_base32()
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)
        await conn.execute(
            text(
                "INSERT INTO identities (id, email_bidx, password_hash, email_verified) "
                "VALUES (:id, :b, :ph, true)"
            ),
            {
                "id": identity_id,
                "b": cryptor().blind_index(email),
                "ph": await hash_password_async(PASSWORD),
            },
        )
        org_b, user_b = await _seed_membership(conn, identity_id, role="member")
        # Org B keeps an admin of its own, or leaving it is refused as orphaning.
        other_identity = str(uuid.uuid4())
        await conn.execute(
            text("INSERT INTO identities (id, email_bidx, password_hash) VALUES (:id, :b, 'x')"),
            {"id": other_identity, "b": cryptor().blind_index(f"admin-{other_identity}@example.com")},
        )
        await _seed_membership(conn, other_identity, role="org_admin", org_id=org_b)
        org_a = user_a = None
        if enrolled:
            org_a, user_a = await _seed_membership(
                conn, identity_id, role="org_admin", enrolled_secret=secret
            )
    return {
        "email": email, "identity_id": identity_id, "secret": secret,
        "org_a": org_a, "user_a": user_a, "org_b": org_b, "user_b": user_b,
    }


async def _identity_row(engine, identity_id: str):
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)
        return (
            await conn.execute(
                text("SELECT failed_login_count, locked_until FROM identities WHERE id = :id"),
                {"id": identity_id},
            )
        ).first()


async def _member_status(engine, user_id: str) -> str:
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)
        return (
            await conn.execute(text("SELECT status FROM users WHERE id = :id"), {"id": user_id})
        ).scalar_one()


async def test_presence_lookup_failure_does_not_abort_outer_transaction(real_engine, monkeypatch):
    async def _fail_lookup(conn, _user_id):
        await conn.execute(text("SELECT 1 / 0"))

    monkeypatch.setattr(service, "identity_id_for_user", _fail_lookup)
    async with real_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        assert await service.presence_memberships(conn, str(uuid.uuid4())) == []
        assert (await conn.execute(text("SELECT 1"))).scalar_one() == 1


def _create_org_body(email: str) -> CreateOrgRequest:
    return CreateOrgRequest(
        orgName="Acme " + uuid.uuid4().hex[:8],
        email=email,
        password=PASSWORD,
        displayName="Person",
        captchaId="x",
        captchaValue="x",
    )


# ── B-AUTH-1: create_org ──────────────────────────────────────────────────────
async def test_create_org_for_an_mfa_enrolled_identity_returns_a_challenge_not_a_session(real_engine):
    ident = await _seed_identity(real_engine, enrolled=True)
    response = Response()

    result = await auth_routes.create_org(_create_org_body(ident["email"]), response)

    assert isinstance(result, MfaPendingDTO), "a password alone must not yield a session"
    assert result.methods == ["totp"] and result.enrollmentRequired is False
    assert "set-cookie" not in response.headers, "no refresh cookie without the second factor"
    # The challenge is bound to the membership that actually HAS the factor...
    async with real_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        resolved = await mfa_service.peek_mfa_pending(conn, result.pendingToken)
        assert resolved == (ident["user_a"], ident["org_a"])
        # ...and the org itself was still created, so the person can reach it
        # through the (MFA-gated) switch once the challenge is passed.
        created = (
            await conn.execute(
                text("SELECT count(*) FROM users WHERE identity_id = :i"), {"i": ident["identity_id"]}
            )
        ).scalar_one()
        assert created == 3
        # No session of any kind was minted for the identity.
        sessions = (
            await conn.execute(
                text(
                    "SELECT count(*) FROM refresh_tokens WHERE user_id IN "
                    "(SELECT id FROM users WHERE identity_id = :i)"
                ),
                {"i": ident["identity_id"]},
            )
        ).scalar_one()
        assert sessions == 0


async def test_create_org_for_an_existing_identity_without_mfa_still_gets_a_session(real_engine):
    ident = await _seed_identity(real_engine, enrolled=False)
    response = Response()

    result = await auth_routes.create_org(_create_org_body(ident["email"]), response)

    assert isinstance(result, SessionDTO)
    assert "set-cookie" in response.headers


async def test_create_org_for_a_brand_new_identity_still_gets_a_session(real_engine):
    response = Response()
    result = await auth_routes.create_org(
        _create_org_body(f"new-{uuid.uuid4().hex[:8]}@example.com"), response
    )
    assert isinstance(result, SessionDTO)
    assert "set-cookie" in response.headers


# ── B-AUTH-1: accept_invite ───────────────────────────────────────────────────
async def _seed_invite_for(engine, email: str) -> str:
    from datetime import datetime, timedelta, timezone

    from app.routing import placement

    token = service.new_refresh_secret()
    expires_at = datetime.now(timezone.utc) + timedelta(days=1)
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)
        org_id = str(uuid.uuid4())
        await conn.execute(
            text("INSERT INTO orgs (id, name, slug) VALUES (:id, 'Inviting Org', :slug)"),
            {"id": org_id, "slug": f"inv-{org_id}"},
        )
        await placement.record_invite_placement(
            conn, service.sha256_bytes(token).hex(), home_site=settings.site_id, expires_at=expires_at
        )
        role_id = (await conn.execute(text("SELECT id FROM roles WHERE name = 'member'"))).scalar()
        await conn.execute(
            text(
                "INSERT INTO invites (id, org_id, email, role_id, token_hash, invited_by, expires_at) "
                "VALUES (:id, :org, :email, :rid, :hash, :by, :exp)"
            ),
            {
                "id": str(uuid.uuid4()), "org": org_id, "email": email, "rid": role_id,
                "hash": service.sha256_bytes(token), "by": str(uuid.uuid4()), "exp": expires_at,
            },
        )
    return token


async def _accept(engine, token: str):
    async with engine.begin() as conn:
        return await invites_service.accept_invite_tx(
            conn,
            AcceptInviteRequest(
                token=token, password=PASSWORD, username=f"u{uuid.uuid4().hex[:6]}", displayName="P"
            ),
            _request(),
        )


async def test_accepting_an_invite_as_an_mfa_enrolled_identity_returns_a_challenge(real_engine):
    ident = await _seed_identity(real_engine, enrolled=True)
    token = await _seed_invite_for(real_engine, ident["email"])

    result, raw_refresh, _user_id = await _accept(real_engine, token)

    assert isinstance(result, MfaPendingDTO)
    assert raw_refresh is None, "no refresh token (session) without the second factor"


async def test_accepting_an_invite_without_mfa_still_gets_a_session(real_engine):
    ident = await _seed_identity(real_engine, enrolled=False)
    token = await _seed_invite_for(real_engine, ident["email"])

    result, raw_refresh, _user_id = await _accept(real_engine, token)

    assert isinstance(result, SessionDTO)
    assert raw_refresh


# ── B-AUTH-1: leave_org ───────────────────────────────────────────────────────
def _principal(ident: dict) -> Principal:
    # The password-only session: it belongs to org B's membership, which has no MFA.
    return Principal(user_id=ident["user_b"], org_id=ident["org_b"], roles=["member"], username="b")


async def _leave(ident: dict, body: MfaStepUpRequest | None):
    return await auth_routes.leave_org(
        _request(), ident["org_b"], body=body, principal=_principal(ident)
    )


async def test_leave_org_requires_step_up_when_the_identity_has_mfa_enrolled(real_engine):
    ident = await _seed_identity(real_engine, enrolled=True)

    with pytest.raises(HTTPException) as exc:
        await _leave(ident, None)
    assert exc.value.status_code == 403
    assert await _member_status(real_engine, ident["user_b"]) == "active"

    with pytest.raises(HTTPException) as exc:
        await _leave(ident, MfaStepUpRequest(password=PASSWORD, totpCode="000000"))
    assert exc.value.status_code == 401
    with pytest.raises(HTTPException) as exc:
        await _leave(ident, MfaStepUpRequest(password="Wr0ng-Password!", totpCode=pyotp.TOTP(ident["secret"]).now()))
    assert exc.value.status_code == 401
    assert await _member_status(real_engine, ident["user_b"]) == "active"

    result = await _leave(
        ident, MfaStepUpRequest(password=PASSWORD, totpCode=pyotp.TOTP(ident["secret"]).now())
    )
    assert result.status_code == 204
    assert await _member_status(real_engine, ident["user_b"]) == "removed"


async def test_leave_org_needs_no_step_up_without_enrolled_mfa(real_engine):
    ident = await _seed_identity(real_engine, enrolled=False)
    # Not enrolled anywhere, but needs a second membership to be allowed to leave.
    async with real_engine.begin() as conn:
        await _seed_membership(conn, ident["identity_id"], role="member")

    result = await _leave(ident, None)

    assert result.status_code == 204
    assert await _member_status(real_engine, ident["user_b"]) == "removed"


async def test_failed_leave_step_ups_lock_the_identity(real_engine):
    ident = await _seed_identity(real_engine, enrolled=True)
    bad = MfaStepUpRequest(password="Wr0ng-Password!", totpCode="000000")

    for _ in range(settings.login_max_failed_attempts - 1):
        with pytest.raises(HTTPException) as exc:
            await _leave(ident, bad)
        assert exc.value.status_code == 401
    with pytest.raises(HTTPException) as exc:
        await _leave(ident, bad)
    assert exc.value.status_code == 429

    good = MfaStepUpRequest(password=PASSWORD, totpCode=pyotp.TOTP(ident["secret"]).now())
    with pytest.raises(HTTPException) as exc:
        await _leave(ident, good)
    assert exc.value.status_code == 429, "a locked identity is refused even with correct credentials"
    assert await _member_status(real_engine, ident["user_b"]) == "active"


# ── B-AUTH-8: step-up failures count toward the lockout ───────────────────────
async def test_failed_step_up_attempts_are_counted_and_lock_the_identity(real_engine):
    ident = await _seed_identity(real_engine, enrolled=True)
    principal = Principal(
        user_id=ident["user_a"], org_id=ident["org_a"], roles=["org_admin"], username="a"
    )
    async with real_engine.begin() as conn:  # the membership's own password copy
        await service.set_org_guc(conn, ident["org_a"])
        await conn.execute(
            text("UPDATE users SET password_hash = :h WHERE id = :id"),
            {"h": await hash_password_async(PASSWORD), "id": ident["user_a"]},
        )

    async def _disable(password: str, code: str):
        return await mfa_challenge.disable_mfa(
            MfaStepUpRequest(password=password, totpCode=code), _request(), principal
        )

    # Each failure raises out of `engine.begin()` (a rollback) yet must persist.
    for attempt in range(1, settings.login_max_failed_attempts):
        with pytest.raises(HTTPException) as exc:
            await _disable("Wr0ng-Password!", "000000")
        assert exc.value.status_code == 401
        row = await _identity_row(real_engine, ident["identity_id"])
        assert row.failed_login_count == attempt, "the failure was rolled back with the request"

    with pytest.raises(HTTPException) as exc:
        await _disable("Wr0ng-Password!", "000000")
    assert exc.value.status_code == 429
    assert (await _identity_row(real_engine, ident["identity_id"])).locked_until is not None

    # Locked: even the correct password + code are refused, and MFA stays on.
    with pytest.raises(HTTPException) as exc:
        await _disable(PASSWORD, pyotp.TOTP(ident["secret"]).now())
    assert exc.value.status_code == 429
    async with real_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        enrolled = (
            await conn.execute(
                text("SELECT mfa_enrolled FROM users WHERE id = :id"), {"id": ident["user_a"]}
            )
        ).scalar_one()
    assert enrolled is True


async def test_a_correct_step_up_does_not_count_as_a_failure(real_engine):
    ident = await _seed_identity(real_engine, enrolled=True)
    async with real_engine.begin() as conn:
        await service.set_org_guc(conn, ident["org_a"])
        await conn.execute(
            text("UPDATE users SET password_hash = :h WHERE id = :id"),
            {"h": await hash_password_async(PASSWORD), "id": ident["user_a"]},
        )
        ok = await mfa_service.verify_step_up(
            conn, ident["org_a"], ident["user_a"], PASSWORD, pyotp.TOTP(ident["secret"]).now(), None
        )
    assert ok is True
    assert (await _identity_row(real_engine, ident["identity_id"])).failed_login_count == 0


# ── B-AUTH-3: a failed password must not need a SECOND pooled connection ──────
#
# The failed attempt used to be counted on a second `engine.begin()` opened while
# the request's own transaction was still holding its connection. With every pool
# connection occupied by such a request, none can get its second one: they wait on
# each other until the pool timeout, and an attacker can cause that at will. A
# pool of ONE makes it deterministic — any code that holds a connection while
# asking for another times out here.
@pytest.fixture
async def tiny_pool(monkeypatch: pytest.MonkeyPatch, pg_dsn: str, real_engine):
    from sqlalchemy import event
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.routes import invites as invites_routes
    from app.routes import mfa_totp

    tiny = create_async_engine(
        pg_dsn.replace("postgresql://", "postgresql+asyncpg://", 1),
        pool_size=1, max_overflow=0, pool_timeout=2,
    )

    @event.listens_for(tiny.sync_engine, "connect")
    def _set_role(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("SET ROLE rls_test")
        cursor.close()

    for module in (auth_routes, mfa_challenge, mfa_totp, invites_routes, service):
        monkeypatch.setattr(module, "engine", tiny)
    try:
        yield tiny
    finally:
        await tiny.dispose()


async def test_a_wrong_password_on_create_org_is_counted_without_a_second_connection(tiny_pool, real_engine):
    ident = await _seed_identity(real_engine, enrolled=False)
    body = _create_org_body(ident["email"]).model_copy(update={"password": "Wr0ng-Password!"})

    with pytest.raises(HTTPException) as exc:
        await auth_routes.create_org(body, Response())

    assert exc.value.status_code == 409, "the pool deadlocked into a timeout instead of answering"
    assert (await _identity_row(real_engine, ident["identity_id"])).failed_login_count == 1


async def test_a_wrong_password_on_invite_accept_is_counted_without_a_second_connection(tiny_pool, real_engine):
    from app.routes import invites as invites_routes

    ident = await _seed_identity(real_engine, enrolled=False)
    token = await _seed_invite_for(real_engine, ident["email"])
    body = AcceptInviteRequest(
        token=token, password="Wr0ng-Password!", username=f"u{uuid.uuid4().hex[:6]}", displayName="P"
    )

    with pytest.raises(HTTPException) as exc:
        await invites_routes.accept_invite(body, _request(), Response())

    assert exc.value.status_code == 401
    assert (await _identity_row(real_engine, ident["identity_id"])).failed_login_count == 1


async def test_a_failed_step_up_is_counted_without_a_second_connection(tiny_pool, real_engine):
    ident = await _seed_identity(real_engine, enrolled=True)
    principal = Principal(
        user_id=ident["user_a"], org_id=ident["org_a"], roles=["org_admin"], username="a"
    )

    with pytest.raises(HTTPException) as exc:
        await mfa_challenge.disable_mfa(
            MfaStepUpRequest(password="Wr0ng-Password!", totpCode="000000"), _request(), principal
        )

    assert exc.value.status_code == 401
    assert (await _identity_row(real_engine, ident["identity_id"])).failed_login_count == 1


async def test_the_lockout_still_engages_through_the_deferred_count(tiny_pool, real_engine):
    ident = await _seed_identity(real_engine, enrolled=False)
    body = _create_org_body(ident["email"]).model_copy(update={"password": "Wr0ng-Password!"})

    codes = []
    for _ in range(settings.login_max_failed_attempts):
        with pytest.raises(HTTPException) as exc:
            await auth_routes.create_org(body, Response())
        codes.append(exc.value.status_code)

    assert codes[:-1] == [409] * (settings.login_max_failed_attempts - 1) and codes[-1] == 429
