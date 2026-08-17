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
                "SELECT u.id, u.org_id, u.username, u.display_name_enc, u.email_enc, "
                "       u.email_verified, o.plan, o.name AS org_name "
                "FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = :id"
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
        orgName=row.org_name or "",
        username=row.username,
        displayName=display_name or "",
        email=email or "",
        roles=roles,  # type: ignore[arg-type]
        emailVerified=bool(row.email_verified),
        plan=row.plan or "free",
    )


async def user_dtos_for_org(
    conn: AsyncConnection,
    org_id: str,
    *,
    include_inactive: bool = False,
    limit: int,
    offset: int = 0,
) -> list[UserDTO]:
    """The org's members, in TWO queries regardless of how many there are.

    Replaces a loop of `user_dto()` calls. That loop was 2N+1 round trips for an
    N-member org — one to list the ids, then a user row and a roles lookup for
    every id — on an endpoint the SPA calls to resolve names for the people
    list, the mention picker and incoming calls. At a few dozen colleagues that
    is invisible; at twenty thousand it is forty thousand queries to draw a
    sidebar.

    Two queries instead: the members, then every role for those members in one
    `= ANY(...)`. Decryption stays per-row because it must — each value is
    separately AES-GCM sealed — but the org's key is cached after the first use,
    so it is CPU and not another round trip.
    """
    rows = (
        await conn.execute(
            text(
                """
                SELECT u.id, u.org_id, u.username, u.display_name_enc,
                       u.email_enc, u.email_verified, o.plan, o.name AS org_name
                FROM users u
                JOIN orgs o ON o.id = u.org_id
                WHERE u.org_id = :org
                  AND (CAST(:all AS boolean) OR u.status = 'active')
                ORDER BY u.username
                LIMIT :lim OFFSET :off
                """
            ),
            {"org": org_id, "all": include_inactive, "lim": limit, "off": offset},
        )
    ).all()
    if not rows:
        return []

    user_ids = [str(r.id) for r in rows]
    role_rows = (
        await conn.execute(
            text(
                """
                SELECT ur.user_id, r.name
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = ANY(CAST(:uids AS uuid[]))
                ORDER BY ur.user_id, r.name
                """
            ),
            {"uids": user_ids},
        )
    ).all()
    roles_by_user: dict[str, list[str]] = {}
    for rr in role_rows:
        roles_by_user.setdefault(str(rr.user_id), []).append(rr.name)

    c = cryptor()
    out: list[UserDTO] = []
    for r in rows:
        row_org = str(r.org_id)
        out.append(
            UserDTO(
                id=str(r.id),
                orgId=row_org,
                orgName=r.org_name or "",
                username=r.username,
                displayName=(await c.decrypt(conn, row_org, r.display_name_enc)) or "",
                email=(await c.decrypt(conn, row_org, r.email_enc)) or "",
                roles=roles_by_user.get(str(r.id), []),  # type: ignore[arg-type]
                emailVerified=bool(r.email_verified),
                plan=r.plan or "free",
            )
        )
    return out


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
) -> tuple[str, str]:
    """Create a refresh-token row; return (raw opaque secret, row id).

    The id is returned rather than looked up afterwards. Rotation needs it to
    set `rotated_to` on the token being replaced, and it used to recover it with
    a second `SELECT ... WHERE token_hash = :h` — re-reading a row this function
    had just written, whose id it had just generated. That is one round trip per
    refresh, on the single most frequently executed write path in the platform.
    """
    raw = new_refresh_secret()
    token_id = new_uuid()
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
            "id": token_id,
            "uid": user_id,
            "hash": sha256_bytes(raw),
            "fam": family_id,
            "exp": expires_at,
        },
    )
    return raw, token_id


async def build_session(
    conn: AsyncConnection, user_id: str
) -> tuple[SessionDTO, str]:
    """Mint an access token + new refresh family; return (SessionDTO, raw refresh)."""
    dto = await user_dto(conn, user_id)
    if dto is None:
        raise RuntimeError("user not found while building session")
    token, ttl = mint_access_token(
        user_id=dto.id, org_id=dto.orgId, roles=list(dto.roles), username=dto.username, plan=dto.plan
    )
    family_id = new_uuid()
    raw_refresh, _ = await issue_refresh_token(conn, user_id=user_id, family_id=family_id)
    return SessionDTO(accessToken=token, user=dto, expiresIn=ttl), raw_refresh


# A refresh token that was rotated moments ago is far more likely to be an
# honest replay than theft: a request retried after a dropped connection, a
# rotation whose response never reached the client (a deploy recycling the edge
# mid-flight), or two of the user's own clients a second apart. Revoking the
# family for those turns a blip into a forced logout — and, before the client
# learned to give up, into an endless 401 loop. Inside this window we issue a
# fresh token in the same family instead.
#
# The cost, stated plainly: a genuinely stolen token replayed within the window
# is honoured rather than triggering revocation. That is the standard trade-off
# for rotating refresh tokens; anything older than the window still revokes.
REFRESH_REPLAY_GRACE = timedelta(seconds=30)


class RefreshError(ValueError):
    """Why a refresh was rejected.

    `code` is what the client sees, and it decides what the client DOES:
    'reused', 'expired' and 'deactivated' are terminal (this session is over —
    log in again), while a transport-level failure is not and must not log
    anyone out. Terminal codes are mirrored in packages/app/src/lib/refresh.ts.
    """

    def __init__(self, code: str, message: str, *, user_id: str | None = None, family_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.user_id = user_id
        self.family_id = family_id


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
        raise RefreshError("unknown", "invalid refresh token")

    now = datetime.now(timezone.utc)

    # Reuse detection: token already rotated or revoked -> revoke entire family,
    # unless the successor was issued within the replay grace window (above).
    if row.revoked or row.rotated_to is not None:
        successor_at = None
        if row.rotated_to is not None:
            successor_at = (
                await conn.execute(
                    text("SELECT issued_at FROM refresh_tokens WHERE id = :id AND NOT revoked"),
                    {"id": str(row.rotated_to)},
                )
            ).scalar()
        fresh_replay = successor_at is not None and (now - successor_at) <= REFRESH_REPLAY_GRACE
        if not fresh_replay:
            await conn.execute(
                text("UPDATE refresh_tokens SET revoked = true WHERE family_id = :fam"),
                {"fam": str(row.family_id)},
            )
            raise RefreshError(
                "reused",
                "refresh token reuse detected",
                user_id=str(row.user_id),
                family_id=str(row.family_id),
            )

    if row.expires_at <= now:
        raise RefreshError(
            "expired",
            "refresh token expired",
            user_id=str(row.user_id),
            family_id=str(row.family_id),
        )

    user_id = str(row.user_id)
    family_id = str(row.family_id)

    # Membership backstop. Suspend/remove revokes every family in the same
    # transaction, so this should never fire — but /auth/refresh is the one
    # chokepoint EVERY long-lived session passes through, and a session that
    # outlives a deactivation is precisely the failure this feature exists to
    # prevent. Cheap to check, and it fails closed if a future code path forgets
    # to revoke.
    status_row = (
        await conn.execute(
            text("SELECT status FROM users WHERE id = :uid"), {"uid": user_id}
        )
    ).first()
    if status_row is None or status_row.status != "active":
        await conn.execute(
            text("UPDATE refresh_tokens SET revoked = true WHERE family_id = :fam"),
            {"fam": family_id},
        )
        raise RefreshError(
            "deactivated",
            "membership is no longer active",
            user_id=user_id,
            family_id=family_id,
        )

    # Issue the next family member, then point the old token at it + revoke it.
    new_raw, new_id = await issue_refresh_token(conn, user_id=user_id, family_id=family_id)
    await conn.execute(
        text(
            "UPDATE refresh_tokens SET rotated_to = :to, revoked = true WHERE id = :id"
        ),
        {"to": new_id, "id": str(row.id)},
    )

    dto = await user_dto(conn, user_id)
    if dto is None:
        raise ValueError("user not found")
    token, ttl = mint_access_token(
        user_id=dto.id, org_id=dto.orgId, roles=list(dto.roles), username=dto.username, plan=dto.plan
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


async def revoke_all_user_tokens(conn: AsyncConnection, user_id: str) -> None:
    """Revoke EVERY refresh-token family for a user (all sessions/devices). Called
    after a password reset so a compromised-credential session can't survive the
    reset. refresh_tokens has no RLS, so this runs fine under bypass."""
    await conn.execute(
        text("UPDATE refresh_tokens SET revoked = true WHERE user_id = :uid"),
        {"uid": user_id},
    )


async def update_password(conn: AsyncConnection, user_id: str, new_hash: str) -> None:
    """Set a user's Argon2 password hash. `users` is RLS — the caller must have
    scoped the tx (org GUC or bypass) before calling."""
    await conn.execute(
        text("UPDATE users SET password_hash = :ph WHERE id = :id"),
        {"ph": new_hash, "id": user_id},
    )


# ── Cross-org identity (multi-org membership) ─────────────────────────────────
# `identities` is the source of truth for the shared credential (password,
# email-verified, lockout). `users` keeps synced copies for backward-compat.
# All of these run under bypass (identity resolution spans orgs).


async def identity_by_bidx(conn: AsyncConnection, email_bidx: bytes):
    return (
        await conn.execute(
            text(
                "SELECT id, password_hash, email_verified, failed_login_count, "
                "       locked_until, last_user_id FROM identities WHERE email_bidx = :b"
            ),
            {"b": email_bidx},
        )
    ).first()


async def identity_id_for_user(conn: AsyncConnection, user_id: str) -> str | None:
    row = (
        await conn.execute(
            text("SELECT identity_id FROM users WHERE id = :id"), {"id": user_id}
        )
    ).first()
    return str(row.identity_id) if row and row.identity_id else None


async def default_membership(conn: AsyncConnection, identity) -> str | None:
    """The membership (users.id) to open by default: last-used if still a valid
    active membership, else the oldest ACTIVE one. Powers 'open last org'.

    The fallback filters on `status = 'active'` in the WHERE clause, not merely
    in the ORDER BY. Sorting by `(status = 'active') DESC` — as this did before
    member suspension existed — returns a suspended membership whenever no
    active one remains, which would have let a suspended user log straight in.
    """
    if identity.last_user_id:
        row = (
            await conn.execute(
                text(
                    "SELECT id FROM users WHERE id = :id AND identity_id = :iid "
                    "AND status = 'active'"
                ),
                {"id": str(identity.last_user_id), "iid": str(identity.id)},
            )
        ).first()
        if row:
            return str(row.id)
    row = (
        await conn.execute(
            text(
                "SELECT id FROM users WHERE identity_id = :iid AND status = 'active' "
                "ORDER BY created_at ASC LIMIT 1"
            ),
            {"iid": str(identity.id)},
        )
    ).first()
    return str(row.id) if row else None


async def has_any_membership(conn: AsyncConnection, identity_id: str) -> bool:
    """True when the identity has at least one membership in ANY state.

    Distinguishes 'this credential was never a member of anything' (→ generic
    401, no account oracle) from 'every membership has been suspended or
    removed' (→ a specific 403 the user can act on). Safe to be specific in the
    second case: the caller already proved they own the credential.
    """
    row = (
        await conn.execute(
            text("SELECT 1 FROM users WHERE identity_id = :iid LIMIT 1"),
            {"iid": identity_id},
        )
    ).first()
    return row is not None


async def membership_in_org(conn: AsyncConnection, identity_id: str, org_id: str) -> str | None:
    row = (
        await conn.execute(
            text(
                "SELECT id FROM users WHERE identity_id = :iid AND org_id = :o "
                "AND status = 'active' LIMIT 1"
            ),
            {"iid": identity_id, "o": org_id},
        )
    ).first()
    return str(row.id) if row else None


async def memberships_for_identity(conn: AsyncConnection, identity_id: str) -> list[dict]:
    rows = (
        await conn.execute(
            text(
                "SELECT u.id AS user_id, u.org_id, o.name AS org_name FROM users u "
                "JOIN orgs o ON o.id = u.org_id "
                "WHERE u.identity_id = :iid AND u.status = 'active' ORDER BY o.name"
            ),
            {"iid": identity_id},
        )
    ).all()
    out: list[dict] = []
    for r in rows:
        roles = await roles_for_user(conn, str(r.user_id))
        out.append(
            {"userId": str(r.user_id), "orgId": str(r.org_id), "orgName": r.org_name, "roles": roles}
        )
    return out


async def touch_last_user(conn: AsyncConnection, identity_id: str, user_id: str) -> None:
    await conn.execute(
        text("UPDATE identities SET last_user_id = :u WHERE id = :iid"),
        {"u": user_id, "iid": identity_id},
    )


async def reset_identity_lockout(conn: AsyncConnection, identity_id: str) -> None:
    await conn.execute(
        text(
            "UPDATE identities SET failed_login_count = 0, locked_until = NULL WHERE id = :iid"
        ),
        {"iid": identity_id},
    )


async def set_identity_password(conn: AsyncConnection, identity_id: str, new_hash: str) -> None:
    """Update the shared credential + keep per-membership copies in sync."""
    await conn.execute(
        text("UPDATE identities SET password_hash = :h WHERE id = :iid"),
        {"h": new_hash, "iid": identity_id},
    )
    await conn.execute(
        text("UPDATE users SET password_hash = :h WHERE identity_id = :iid"),
        {"h": new_hash, "iid": identity_id},
    )


async def set_identity_verified(conn: AsyncConnection, identity_id: str) -> None:
    await conn.execute(
        text("UPDATE identities SET email_verified = true WHERE id = :iid"), {"iid": identity_id}
    )
    await conn.execute(
        text("UPDATE users SET email_verified = true WHERE identity_id = :iid"), {"iid": identity_id}
    )


async def revoke_all_identity_tokens(conn: AsyncConnection, identity_id: str) -> None:
    """Revoke every session for every membership of an identity (used on reset)."""
    await conn.execute(
        text(
            "UPDATE refresh_tokens SET revoked = true "
            "WHERE user_id IN (SELECT id FROM users WHERE identity_id = :iid)"
        ),
        {"iid": identity_id},
    )


async def find_or_create_identity(
    conn: AsyncConnection, email_bidx: bytes, password_hash: str, email_verified: bool
) -> str:
    """Return the identity id for an email, creating it (with the given credential)
    if it doesn't exist yet. New memberships link to the returned id."""
    existing = (
        await conn.execute(
            text("SELECT id FROM identities WHERE email_bidx = :b"), {"b": email_bidx}
        )
    ).first()
    if existing:
        return str(existing.id)
    iid = new_uuid()
    await conn.execute(
        text(
            "INSERT INTO identities (id, email_bidx, password_hash, email_verified) "
            "VALUES (:id, :b, :ph, :ev)"
        ),
        {"id": iid, "b": email_bidx, "ph": password_hash, "ev": email_verified},
    )
    return iid


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
