"""MFA shared logic: the "MFA pending" token, the restricted enrollment
credential, TOTP replay-safe verification, backup codes, and WebAuthn
challenge storage. Thin route layers (mfa_totp.py, mfa_webauthn.py,
mfa_challenge.py) sit on top of this, mirroring the existing
account_service.py/invites_service.py split. See
docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7.

── Storage: `users`, not `identities` ────────────────────────────────────────
MFA state lives per org-membership on `users` — `identities` (the cross-org
shared credential) has no per-identity encryption mechanism, while `users`
already has the only existing encrypted-column convention (email_enc/
email_bidx) via the shared Cryptor class, which is strictly per-org (org_id is
the AAD). Accepted consequence: a user with two org memberships enrolls
TOTP/WebAuthn twice — consistent with the mandatory policy itself being an
org-admin setting, not an identity-wide one.

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
from ..security.passwords import verify_password_async
from .account_service import consume_token, mint_token, peek_token

PURPOSE_MFA_PENDING = "mfa_pending"
PURPOSE_WEBAUTHN_CHALLENGE = "webauthn_challenge"


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
    """Entry point for mfa_totp.py's / mfa_webauthn.py's enroll/registration
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


async def enrolled_methods(conn: AsyncConnection, user_id: str) -> list[str]:
    """Which second factors this membership can actually present right now —
    what MfaPendingDTO.methods tells the client to offer. Backup codes are
    deliberately not in this list: they're always offerable as a fallback
    (when any unused code exists), not a primary method to choose between."""
    row = (
        await conn.execute(
            text(
                """
                SELECT (u.mfa_totp_secret_enc IS NOT NULL) AS has_totp,
                       EXISTS(
                           SELECT 1 FROM mfa_webauthn_credentials w WHERE w.user_id = u.id
                       ) AS has_webauthn
                FROM users u WHERE u.id = :id
                """
            ),
            {"id": user_id},
        )
    ).first()
    if row is None:
        return []
    methods = []
    if row.has_totp:
        methods.append("totp")
    if row.has_webauthn:
        methods.append("webauthn")
    return methods


# ── TOTP ──────────────────────────────────────────────────────────────────────
def generate_totp_secret() -> str:
    return pyotp.random_base32()


def totp_otpauth_url(secret: str, *, account_name: str) -> str:
    return pyotp.totp.TOTP(secret).provisioning_uri(
        name=account_name, issuer_name=settings.webauthn_rp_name
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
        if totp.at(for_time=counter * totp.interval) == code:
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


# ── WebAuthn challenge storage ───────────────────────────────────────────────
async def mint_webauthn_challenge(conn: AsyncConnection, org_id: str, user_id: str) -> bytes:
    """A fresh single-use challenge, stored via the SAME user_tokens
    infrastructure the MFA-pending token uses rather than a new table: the
    "raw" secret user_tokens already mints IS a random byte string, which is
    exactly what a WebAuthn challenge is. Returned as bytes for the `webauthn`
    library's `challenge=` parameter."""
    raw, _ = await mint_token(
        conn, org_id, user_id, PURPOSE_WEBAUTHN_CHALLENGE, timedelta(minutes=5)
    )
    return raw.encode("ascii")


async def consume_webauthn_challenge(conn: AsyncConnection, challenge: bytes) -> tuple[str, str]:
    """Redeem a challenge extracted from a verified ceremony's clientDataJSON.
    Single-use + expiry via account_service.consume_token — this is what
    satisfies "challenge is fresh and single-use, matches a challenge this
    server issued, not previously consumed" from the Phase 7 acceptance
    criteria."""
    return await consume_token(conn, PURPOSE_WEBAUTHN_CHALLENGE, challenge.decode("ascii"))


# ── Step-up re-auth (MFA-disable, backup-codes/regenerate) ───────────────────
async def verify_step_up(
    conn: AsyncConnection,
    org_id: str,
    user_id: str,
    password: str,
    totp_code: str | None,
    backup_code: str | None,
    webauthn_credential: dict | None = None,
) -> bool:
    """Password + a still-valid current second factor. Used by two
    consequential actions an already-signed-in caller may take (MFA-disable,
    backup-codes/regenerate) so a stolen access token alone can never perform
    either.

    `webauthn_credential` covers the passkey-only enrollee, who has no TOTP
    code or backup code to present here at all — without it, that enrollment
    path could never satisfy step-up and would be permanently unable to
    disable MFA or regenerate backup codes. Verified via
    mfa_webauthn.verify_webauthn_assertion — the SAME assertion-checking
    logic the login-time challenge uses (challenge freshness, RP/origin,
    sign-count anti-clone), just scoped by a challenge minted for THIS
    already-authenticated user rather than resolved from a login-pending
    token. Imported locally: mfa_webauthn imports this module at top level,
    so a module-level import here would be circular.
    """
    row = (
        await conn.execute(
            text("SELECT password_hash, mfa_totp_secret_enc FROM users WHERE id = :id"),
            {"id": user_id},
        )
    ).first()
    if row is None or not await verify_password_async(row.password_hash, password):
        return False
    if totp_code:
        if row.mfa_totp_secret_enc is None:
            return False
        secret = await cryptor().decrypt(conn, org_id, row.mfa_totp_secret_enc)
        return await verify_totp_replay_safe(conn, user_id, secret, totp_code)
    if backup_code:
        return await verify_and_consume_backup_code(conn, user_id, backup_code)
    if webauthn_credential:
        from .mfa_webauthn import verify_webauthn_assertion

        try:
            asserted_user_id, _asserted_org_id = await verify_webauthn_assertion(conn, webauthn_credential)
        except HTTPException:
            # Wrong/replayed/malformed assertion — same "step-up failed"
            # outcome as a wrong password or code, not a distinct error shape.
            return False
        return asserted_user_id == user_id
    return False
