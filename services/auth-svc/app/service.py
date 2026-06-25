"""Core identity operations: orgs, users, sessions, refresh-token rotation."""
from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone

import uuid6
from slugify import slugify as _slugify
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .config import settings
from .crypto import cryptor
from .schemas import SessionDTO, UserDTO
from .security.keys import mint_access_token


async def set_org_guc(conn: AsyncConnection, org_id: str) -> None:
    """Bind the per-org RLS context for the current transaction (FAIL-CLOSED).

    Must run as the FIRST statement inside every org-scoped transaction that
    touches an RLS table (users, user_roles, invites, audit_log, org_keys, orgs).
    Uses ``set_config(..., is_local=true)`` so the setting auto-resets at COMMIT/
    ROLLBACK and never leaks across pooled connections.
    """
    await conn.execute(
        text("SELECT set_config('app.org_id', :o, true)"), {"o": str(org_id)}
    )


async def set_bypass_rls(conn: AsyncConnection) -> None:
    """Disable RLS row filtering for the current transaction (TRUSTED code only).

    Set ONLY by server code for paths where the org is not yet known or spans
    orgs: pre-org-context auth flows (login/refresh look up by blind index /
    token hash) and cross-org background workers (the outbox poller). NEVER
    derive this from request input. Transaction-local (is_local=true).
    """
    await conn.execute(
        text("SELECT set_config('app.bypass_rls', 'on', true)")
    )


def new_uuid() -> str:
    return str(uuid6.uuid7())


def sha256_bytes(raw: str) -> bytes:
    return hashlib.sha256(raw.encode("utf-8")).digest()


def new_refresh_secret() -> str:
    return secrets.token_urlsafe(32)


async def unique_slug(conn: AsyncConnection, org_name: str) -> str:
    base = _slugify(org_name) or "org"
    candidate = base
    i = 1
    while True:
        exists = (
            await conn.execute(
                text("SELECT 1 FROM orgs WHERE slug = :slug"), {"slug": candidate}
            )
        ).first()
        if exists is None:
            return candidate
        i += 1
        candidate = f"{base}-{i}"


async def role_id(conn: AsyncConnection, name: str) -> int:
    row = (
        await conn.execute(text("SELECT id FROM roles WHERE name = :n"), {"n": name})
    ).first()
    if row is None:
        raise RuntimeError(f"role {name!r} not seeded")
    return int(row.id)


async def roles_for_user(conn: AsyncConnection, user_id: str) -> list[str]:
    rows = (
        await conn.execute(
            text(
                """
                SELECT r.name
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = :uid
                ORDER BY r.name
                """
            ),
            {"uid": user_id},
        )
    ).all()
    return [r.name for r in rows]


async def user_dto(conn: AsyncConnection, user_id: str) -> UserDTO | None:
    row = (
        await conn.execute(
            text(
                "SELECT id, org_id, username, display_name_enc, email_enc FROM users WHERE id = :id"
            ),
            {"id": user_id},
        )
    ).first()
    if row is None:
        return None
    roles = await roles_for_user(conn, user_id)
    # Transparent decrypt — email/display_name are stored AES-256-GCM-encrypted at
    # rest. Callers (incl. the internal user-lookup that powers the offline-email
    # relay) get plaintext, so no downstream feature changes.
    org_id = str(row.org_id)
    c = cryptor()
    email = await c.decrypt(conn, org_id, row.email_enc)
    display_name = await c.decrypt(conn, org_id, row.display_name_enc)
    return UserDTO(
        id=str(row.id),
        orgId=org_id,
        username=row.username,
        displayName=display_name or "",
        email=email or "",
        roles=roles,  # type: ignore[arg-type]
    )


async def update_display_name(
    conn: AsyncConnection, org_id: str, user_id: str, display_name: str
) -> None:
    enc = await cryptor().encrypt(conn, org_id, display_name)
    await conn.execute(
        text("UPDATE users SET display_name_enc = :dn WHERE id = :id"),
        {"dn": enc, "id": user_id},
    )


async def issue_refresh_token(
    conn: AsyncConnection,
    *,
    user_id: str,
    family_id: str,
) -> str:
    """Create a refresh-token row and return the raw opaque secret."""
    raw = new_refresh_secret()
    expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=settings.jwt_refresh_ttl_seconds
    )
    await conn.execute(
        text(
            """
            INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at)
            VALUES (:id, :uid, :hash, :fam, :exp)
            """
        ),
        {
            "id": new_uuid(),
            "uid": user_id,
            "hash": sha256_bytes(raw),
            "fam": family_id,
            "exp": expires_at,
        },
    )
    return raw


async def build_session(
    conn: AsyncConnection, user_id: str
) -> tuple[SessionDTO, str]:
    """Mint an access token + new refresh family; return (SessionDTO, raw refresh)."""
    dto = await user_dto(conn, user_id)
    if dto is None:
        raise RuntimeError("user not found while building session")
    token, ttl = mint_access_token(
        user_id=dto.id, org_id=dto.orgId, roles=list(dto.roles), username=dto.username
    )
    family_id = new_uuid()
    raw_refresh = await issue_refresh_token(conn, user_id=user_id, family_id=family_id)
    return SessionDTO(accessToken=token, user=dto, expiresIn=ttl), raw_refresh


async def rotate_refresh_token(
    conn: AsyncConnection, raw_token: str
) -> tuple[SessionDTO, str]:
    """Rotate a refresh token. Reuse of a rotated token revokes the family."""
    token_hash = sha256_bytes(raw_token)
    row = (
        await conn.execute(
            text(
                """
                SELECT id, user_id, family_id, rotated_to, revoked, expires_at
                FROM refresh_tokens
                WHERE token_hash = :hash
                FOR UPDATE
                """
            ),
            {"hash": token_hash},
        )
    ).first()

    if row is None:
        raise ValueError("invalid refresh token")

    now = datetime.now(timezone.utc)

    # Reuse detection: token already rotated or revoked -> revoke entire family.
    if row.revoked or row.rotated_to is not None:
        await conn.execute(
            text("UPDATE refresh_tokens SET revoked = true WHERE family_id = :fam"),
            {"fam": str(row.family_id)},
        )
        raise ValueError("refresh token reuse detected")

    if row.expires_at <= now:
        raise ValueError("refresh token expired")

    user_id = str(row.user_id)
    family_id = str(row.family_id)

    # Issue the next family member, then point the old token at it + revoke it.
    new_raw = await issue_refresh_token(conn, user_id=user_id, family_id=family_id)
    new_row = (
        await conn.execute(
            text(
                "SELECT id FROM refresh_tokens WHERE token_hash = :h"
            ),
            {"h": sha256_bytes(new_raw)},
        )
    ).first()
    await conn.execute(
        text(
            "UPDATE refresh_tokens SET rotated_to = :to, revoked = true WHERE id = :id"
        ),
        {"to": str(new_row.id), "id": str(row.id)},
    )

    dto = await user_dto(conn, user_id)
    if dto is None:
        raise ValueError("user not found")
    token, ttl = mint_access_token(
        user_id=dto.id, org_id=dto.orgId, roles=list(dto.roles), username=dto.username
    )
    return SessionDTO(accessToken=token, user=dto, expiresIn=ttl), new_raw


async def revoke_family_by_token(conn: AsyncConnection, raw_token: str) -> None:
    token_hash = sha256_bytes(raw_token)
    row = (
        await conn.execute(
            text("SELECT family_id FROM refresh_tokens WHERE token_hash = :h"),
            {"h": token_hash},
        )
    ).first()
    if row is not None:
        await conn.execute(
            text("UPDATE refresh_tokens SET revoked = true WHERE family_id = :fam"),
            {"fam": str(row.family_id)},
        )


# ── Tamper-evident audit log (hash chain) ─────────────────────────────────────
# Each entry chains to the previous one for its org:
#   entry_hash = SHA256(prev_hash || canonical(org, actor, action, target, meta, at))
# The first entry chains from a fixed genesis. Any edit/delete/reorder breaks the
# chain from that point, which verify_audit_chain() detects.
_AUDIT_GENESIS = b"\x00" * 32


def _canonical_meta(meta: dict | str | None) -> str | None:
    """Stable JSON serialization used identically on write and verify (so the
    jsonb round-trip can't change the hashed bytes). Accepts a dict (write) or the
    jsonb text read back (verify)."""
    if meta is None:
        return None
    obj = json.loads(meta) if isinstance(meta, str) else meta
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _audit_entry_hash(
    prev_hash: bytes,
    org_id: str,
    actor_id: str | None,
    action: str,
    target: str | None,
    meta_json: str | None,
    at: datetime,
) -> bytes:
    payload = "\x1f".join(
        [org_id, actor_id or "", action, target or "", meta_json or "", at.isoformat()]
    ).encode("utf-8")
    return hashlib.sha256(prev_hash + payload).digest()


async def write_audit(
    conn: AsyncConnection,
    *,
    org_id: str,
    actor_id: str | None,
    action: str,
    target: str | None,
    meta: dict | None = None,
) -> None:
    # Serialize per-org audit writes (txn-scoped advisory lock, released at commit)
    # so concurrent writers can't fork the hash chain.
    await conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k)::bigint)"),
        {"k": f"audit:{org_id}"},
    )
    prev = (
        await conn.execute(
            text(
                "SELECT entry_hash FROM audit_log WHERE org_id = :o "
                "ORDER BY id DESC LIMIT 1"
            ),
            {"o": org_id},
        )
    ).scalar()
    prev_hash = bytes(prev) if prev is not None else _AUDIT_GENESIS
    at = datetime.now(timezone.utc)
    meta_json = _canonical_meta(meta)
    entry_hash = _audit_entry_hash(prev_hash, org_id, actor_id, action, target, meta_json, at)
    await conn.execute(
        text(
            """
            INSERT INTO audit_log (org_id, actor_id, action, target, meta, at, prev_hash, entry_hash)
            VALUES (:org, :actor, :action, :target, CAST(:meta AS jsonb), :at, :prev_hash, :entry_hash)
            """
        ),
        {
            "org": org_id,
            "actor": actor_id,
            "action": action,
            "target": target,
            "meta": meta_json,
            "at": at,
            "prev_hash": prev_hash,
            "entry_hash": entry_hash,
        },
    )


async def verify_audit_chain(conn: AsyncConnection, org_id: str) -> dict:
    """Re-walk an org's audit chain and confirm every link. Returns
    {ok, count, broken_at, reason}. broken_at is the id of the first bad row."""
    rows = (
        await conn.execute(
            text(
                "SELECT id, actor_id, action, target, meta, at, prev_hash, entry_hash "
                "FROM audit_log WHERE org_id = :o ORDER BY id ASC"
            ),
            {"o": org_id},
        )
    ).all()
    expected_prev = _AUDIT_GENESIS
    for r in rows:
        stored_prev = bytes(r.prev_hash) if r.prev_hash is not None else None
        if stored_prev != expected_prev:
            return {"ok": False, "count": len(rows), "broken_at": int(r.id), "reason": "prev_hash mismatch"}
        meta_json = _canonical_meta(r.meta) if r.meta is not None else None
        recomputed = _audit_entry_hash(
            expected_prev,
            org_id,
            str(r.actor_id) if r.actor_id is not None else None,
            r.action,
            r.target,
            meta_json,
            r.at,
        )
        if r.entry_hash is None or bytes(r.entry_hash) != recomputed:
            return {"ok": False, "count": len(rows), "broken_at": int(r.id), "reason": "entry_hash mismatch"}
        expected_prev = bytes(r.entry_hash)
    return {"ok": True, "count": len(rows), "broken_at": None, "reason": None}
