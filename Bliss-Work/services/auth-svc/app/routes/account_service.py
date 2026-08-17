"""Non-route helpers for password-reset and email-verification.

Both flows are single-use email tokens: the raw token is emailed once, only its
SHA-256 is stored (`user_tokens.token_hash`), and it is consumed atomically under
`SELECT ... FOR UPDATE`. The invite flow (`invites_service.py`) is the sibling
template; this module factors the token mint/consume so password-reset and
email-verify share one audited, RLS-safe code path.

All functions operate within a caller-supplied transaction so the outbox insert
stays atomic with the state change.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .. import service
from ..config import settings
from ..crypto import cryptor
from ..events.outbox import TOPIC_AUTH, build_event, enqueue_event
from ..security.passwords import (
    PASSWORD_POLICY_MESSAGE,
    hash_password_async,
    password_meets_policy,
)
from .invites_service import iso_z

PURPOSE_RESET = "password_reset"
PURPOSE_VERIFY = "email_verify"


async def _mint_token(
    conn: AsyncConnection, org_id: str, user_id: str, purpose: str, ttl: timedelta
) -> tuple[str, datetime]:
    """Invalidate the user's outstanding tokens of this purpose, mint a fresh
    single-use token, persist only its hash, and return (raw_token, expires_at).
    The invalidation means the latest link is the only live one."""
    await conn.execute(
        text(
            "UPDATE user_tokens SET status = 'used', used_at = now() "
            "WHERE user_id = :uid AND purpose = :p AND status = 'pending'"
        ),
        {"uid": user_id, "p": purpose},
    )
    raw = service.new_refresh_secret()
    expires_at = datetime.now(timezone.utc) + ttl
    await conn.execute(
        text(
            """
            INSERT INTO user_tokens (id, org_id, user_id, purpose, token_hash, expires_at)
            VALUES (:id, :org, :uid, :p, :hash, :exp)
            """
        ),
        {
            "id": service.new_uuid(),
            "org": org_id,
            "uid": user_id,
            "p": purpose,
            "hash": service.sha256_bytes(raw),
            "exp": expires_at,
        },
    )
    return raw, expires_at


async def _consume_token(
    conn: AsyncConnection, purpose: str, raw_token: str
) -> tuple[str, str]:
    """Validate + single-use consume a token under FOR UPDATE (so it cannot be
    redeemed twice concurrently). Returns (user_id, org_id). Raises 400 on any
    invalid/expired/already-used token — a single generic error, never leaking
    which check failed."""
    row = (
        await conn.execute(
            text(
                """
                SELECT id, org_id, user_id, status, expires_at
                FROM user_tokens
                WHERE token_hash = :hash AND purpose = :p
                FOR UPDATE
                """
            ),
            {"hash": service.sha256_bytes(raw_token), "p": purpose},
        )
    ).first()
    now = datetime.now(timezone.utc)
    if row is None or row.status != "pending" or row.expires_at <= now:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid or expired token")
    await conn.execute(
        text("UPDATE user_tokens SET status = 'used', used_at = now() WHERE id = :id"),
        {"id": str(row.id)},
    )
    return str(row.user_id), str(row.org_id)


async def peek_token_valid(conn: AsyncConnection, purpose: str, raw_token: str) -> bool:
    """Read-only validity check (does NOT consume) — powers the reset/verify
    landing pages so the UI can show 'link expired' before asking for a password.
    Runs under bypass (pre-org-context: the token is found before the org)."""
    await service.set_bypass_rls(conn)
    row = (
        await conn.execute(
            text(
                "SELECT status, expires_at FROM user_tokens "
                "WHERE token_hash = :hash AND purpose = :p"
            ),
            {"hash": service.sha256_bytes(raw_token), "p": purpose},
        )
    ).first()
    now = datetime.now(timezone.utc)
    return row is not None and row.status == "pending" and row.expires_at > now


# ── Password reset ───────────────────────────────────────────────────────────
async def create_password_reset_tx(conn: AsyncConnection, email: str) -> None:
    """Look up the user by email blind index and, IF FOUND, mint + email a reset
    link. Deliberately returns None either way — the caller always responds with
    the same generic message so an attacker can't probe which emails exist.
    Pre-org-context lookup runs under bypass, mirroring `login`."""
    await service.set_bypass_rls(conn)
    # Resolve the shared identity by the global email blind index, then pick any
    # active membership to carry the reset token (user_tokens needs user_id+org_id).
    # The reset applies to the identity's credential, so which membership is moot.
    ident = (
        await conn.execute(
            text("SELECT id FROM identities WHERE email_bidx = :bidx"),
            {"bidx": cryptor().blind_index(email)},
        )
    ).first()
    if ident is None:
        return  # generic: no signal whether the email matched an account
    row = (
        await conn.execute(
            text(
                "SELECT id, org_id FROM users WHERE identity_id = :iid AND status = 'active' "
                "ORDER BY created_at ASC LIMIT 1"
            ),
            {"iid": str(ident.id)},
        )
    ).first()
    if row is None:
        return

    user_id, org_id = str(row.id), str(row.org_id)
    raw, expires_at = await _mint_token(
        conn,
        org_id,
        user_id,
        PURPOSE_RESET,
        timedelta(minutes=settings.reset_token_ttl_minutes),
    )
    reset_url = f"{settings.reset_password_url}?token={raw}"
    event = build_event(
        "password.reset.requested",
        org_id,
        userId=user_id,
        email=email,
        resetUrl=reset_url,
        expiresAt=iso_z(expires_at),
    )
    await enqueue_event(conn, topic=TOPIC_AUTH, kafka_key=user_id, event=event)
    await service.write_audit(
        conn,
        org_id=org_id,
        actor_id=user_id,
        action="password.reset_requested",
        target=user_id,
    )


async def reset_password_tx(conn: AsyncConnection, token: str, new_password: str) -> None:
    """Consume a reset token and set the new password. Enforces the password
    policy BEFORE burning the token (a weak password can be retried on the same
    link), then revokes every session so a stolen refresh token dies on reset."""
    if not password_meets_policy(new_password):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, PASSWORD_POLICY_MESSAGE)
    await service.set_bypass_rls(conn)
    user_id, org_id = await _consume_token(conn, PURPOSE_RESET, token)
    new_hash = await hash_password_async(new_password)
    # Reset the SHARED credential (all memberships) + kill every session across orgs.
    iid = await service.identity_id_for_user(conn, user_id)
    if iid is not None:
        await service.set_identity_password(conn, iid, new_hash)
        await service.revoke_all_identity_tokens(conn, iid)
    else:
        await service.update_password(conn, user_id, new_hash)  # legacy fallback
        await service.revoke_all_user_tokens(conn, user_id)
    await service.write_audit(
        conn,
        org_id=org_id,
        actor_id=user_id,
        action="password.reset_completed",
        target=user_id,
    )


# ── Email verification ───────────────────────────────────────────────────────
async def create_email_verification_tx(
    conn: AsyncConnection, user_id: str, org_id: str, email: str
) -> None:
    """Mint + email a verification link. Called from signup (inside create_org's
    org-scoped tx) and from the authed resend endpoint. Assumes the caller has
    already scoped the tx (org GUC or bypass)."""
    raw, expires_at = await _mint_token(
        conn,
        org_id,
        user_id,
        PURPOSE_VERIFY,
        timedelta(hours=settings.email_verify_ttl_hours),
    )
    verify_url = f"{settings.verify_email_url}?token={raw}"
    event = build_event(
        "email.verification.requested",
        org_id,
        userId=user_id,
        email=email,
        verifyUrl=verify_url,
        expiresAt=iso_z(expires_at),
    )
    await enqueue_event(conn, topic=TOPIC_AUTH, kafka_key=user_id, event=event)


async def verify_email_tx(conn: AsyncConnection, token: str) -> None:
    """Consume a verification token and flip users.email_verified = true."""
    await service.set_bypass_rls(conn)
    user_id, org_id = await _consume_token(conn, PURPOSE_VERIFY, token)
    iid = await service.identity_id_for_user(conn, user_id)
    if iid is not None:
        await service.set_identity_verified(conn, iid)  # verifies the shared identity
    else:
        await conn.execute(
            text("UPDATE users SET email_verified = true WHERE id = :id"),
            {"id": user_id},
        )
    await service.write_audit(
        conn,
        org_id=org_id,
        actor_id=user_id,
        action="email.verified",
        target=user_id,
    )
