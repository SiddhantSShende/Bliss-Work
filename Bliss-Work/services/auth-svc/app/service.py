"""Core identity operations: orgs, users, sessions, refresh-token rotation."""
from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone

import uuid6
from fastapi import HTTPException, status
from slugify import slugify as _slugify
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from .config import settings
from crypto import cryptor
from .db import engine
from .logging_config import log
from .schemas import SessionDTO, ThemePrefs, UserDTO
from .security.keys import mint_access_token
from .security.passwords import hash_password_async, verify_password_async


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


async def user_dto(
    conn: AsyncConnection, user_id: str, *, with_theme_prefs: bool = False
) -> UserDTO | None:
    """One user as a UserDTO. `with_theme_prefs` is opt-in and only for the
    caller's OWN record (GET/PATCH /auth/me) — this function also backs
    `GET /auth/users/{id}` for colleagues, who must not receive it."""
    row = (
        await conn.execute(
            text(
                "SELECT u.id, u.org_id, u.username, u.display_name_enc, u.email_enc, "
                "       u.avatar_enc, u.email_verified, u.mfa_enrolled, u.theme_prefs, o.plan, "
                "       o.name AS org_name, o.require_mfa_for_admins, o.mfa_grace_period_ends_at "
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
    avatar_url = await c.decrypt(conn, org_id, row.avatar_enc)
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
        avatarUrl=avatar_url or None,
        mfaEnrolled=bool(row.mfa_enrolled),
        orgRequireMfaForAdmins=bool(row.require_mfa_for_admins),
        orgMfaGracePeriodEndsAt=(
            row.mfa_grace_period_ends_at.isoformat() if row.mfa_grace_period_ends_at else None
        ),
        themePrefs=_theme_prefs_from_row(row.theme_prefs) if with_theme_prefs else None,
    )


def _theme_prefs_from_row(raw: object) -> ThemePrefs | None:
    """users.theme_prefs -> ThemePrefs. asyncpg hands jsonb back as text unless
    a codec is registered, so accept either form."""
    if raw is None:
        return None
    return ThemePrefs.model_validate(json.loads(raw) if isinstance(raw, str) else raw)


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
                       u.email_enc, u.avatar_enc, u.email_verified, u.mfa_enrolled,
                       o.plan, o.name AS org_name, o.require_mfa_for_admins, o.mfa_grace_period_ends_at
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
    return await _user_dtos_from_rows(conn, rows)


# Columns every caller of `_user_dtos_from_rows` must select, kept in one place
# so a new lookup cannot silently omit one and get a KeyError at decrypt time.
_USER_DTO_COLUMNS = """u.id, u.org_id, u.username, u.display_name_enc,
                       u.email_enc, u.avatar_enc, u.email_verified, u.mfa_enrolled,
                       o.plan, o.name AS org_name, o.require_mfa_for_admins, o.mfa_grace_period_ends_at"""


async def roles_by_user_id(
    conn: AsyncConnection, user_ids: list[str]
) -> dict[str, list[str]]:
    """Every role for the given users, in ONE query regardless of count.

    Shared by every caller that batch-loads a page of users/members and needs
    their roles alongside them — `_user_dtos_from_rows` here and
    `load_members_for_org` (routes/members_service.py) both used to run this
    exact query themselves.
    """
    if not user_ids:
        return {}
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
    return roles_by_user


async def _user_dtos_from_rows(conn: AsyncConnection, rows) -> list[UserDTO]:
    """Rows selecting `_USER_DTO_COLUMNS` -> DTOs, in ONE extra round trip.

    Every role for every row is fetched with a single `= ANY(...)` rather than a
    lookup per user. Decryption stays per-row because it must — each value is
    separately AES-GCM sealed — but the org's key is cached after the first use,
    so it is CPU and not another round trip.
    """
    if not rows:
        return []

    user_ids = [str(r.id) for r in rows]
    roles_by_user = await roles_by_user_id(conn, user_ids)

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
                avatarUrl=(await c.decrypt(conn, row_org, r.avatar_enc)) or None,
                mfaEnrolled=bool(r.mfa_enrolled),
                orgRequireMfaForAdmins=bool(r.require_mfa_for_admins),
                orgMfaGracePeriodEndsAt=(
                    r.mfa_grace_period_ends_at.isoformat() if r.mfa_grace_period_ends_at else None
                ),
            )
        )
    return out


async def user_dtos_by_ids(
    conn: AsyncConnection, org_id: str, user_ids: list[str]
) -> list[UserDTO]:
    """The named users, scoped to `org_id`. Two queries regardless of count.

    ── Why this exists alongside user_dtos_for_org ──────────────────────────────
    `/auth/directory` is an ENUMERATION endpoint: "everyone in my org". Screens
    that only need to put a name and an address on the dozen rows they are
    drawing had no way to ask for a dozen, so they fetched the whole directory
    and joined it in the browser. This is the lookup they should have had.

    ── Why status is NOT filtered here ──────────────────────────────────────────
    `user_dtos_for_org` excludes suspended and removed members so they stop being
    OFFERED in pickers and mention lists. That reasoning does not transfer to a
    by-id lookup: the caller already holds the id because it is on a row they can
    already see, and hiding the user renders their own history as "Unknown user"
    — the exact bug the callers' fallbacks were bolted on to hide.

    So this resolves any member of the CALLER'S OWN ORG regardless of status. The
    tenant boundary is what protects the data, and it is enforced twice: the
    `org_id` predicate below, and the RLS policy the caller must already have
    bound with `set_org_guc`.

    Users not in the caller's org are simply absent from the result. Callers must
    therefore match on `id` and not assume the response is positional or complete.
    """
    if not user_ids:
        return []
    rows = (
        await conn.execute(
            text(
                f"""
                SELECT {_USER_DTO_COLUMNS}
                FROM users u
                JOIN orgs o ON o.id = u.org_id
                WHERE u.org_id = :org
                  AND u.id = ANY(CAST(:uids AS uuid[]))
                ORDER BY u.username
                """
            ),
            {"org": org_id, "uids": user_ids},
        )
    ).all()
    return await _user_dtos_from_rows(conn, rows)


async def update_display_name(
    conn: AsyncConnection, org_id: str, user_id: str, display_name: str
) -> None:
    enc = await cryptor().encrypt(conn, org_id, display_name)
    await conn.execute(
        text("UPDATE users SET display_name_enc = :dn WHERE id = :id"),
        {"dn": enc, "id": user_id},
    )


async def update_theme_prefs(conn: AsyncConnection, user_id: str, prefs: ThemePrefs) -> None:
    """Sets the caller's synced UI theme. Deliberately NOT audited (unlike a
    display-name or avatar change): it is a colour preference that changes with
    a single click, and each row in the hash-chained audit_log is permanent."""
    await conn.execute(
        text("UPDATE users SET theme_prefs = CAST(:tp AS jsonb) WHERE id = :id"),
        {"tp": prefs.model_dump_json(), "id": user_id},
    )


async def update_avatar(
    conn: AsyncConnection, org_id: str, user_id: str, avatar_url: str
) -> None:
    """Sets the caller's profile picture (a `data:image/...;base64,...` URI —
    see UpdateProfileRequest.avatarUrl for the format/size validation)."""
    enc = await cryptor().encrypt(conn, org_id, avatar_url)
    await conn.execute(
        text("UPDATE users SET avatar_enc = :av WHERE id = :id"),
        {"av": enc, "id": user_id},
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


async def presence_memberships(conn: AsyncConnection, user_id: str) -> list[dict]:
    """Every ACTIVE membership this person's identity holds, for the JWT claim.

    Feeds ws-gateway's cross-org presence: one socket in one org should make the
    person appear online in all of them, and the gateway has no database to ask.
    See security/keys.py::mint_access_token.

    ── Why this saves and restores app.bypass_rls ───────────────────────────────
    The read is deliberately CROSS-ORG, and `users` is RLS ENABLE+FORCE. Under an
    org GUC it would quietly return only the caller's current membership — not an
    error, just a silently short list, which is the worst shape of wrong. So it
    runs under bypass.

    It restores the PREVIOUS value rather than setting 'off', because most
    callers (login, refresh, switch-org) are already running under bypass and
    turning it off underneath them would break the statements that follow. The
    same discipline migrations/0007_identities.sql applies, for the same reason.

    Fails SOFT: any problem answers `[]`, the claim is omitted, and the gateway
    falls back to single-org presence. Presence is not worth failing a login for.
    """
    try:
        prev = (
            await conn.execute(text("SELECT current_setting('app.bypass_rls', true)"))
        ).scalar()
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        try:
            iid = await identity_id_for_user(conn, user_id)
            if iid is None:
                return []
            rows = (
                await conn.execute(
                    text(
                        "SELECT id, org_id FROM users "
                        "WHERE identity_id = :iid AND status = 'active' "
                        "ORDER BY created_at ASC"
                    ),
                    {"iid": iid},
                )
            ).all()
        finally:
            # Empty string, not 'off': current_setting(..., true) answers '' for
            # an unset GUC, and writing that back leaves it unset rather than
            # explicitly disabled — which is the state we found it in.
            await conn.execute(
                text("SELECT set_config('app.bypass_rls', :v, true)"), {"v": prev or ""}
            )
    except Exception:  # noqa: BLE001 - see the fail-soft note above
        log.warning("presence_memberships_failed", user_id=user_id)
        return []
    return [{"o": str(r.org_id), "u": str(r.id)} for r in rows]


async def build_session(
    conn: AsyncConnection, user_id: str
) -> tuple[SessionDTO, str, str]:
    """Mint an access token + new refresh family; return (SessionDTO, raw
    refresh, family_id). `family_id` is the natural existing session
    identifier (see docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 9) — every
    refresh issued from this login shares it, and it's what refresh-token
    reuse detection already keys theft-tracking on."""
    dto = await user_dto(conn, user_id)
    if dto is None:
        raise RuntimeError("user not found while building session")
    # Minted before the token so it can ride in the access token's `sid` claim
    # (mint_access_token) — ws-gateway needs it there to associate a live
    # WebSocket with the session that opened it. See that function's docstring.
    family_id = new_uuid()
    token, ttl = mint_access_token(
        user_id=dto.id,
        org_id=dto.orgId,
        roles=list(dto.roles),
        username=dto.username,
        plan=dto.plan,
        memberships=await presence_memberships(conn, user_id),
        session_id=family_id,
    )
    raw_refresh, _ = await issue_refresh_token(conn, user_id=user_id, family_id=family_id)
    return SessionDTO(accessToken=token, user=dto, expiresIn=ttl), raw_refresh, family_id


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
    # unless the successor was issued within the replay grace window (above) AND
    # this is the FIRST replay of this stale token. The second condition is not
    # optional: without it, a stale token can be replayed repeatedly, each time
    # riding the fresh sibling minted by its OWN previous replay to look "fresh"
    # again — chaining out unlimited undetected sibling sessions in the family,
    # since the reused sibling never collides with the real successor and never
    # ages past the window (the window resets every time). `is_latest_in_family`
    # anchors the check to the ORIGINAL rotation event instead: it is true only
    # when nothing else has been issued into the family since that successor,
    # which stops being the case the moment one grace replay has already minted
    # a sibling. The mint below is guarded to match — a stale row's `rotated_to`
    # is written at most once, ever — so this anchor cannot be reset either.
    if row.revoked or row.rotated_to is not None:
        successor = None
        if row.rotated_to is not None:
            successor = (
                await conn.execute(
                    text(
                        """
                        SELECT issued_at,
                               NOT EXISTS (
                                   SELECT 1 FROM refresh_tokens later
                                   WHERE later.family_id = :fam
                                     AND later.issued_at > refresh_tokens.issued_at
                               ) AS is_latest_in_family
                        FROM refresh_tokens
                        WHERE id = :id AND NOT revoked
                        """
                    ),
                    {"id": str(row.rotated_to), "fam": str(row.family_id)},
                )
            ).first()
        fresh_replay = (
            successor is not None
            and successor.is_latest_in_family
            and (now - successor.issued_at) <= REFRESH_REPLAY_GRACE
        )
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
    # Guarded on `rotated_to IS NULL` so this is a one-time write per row: a
    # grace-forgiven replay (row already has a successor from the original
    # rotation) still mints a usable sibling for the replaying caller, but
    # leaves `rotated_to` pointing at that ORIGINAL successor rather than the
    # new one — which is what keeps the freshness check above anchored to the
    # one-time rotation event instead of resetting on every replay.
    new_raw, new_id = await issue_refresh_token(conn, user_id=user_id, family_id=family_id)
    await conn.execute(
        text(
            "UPDATE refresh_tokens SET rotated_to = :to, revoked = true "
            "WHERE id = :id AND rotated_to IS NULL"
        ),
        {"to": new_id, "id": str(row.id)},
    )

    dto = await user_dto(conn, user_id)
    if dto is None:
        raise ValueError("user not found")
    token, ttl = mint_access_token(
        user_id=dto.id,
        org_id=dto.orgId,
        roles=list(dto.roles),
        username=dto.username,
        plan=dto.plan,
        # Re-resolved on every refresh, so a membership added or removed since
        # login reaches presence within one token lifetime without a re-login.
        memberships=await presence_memberships(conn, user_id),
        # Unchanged by rotation — the family_id IS the session, before and
        # after this rotation swaps which raw secret represents it.
        session_id=family_id,
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


async def list_active_sessions(conn: AsyncConnection, user_id: str) -> list[dict]:
    """Every currently-active session (refresh-token family) for one org
    membership, newest-active first.

    A family is "active" when its most recently issued row is neither revoked
    nor expired — rotation guarantees at most one such row per family, so
    `bool_or` here is really "does that one row exist", not an aggregate over
    many. `created_at`/`last_seen_at` come straight from `issued_at` across the
    family's rows: the first row was written by the login/switch/MFA-verify
    that opened the session, and the newest by its most recent refresh
    rotation — no new columns needed, refresh_tokens already carries this.
    Uses the existing idx_refresh_tokens_user index; no new index required.
    """
    rows = (
        await conn.execute(
            text(
                """
                SELECT family_id,
                       MIN(issued_at) AS created_at,
                       MAX(issued_at) AS last_seen_at
                FROM refresh_tokens
                WHERE user_id = :uid
                GROUP BY family_id
                HAVING bool_or(NOT revoked AND expires_at > now())
                ORDER BY MAX(issued_at) DESC
                """
            ),
            {"uid": user_id},
        )
    ).all()
    return [
        {"familyId": str(r.family_id), "createdAt": r.created_at, "lastSeenAt": r.last_seen_at}
        for r in rows
    ]


async def revoke_family_by_id(conn: AsyncConnection, user_id: str, family_id: str) -> bool:
    """Revoke one session (refresh-token family) by id, scoped to its owner.

    Returns False — no row touched — when the family does not exist or
    belongs to a different user. The caller (routes/sessions.py) turns that
    into a 404 either way, so a revoke attempt can never be used to probe
    whether some other user's family id exists (IDOR). This is the id-keyed
    twin of `revoke_family_by_token` above, for callers that hold a family id
    from the active-sessions listing rather than a raw refresh token — the
    active-sessions UI never sees a raw token, only ids.
    """
    result = await conn.execute(
        text(
            "UPDATE refresh_tokens SET revoked = true "
            "WHERE family_id = :fam AND user_id = :uid"
        ),
        {"fam": family_id, "uid": user_id},
    )
    return result.rowcount > 0


async def revoke_other_sessions(
    conn: AsyncConnection, user_id: str, keep_family_id: str | None
) -> list[str]:
    """Revoke every ACTIVE session for one user in a single statement,
    optionally keeping one. Returns the family ids actually revoked, so the
    caller can emit a session.revoked event (and therefore a live WebSocket
    disconnect) for each one — the same follow-up a single revoke_family_by_id
    call gets, just for potentially many families at once.

    `WHERE ... AND NOT revoked` needs no DISTINCT: rotation revokes a
    family's predecessor the moment it mints a successor (rotate_refresh_token),
    so at most one row per family is ever un-revoked at a time — this query
    naturally returns exactly one row per active family, never a rotation
    history.

    `keep_family_id` uses the same `CAST(... AS uuid) IS NULL OR ...` idiom as
    list_audit's optional cursor (routes/members.py) rather than building the
    WHERE clause conditionally, so asyncpg always sees one fixed parameter set.
    """
    rows = (
        await conn.execute(
            text(
                """
                UPDATE refresh_tokens SET revoked = true
                WHERE user_id = :uid
                  AND NOT revoked
                  AND (CAST(:keep AS uuid) IS NULL OR family_id != CAST(:keep AS uuid))
                RETURNING family_id
                """
            ),
            {"uid": user_id, "keep": keep_family_id},
        )
    ).all()
    return [str(r.family_id) for r in rows]


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


async def register_failed_login(conn: AsyncConnection, ident) -> int:
    """Bump an IDENTITY's failed-login counter; lock the identity once it
    reaches `login_max_failed_attempts`. Returns the lockout duration in
    seconds if it just locked, else 0. The caller must let the transaction
    COMMIT (raise the auth error AFTER the `engine.begin()` block) so the
    increment persists. Lockout lives on the identity so a shared credential
    is throttled uniformly across all its orgs — shared by `/auth/login` and
    `/auth/invites/accept`'s existing-identity password check (invite
    acceptance gates a password guess exactly like login does; see
    docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 5).

    `ident` is any row exposing `.id` and `.failed_login_count`.

    The increment is atomic (`UPDATE ... SET failed_login_count =
    failed_login_count + 1 ... RETURNING`) rather than read-modify-write off
    `ident.failed_login_count`: `identity_by_bidx` reads that value without
    `FOR UPDATE`, so under concurrent wrong-password attempts against the same
    identity (a credential-stuffing burst), every caller would otherwise read
    the same stale count and each write back the same incremented value,
    letting the lockout threshold never be reached no matter how many
    parallel guesses are made.
    """
    new_count = (
        await conn.execute(
            text(
                "UPDATE identities SET failed_login_count = failed_login_count + 1 "
                "WHERE id = :id RETURNING failed_login_count"
            ),
            {"id": str(ident.id)},
        )
    ).scalar_one()
    if new_count >= settings.login_max_failed_attempts:
        await conn.execute(
            text(
                "UPDATE identities SET failed_login_count = 0, "
                "locked_until = now() + make_interval(mins => :m) WHERE id = :id"
            ),
            {"m": settings.lockout_minutes, "id": str(ident.id)},
        )
        return settings.lockout_minutes * 60
    return 0


async def resolve_or_create_identity(
    conn: AsyncConnection,
    email_bidx: bytes,
    password: str,
    *,
    new_identity_email_verified: bool,
    already_registered_error: HTTPException,
) -> tuple[str, str, bool, bool]:
    """Find-or-create the identity row behind a signup email.

    The shared half of `create_org` and `accept_invite_tx`: reuse an existing
    identity's shared credential (an existing user creating another org, or
    joining one by invite) once its password is verified, or mint a fresh
    identity otherwise. This is a password-guessing surface exactly like
    `/auth/login`, so a wrong password is gated behind the SAME lockout (see
    docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 5).

    Returns `(identity_id, password_hash, is_new, existing_email_verified)`.
    `existing_email_verified` is the IDENTITY's own `email_verified` column
    when one already existed, and is always False when `is_new` is True —
    `accept_invite_tx` ignores it, since an invited member's `users.
    email_verified` is set True unconditionally regardless of the identity's
    own state.

    Raises `already_registered_error` — a caller-specific 409 or 401, since
    the two callers word this differently — when an existing identity's
    password does not match.
    """
    existing_ident = (
        await conn.execute(
            text(
                "SELECT id, password_hash, email_verified, failed_login_count, locked_until "
                "FROM identities WHERE email_bidx = :b"
            ),
            {"b": email_bidx},
        )
    ).first()
    if existing_ident is None:
        identity_id = new_uuid()
        ph = await hash_password_async(password)
        try:
            # SAVEPOINT: two concurrent callers for the same brand-new email
            # (two invite-accepts, or a signup racing an accept) both see no
            # row above and both attempt this INSERT — email_bidx is UNIQUE
            # (0007_identities.sql), so the loser's INSERT raises. Nested so
            # only this attempt rolls back, not the caller's whole
            # transaction — same shape as create_invite_tx's own retry for
            # the analogous (org, email) race on `invites`.
            async with conn.begin_nested():
                await conn.execute(
                    text(
                        "INSERT INTO identities (id, email_bidx, password_hash, email_verified) "
                        "VALUES (:id, :b, :ph, :ev)"
                    ),
                    {"id": identity_id, "b": email_bidx, "ph": ph, "ev": new_identity_email_verified},
                )
            return identity_id, ph, True, False
        except IntegrityError:
            # The other transaction's row is now visible (READ COMMITTED) —
            # re-fetch it and fall through to the existing-identity path below,
            # exactly as if it had been there from the start.
            existing_ident = (
                await conn.execute(
                    text(
                        "SELECT id, password_hash, email_verified, failed_login_count, locked_until "
                        "FROM identities WHERE email_bidx = :b"
                    ),
                    {"b": email_bidx},
                )
            ).first()
            assert existing_ident is not None  # the unique violation guarantees it

    now = datetime.now(timezone.utc)
    if existing_ident.locked_until is not None and existing_ident.locked_until > now:
        retry = max(1, int((existing_ident.locked_until - now).total_seconds()))
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "account temporarily locked due to failed logins; try again later",
            headers={"Retry-After": str(retry)},
        )
    if not await verify_password_async(existing_ident.password_hash, password):
        # A SEPARATE transaction, deliberately — the caller's own write
        # transaction aborts when `already_registered_error` is raised below,
        # and the failed-attempt counter must survive that abort.
        async with engine.begin() as lockout_conn:
            locked_secs = await register_failed_login(lockout_conn, existing_ident)
        if locked_secs > 0:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "account temporarily locked due to failed logins; try again later",
                headers={"Retry-After": str(locked_secs)},
            )
        raise already_registered_error

    return str(existing_ident.id), existing_ident.password_hash, False, bool(existing_ident.email_verified)


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
            INSERT INTO audit_log (id, org_id, actor_id, action, target, meta, at, prev_hash, entry_hash)
            VALUES (:id, :org, :actor, :action, :target, CAST(:meta AS jsonb), :at, :prev_hash, :entry_hash)
            """
        ),
        {
            # App-generated UUIDv7 (id has no DB-side default — same
            # convention as every other table's id; see new_uuid()).
            "id": new_uuid(),
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
            return {"ok": False, "count": len(rows), "broken_at": str(r.id), "reason": "prev_hash mismatch"}
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
            return {"ok": False, "count": len(rows), "broken_at": str(r.id), "reason": "entry_hash mismatch"}
        expected_prev = bytes(r.entry_hash)
    return {"ok": True, "count": len(rows), "broken_at": None, "reason": None}
