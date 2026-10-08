"""MFA shared logic: the "MFA pending" token, the restricted enrollment
credential, TOTP replay-safe verification, and backup codes. Thin route layers (mfa_totp.py,
mfa_challenge.py) sit on top of this, mirroring the existing
account_service.py/invites_service.py split. See
docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7.

── Storage: `users`, not `identities` ────────────────────────────────────────

── The "MFA pending" token, and why it doubles as an enrollment credential ───
After a correct password, if a second factor is still owed, /auth/login mints
this short-lived, single-use token (reusing user_tokens' existing
mint/consume machinery under a THIRD purpose, `mfa_pending` — never emailed,
created and consumed entirely server-side) instead of a session. The client
presents it to mfa_challenge.py's verify endpoint next.

It is ALSO the only way a post-grace-period admin who has never enrolled can
reach enroll-start/enroll-confirm: login blocks them before a session exists,
so there is no Bearer token to authenticate an enrollment call with. The
pending token — scoped to exactly that one user_id — fills that gap. It stops
working the moment mfa_enrolled flips true, which is the boundary this
"restricted enrollment credential" is supposed to have.

Checked (peeked) any number of times across a challenge/enrollment attempt —
a wrong code must not burn it — and consumed exactly once, at the moment a
session is actually minted (challenge-verify success, or enroll-confirm
success reached via this same credential).
"""
from __future__ import annotations

import secrets
import time
from datetime import datetime, timedelta, timezone

import pyotp
from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .. import service
from ..config import settings
from crypto import cryptor
from ..security.auth_dep import verify_bearer
from ..schemas import MfaPendingDTO, MfaStepUpRequest
from ..security.passwords import verify_password_async
from .account_service import consume_token, mint_token, peek_token

PURPOSE_MFA_PENDING = "mfa_pending"


# ── The "MFA pending" token ───────────────────────────────────────────────────
async def mint_mfa_pending(conn: AsyncConnection, org_id: str, user_id: str) -> str:
    raw, _ = await mint_token(
        conn, org_id, user_id, PURPOSE_MFA_PENDING,
        timedelta(minutes=settings.mfa_pending_ttl_minutes),
    )
    return raw


async def peek_mfa_pending(conn: AsyncConnection, raw_token: str) -> tuple[str, str] | None:
    return await peek_token(conn, PURPOSE_MFA_PENDING, raw_token)


async def consume_mfa_pending(conn: AsyncConnection, raw_token: str) -> tuple[str, str]:
    return await consume_token(conn, PURPOSE_MFA_PENDING, raw_token)


async def resolve_enrollment_actor(
    conn: AsyncConnection,
    *,
    principal_user_id: str | None,
    principal_org_id: str | None,
    pending_token: str | None,
) -> tuple[str, str]:
    """(user_id, org_id) for an enrollment endpoint, reachable by either an
    ordinary signed-in caller (principal_* already resolved by the route's own
    Depends(get_principal)-equivalent) or the restricted enrollment credential.
    Binds the RLS org GUC before returning either way, since the enrolled-check
    below (and everything the route does afterwards) touches `users`, which is
    RLS ENABLE+FORCE.
    """
    if principal_user_id is not None and principal_org_id is not None:
        await service.set_org_guc(conn, principal_org_id)
        return principal_user_id, principal_org_id
    if pending_token:
        resolved = await peek_mfa_pending(conn, pending_token)
        if resolved is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired session")
        user_id, org_id = resolved
        await service.set_org_guc(conn, org_id)
        enrolled = (
            await conn.execute(
                text("SELECT mfa_enrolled FROM users WHERE id = :id"), {"id": user_id}
            )
        ).scalar()
        if enrolled:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "already enrolled — sign in normally")
        return user_id, org_id
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "authentication required")


async def resolve_actor_for_enrollment(
    conn: AsyncConnection, *, authorization: str | None, pending_token: str | None
) -> tuple[str, str]:
    """Entry point for mfa_totp.py's enrollment
    routes: tries the normal Bearer header first (an invalid one 401s here,
    same as any other authenticated route — it does NOT silently fall back),
    and only consults the restricted enrollment credential when no Bearer
    token was sent at all."""
    if authorization:
        principal = await verify_bearer(authorization)
        return await resolve_enrollment_actor(
            conn,
            principal_user_id=principal.user_id,
            principal_org_id=principal.org_id,
            pending_token=None,
        )
    return await resolve_enrollment_actor(
        conn, principal_user_id=None, principal_org_id=None, pending_token=pending_token
    )


async def is_already_enrolled(conn: AsyncConnection, user_id: str) -> bool:
    """Whether this membership already has MFA enrolled. TOTP enroll-confirm
    TOTP enroll-confirm calls this to decide whether overwriting the TOTP
    secret needs step-up re-auth first, exactly like MFA-disable and
    backup-codes/regenerate already require: a user with nothing enrolled yet
    has no existing factor for a stolen Bearer token to hijack, but
    overwriting or augmenting an EXISTING one is exactly as consequential as
    disabling MFA outright (it can lock the real owner out, or plant a
    durable extra credential) and must be gated the same way.
    """
    row = (
        await conn.execute(text("SELECT mfa_enrolled FROM users WHERE id = :id"), {"id": user_id})
    ).first()
    return bool(row and row.mfa_enrolled)


# ── Login-time / switch-org-time gate ────────────────────────────────────────
async def mfa_gate(conn: AsyncConnection, user_id: str, org_id: str, roles: list[str]) -> tuple[bool, bool]:
    """(mfa_required_now, must_enroll_first) for the membership being entered.

    Evaluated against exactly THIS membership — never across a person's other
    memberships. MFA enrollment does not carry across org boundaries (storage
    decision above), so a user fully enrolled and clear in org A can still be
    blocked switching into org B if B mandates MFA past its grace period and
    they have never enrolled under that specific membership.
    """
    row = (
        await conn.execute(text("SELECT mfa_enrolled FROM users WHERE id = :id"), {"id": user_id})
    ).first()
    if row is not None and bool(row.mfa_enrolled):
        return True, False
    if "org_admin" not in roles:
        return False, False
    org_row = (
        await conn.execute(
            text(
                "SELECT require_mfa_for_admins, mfa_grace_period_ends_at "
                "FROM orgs WHERE id = :id"
            ),
            {"id": org_id},
        )
    ).first()
    if org_row is None or not org_row.require_mfa_for_admins:
        return False, False
    grace_ends = org_row.mfa_grace_period_ends_at
    if grace_ends is not None and grace_ends > datetime.now(timezone.utc):
        return False, False  # inside the grace window: banner only, no block
    return True, True


# ── TOTP ──────────────────────────────────────────────────────────────────────
def generate_totp_secret() -> str:
    return pyotp.random_base32()


def totp_otpauth_url(secret: str, *, account_name: str) -> str:
    return pyotp.totp.TOTP(secret).provisioning_uri(
        name=account_name, issuer_name="BlissWork"
    )


# +/- one 30s step either side of "now" — ~90s of clock skew / typing slack.
_TOTP_VALID_WINDOW = 1


def _totp_matching_counter(secret: str, code: str) -> int | None:
    """The largest time-step counter within tolerance that `code` matches, or
    None. Returning the COUNTER rather than a bool is what lets the caller
    enforce monotonic anti-replay against `users.mfa_totp_last_counter`."""
    totp = pyotp.TOTP(secret)
    now_counter = int(time.time()) // totp.interval
    match: int | None = None
    for offset in range(-_TOTP_VALID_WINDOW, _TOTP_VALID_WINDOW + 1):
        counter = now_counter + offset
        # Constant-time (bytes, so a non-ASCII `code` is a mismatch rather than
        # compare_digest's TypeError): the code is a short-lived secret.
        if secrets.compare_digest(
            totp.at(for_time=counter * totp.interval).encode(), code.encode()
        ):
            if match is None or counter > match:
                match = counter
    return match


async def verify_totp_replay_safe(conn: AsyncConnection, user_id: str, secret: str, code: str) -> bool:
    """Atomic check-then-update of `users.mfa_totp_last_counter`. MUST run
    inside a transaction that holds the row lock through to commit — the
    FOR UPDATE is what makes two concurrent requests replaying the SAME
    captured code serialize instead of both passing the comparison before
    either commits (see docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7). Also
    doubles as enroll-confirm's first-ever check: with no prior counter
    (NULL -> -1), any matching code passes and seeds the column.
    """
    row = (
        await conn.execute(
            text("SELECT mfa_totp_last_counter FROM users WHERE id = :id FOR UPDATE"),
            {"id": user_id},
        )
    ).first()
    last_counter = (
        int(row.mfa_totp_last_counter) if row and row.mfa_totp_last_counter is not None else -1
    )
    counter = _totp_matching_counter(secret, code)
    if counter is None or counter <= last_counter:
        return False
    await conn.execute(
        text("UPDATE users SET mfa_totp_last_counter = :c WHERE id = :id"),
        {"c": counter, "id": user_id},
    )
    return True


# ── Backup codes ─────────────────────────────────────────────────────────────
BACKUP_CODE_COUNT = 10


def generate_backup_codes(n: int = BACKUP_CODE_COUNT) -> list[str]:
    """Human-typeable, high-entropy codes. Hashed with plain SHA-256 before
    storage (service.sha256_bytes, same as user_tokens/refresh_tokens) — these
    are high-entropy random secrets, not user-chosen passwords, so a slow KDF
    buys nothing."""
    codes = []
    for _ in range(n):
        raw = secrets.token_hex(5)
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes


async def store_backup_codes(conn: AsyncConnection, org_id: str, user_id: str, codes: list[str]) -> None:
    for code in codes:
        await conn.execute(
            text(
                "INSERT INTO mfa_backup_codes (id, user_id, org_id, code_hash) "
                "VALUES (:id, :uid, :org, :hash)"
            ),
            {
                "id": service.new_uuid(),
                "uid": user_id,
                "org": org_id,
                "hash": service.sha256_bytes(code),
            },
        )


async def invalidate_backup_codes(conn: AsyncConnection, user_id: str) -> None:
    """Burns every still-unused code. MUST run BEFORE inserting a fresh batch on
    regeneration — otherwise old codes stay valid indefinitely alongside the new
    ones, silently accumulating extra bypass credentials every regeneration."""
    await conn.execute(
        text(
            "UPDATE mfa_backup_codes SET used_at = now() "
            "WHERE user_id = :uid AND used_at IS NULL"
        ),
        {"uid": user_id},
    )


async def verify_and_consume_backup_code(conn: AsyncConnection, user_id: str, code: str) -> bool:
    """Single-use consume under FOR UPDATE, mirroring account_service's
    consume_token pattern."""
    row = (
        await conn.execute(
            text(
                "SELECT id, used_at FROM mfa_backup_codes "
                "WHERE user_id = :uid AND code_hash = :hash FOR UPDATE"
            ),
            {"uid": user_id, "hash": service.sha256_bytes(code)},
        )
    ).first()
    if row is None or row.used_at is not None:
        return False
    await conn.execute(
        text("UPDATE mfa_backup_codes SET used_at = now() WHERE id = :id"),
        {"id": str(row.id)},
    )
    return True


# ── Step-up re-auth (MFA-disable, backup-codes/regenerate) ───────────────────
async def identity_for_user(conn: AsyncConnection, user_id: str):
    """The identity row (`id`, `failed_login_count`, `locked_until`) behind a
    membership — the thing the shared lockout counts against."""
    return (
        await conn.execute(
            text(
                "SELECT i.id, i.failed_login_count, i.locked_until FROM identities i "
                "JOIN users u ON u.identity_id = i.id WHERE u.id = :uid"
            ),
            {"uid": user_id},
        )
    ).first()


def _raise_if_locked(ident) -> None:
    """429 while the identity is locked. Writes nothing, so it is safe to raise
    from inside the caller's transaction."""
    now = datetime.now(timezone.utc)
    if ident.locked_until is not None and ident.locked_until > now:
        retry = max(1, int((ident.locked_until - now).total_seconds()))
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "account temporarily locked due to failed attempts; try again later",
            headers={"Retry-After": str(retry)},
        )


_STEP_UP_LOCKED = "account temporarily locked due to failed attempts; try again later"


def _step_up_failed(ident) -> service.FailedAttempt:
    """The 401 for a failed re-auth, carried so `service.record_failed_attempts`
    counts it against the identity-level lockout `/auth/login` and
    `/auth/mfa/challenge/verify` share (and turns it into a 429 if it just
    locked) once the caller's transaction has rolled back.

    Not counted here: the caller's transaction rolls back on this very error, so
    the counter needs its own connection, and taking a second pooled connection
    while the request's is held is a self-deadlock under load (see
    `service.FailedAttempt`). Every caller therefore enters its transaction as
    `async with service.record_failed_attempts(), engine.begin() as conn:`.
    """
    return service.FailedAttempt(
        ident,
        HTTPException(status.HTTP_401_UNAUTHORIZED, "re-authentication failed"),
        locked_detail=_STEP_UP_LOCKED,
    )


async def _second_factor_ok(
    conn: AsyncConnection,
    org_id: str,
    user_id: str,
    secret_enc: bytes | None,
    totp_code: str | None,
    backup_code: str | None,
) -> bool:
    if totp_code:
        if secret_enc is None:
            return False
        secret = await cryptor().decrypt(conn, org_id, secret_enc)
        return await verify_totp_replay_safe(conn, user_id, secret, totp_code)
    if backup_code:
        return await verify_and_consume_backup_code(conn, user_id, backup_code)
    return False


async def verify_step_up(
    conn: AsyncConnection,
    org_id: str,
    user_id: str,
    password: str,
    totp_code: str | None,
    backup_code: str | None,
) -> bool:
    """Password + a still-valid current second factor. Used by the
    consequential actions an already-signed-in caller may take (MFA-disable,
    backup-codes/regenerate, overwriting an enrolled TOTP secret) so a stolen
    access token alone can never perform them.

    A step-up is a password/second-factor guessing surface exactly like
    `/auth/login`, so it is gated by the SAME identity lockout: a locked
    identity gets 429 before anything is verified, and every failure is counted
    (a wrong password or second factor raises `service.FailedAttempt`, which
    `service.record_failed_attempts` counts after the caller's transaction has
    rolled back — see `_step_up_failed`). Returns False only when there is no
    identity to count against.
    """
    ident = await identity_for_user(conn, user_id)
    if ident is not None:
        _raise_if_locked(ident)
    row = (
        await conn.execute(
            text("SELECT password_hash, mfa_totp_secret_enc FROM users WHERE id = :id"),
            {"id": user_id},
        )
    ).first()
    ok = (
        row is not None
        and await verify_password_async(row.password_hash, password)
        and await _second_factor_ok(
            conn, org_id, user_id, row.mfa_totp_secret_enc, totp_code, backup_code
        )
    )
    if not ok and ident is not None:
        raise _step_up_failed(ident)
    return ok


# ── Identity-wide MFA: new memberships and cross-org actions ─────────────────
async def _enrolled_memberships(conn: AsyncConnection, identity_id: str):
    """Active memberships of this identity that have a second factor enrolled.
    Cross-org: the caller must already hold the trusted RLS bypass."""
    return (
        await conn.execute(
            text(
                "SELECT id, org_id, mfa_totp_secret_enc FROM users "
                "WHERE identity_id = :iid AND mfa_enrolled AND status = 'active' "
                "ORDER BY mfa_enrolled_at DESC NULLS LAST, id"
            ),
            {"iid": identity_id},
        )
    ).all()


async def pending_for_new_membership(
    conn: AsyncConnection, identity_id: str, user_id: str, org_id: str, roles: list[str]
) -> MfaPendingDTO | None:
    """The MFA challenge owed before a session may be minted for a membership
    just created by `/auth/orgs` or `/auth/invites/accept`, or None if none is.

    Those two endpoints authenticate an EXISTING identity with its password
    alone and then used to hand back a full session straight away, so a
    password holder skipped the second factor `/auth/login` demands — and the
    session they got reaches identity-wide endpoints (`/auth/orgs/mine`,
    `/auth/orgs/{id}/leave`). Two cases, mirroring login:

      * the identity has MFA enrolled on another (or this) active membership:
        the factor is enrolled PER MEMBERSHIP, and the new one has none to
        challenge, so the pending token is minted for the enrolled membership.
        Completing it signs the person into THAT org; they reach the new one
        through the ordinary, MFA-gated org switch.
      * otherwise the new membership's own `mfa_gate` (org mandates MFA for
        admins and the grace period is over), exactly as at login.

    The caller must hold the trusted RLS bypass or an org context for `org_id`
    on entry; this function takes the bypass for its cross-org reads and mint,
    and drops it again before returning.
    """
    await service.set_bypass_rls(conn)
    pending: MfaPendingDTO | None = None
    enrolled = await _enrolled_memberships(conn, identity_id)
    if enrolled:
        target = enrolled[0]
        raw = await mint_mfa_pending(conn, str(target.org_id), str(target.id))
        pending = MfaPendingDTO(pendingToken=raw, methods=["totp"], enrollmentRequired=False)
    else:
        required, must_enroll_first = await mfa_gate(conn, user_id, org_id, roles)
        if required:
            raw = await mint_mfa_pending(conn, org_id, user_id)
            pending = MfaPendingDTO(
                pendingToken=raw,
                methods=[] if must_enroll_first else ["totp"],  # type: ignore[arg-type]
                enrollmentRequired=must_enroll_first,
            )
    # A DB error above aborts the transaction, so there is nothing to restore
    # on that path; on this one the caller carries on org-scoped.
    await conn.execute(text("SELECT set_config('app.bypass_rls', 'off', true)"))
    return pending


async def require_identity_step_up(
    conn: AsyncConnection, identity_id: str, step_up: MfaStepUpRequest | None
) -> None:
    """Step-up re-auth for an identity-wide action (leaving an org). A no-op
    unless the identity has MFA enrolled somewhere; then it needs the password
    plus a current second factor from any enrolled membership — the caller's
    own session may belong to a membership with none, which is why this cannot
    reuse `verify_step_up`'s per-membership check. Same lockout accounting.

    Cross-org: the caller must hold the trusted RLS bypass.
    """
    enrolled = await _enrolled_memberships(conn, identity_id)
    if not enrolled:
        return
    if step_up is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "re-authentication required")
    ident = (
        await conn.execute(
            text(
                "SELECT id, password_hash, failed_login_count, locked_until "
                "FROM identities WHERE id = :iid"
            ),
            {"iid": identity_id},
        )
    ).first()
    if ident is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "re-authentication failed")
    _raise_if_locked(ident)
    ok = await verify_password_async(ident.password_hash, step_up.password)
    if ok:
        ok = False
        for m in enrolled:
            if await _second_factor_ok(
                conn, str(m.org_id), str(m.id), m.mfa_totp_secret_enc,
                step_up.totpCode, step_up.backupCode,
            ):
                ok = True
                break
    if not ok:
        raise _step_up_failed(ident)
