"""External handle → Bliss-Work user resolution.

app/mentions.py extracts the handles a message tags; this module turns them into
user ids. Two sources feed `provider_identities`:

  source='oauth'    ─ derived from a connected account's own identity when the
                      OAuth flow completes. Self-proving (the user just signed
                      in to that account) and needs no setup.
  source='declared' ─ typed in by the user under "My handles", so mentions on an
                      org-wide connection (a Slack bot the whole workspace
                      shares) can still resolve to a person.

SECURITY — READ BEFORE EDITING
The callers here (the public webhook receiver, the ingest worker) run under
`app.bypass_rls`, which switches RLS OFF for the transaction. Every statement in
this module therefore carries an EXPLICIT `org_id = :org` predicate. Dropping one
would let a handle from org A resolve to a user in org B and file that person a
task containing another tenant's message. RLS is not your safety net here.
"""

from __future__ import annotations

from typing import Sequence

import uuid6
from sqlalchemy import text

from crypto import cryptor, CryptoError
from .logging_setup import log


async def resolve_users(
    db,
    org_id: str,
    provider: str,
    handles: Sequence[str],
    *,
    fallback_user_id: str | None = None,
    fallback_handle_bidx: bytes | None = None,
) -> list[str]:
    """Map external handles to Bliss-Work user ids within ONE org.

    `fallback_*` cover the common per-user OAuth case before the user has
    declared anything: if a tagged handle is the connection's OWN account, the
    connection owner is the person tagged. Returns [] when nothing resolves —
    the message is then recorded as ordinary activity, not a mention.
    """
    if not handles:
        return []

    bidxs = [cryptor().blind_index(h) for h in handles]
    rows = (
        await db.execute(
            text(
                """
                SELECT DISTINCT user_id
                  FROM provider_identities
                 WHERE org_id = :org
                   AND provider = :provider
                   AND external_handle_bidx = ANY(:bidxs)
                """
            ),
            {"org": org_id, "provider": provider, "bidxs": bidxs},
        )
    ).all()
    resolved = [str(r.user_id) for r in rows]
    if resolved:
        return resolved

    # Nothing mapped yet — fall back to "was the connection's own account tagged?"
    if fallback_user_id and fallback_handle_bidx and fallback_handle_bidx in bidxs:
        return [str(fallback_user_id)]
    return []


async def upsert_oauth_identity(
    db,
    *,
    org_id: str,
    user_id: str,
    provider: str,
    handle: str,
    handle_kind: str = "account",
    connection_id: str | None = None,
) -> None:
    """Record an OAuth-derived handle. Idempotent per (org, provider, handle).

    OAuth truth WINS over a declared guess: someone who typed a colleague's
    address into My Handles must not keep receiving their mentions once that
    colleague actually connects the account.
    """
    if not handle:
        return
    await db.execute(
        text(
            """
            INSERT INTO provider_identities
                (id, org_id, user_id, provider, handle_kind,
                 external_handle_enc, external_handle_bidx, source,
                 connection_id, verified_at)
            VALUES
                (:id, :org, :uid, :provider, :kind, :enc, :bidx, 'oauth',
                 :conn, now())
            ON CONFLICT (org_id, provider, external_handle_bidx) DO UPDATE SET
                user_id       = EXCLUDED.user_id,
                handle_kind   = EXCLUDED.handle_kind,
                source        = 'oauth',
                connection_id = EXCLUDED.connection_id,
                verified_at   = now(),
                updated_at    = now()
            """
        ),
        {
            "id": str(uuid6.uuid7()),
            "org": org_id,
            "uid": user_id,
            "provider": provider,
            "kind": handle_kind,
            "enc": await cryptor().encrypt(db, org_id, handle),
            "bidx": cryptor().blind_index(handle),
            "conn": connection_id,
        },
    )


class HandleTakenError(Exception):
    """The handle is already mapped to a different user in this org."""


async def add_declared_identity(
    db, *, org_id: str, user_id: str, provider: str, handle: str, handle_kind: str = "account"
) -> str:
    """Record a user-declared handle. Raises HandleTakenError if a teammate (or
    an OAuth connection) already owns it — otherwise one user could farm another
    user's mentions into their own task list.

    Re-declaring your OWN handle is a no-op that returns the existing row's id,
    so a double-submit doesn't surface a spurious error.
    """
    bidx = cryptor().blind_index(handle)
    existing = (
        await db.execute(
            text(
                """
                SELECT id, user_id FROM provider_identities
                 WHERE org_id = :org AND provider = :provider AND external_handle_bidx = :bidx
                """
            ),
            {"org": org_id, "provider": provider, "bidx": bidx},
        )
    ).one_or_none()
    if existing is not None:
        if str(existing.user_id) != str(user_id):
            raise HandleTakenError(handle)
        return str(existing.id)

    new_id = str(uuid6.uuid7())
    await db.execute(
        text(
            """
            INSERT INTO provider_identities
                (id, org_id, user_id, provider, handle_kind,
                 external_handle_enc, external_handle_bidx, source)
            VALUES (:id, :org, :uid, :provider, :kind, :enc, :bidx, 'declared')
            """
        ),
        {
            "id": new_id,
            "org": org_id,
            "uid": user_id,
            "provider": provider,
            "kind": handle_kind,
            "enc": await cryptor().encrypt(db, org_id, handle),
            "bidx": bidx,
        },
    )
    return new_id


async def list_identities(db, *, org_id: str, user_id: str) -> list[dict]:
    """The caller's own handles, decrypted for display. Scoped to the caller —
    handles are PII and nobody needs to browse a colleague's."""
    rows = (
        await db.execute(
            text(
                """
                SELECT id, provider, handle_kind, external_handle_enc, source,
                       verified_at, created_at
                  FROM provider_identities
                 WHERE org_id = :org AND user_id = :uid
                 ORDER BY provider, created_at
                """
            ),
            {"org": org_id, "uid": user_id},
        )
    ).all()

    out: list[dict] = []
    for r in rows:
        # Isolated per row: a historical handle whose DEK version is gone
        # (crypto-shredded) or whose ciphertext is malformed raises
        # CryptoError by design (fail closed) — one bad row must not 500 the
        # whole "My handles" list for every other, perfectly readable one.
        try:
            handle = await cryptor().decrypt(db, org_id, bytes(r.external_handle_enc))
        except CryptoError as exc:
            log.warning("identity_decrypt_failed", identity_id=str(r.id), error=str(exc))
            handle = "(unavailable)"
        out.append(
            {
                "id": str(r.id),
                "provider": r.provider,
                "handleKind": r.handle_kind,
                "handle": handle or "",
                "source": r.source,
                "verified": r.verified_at is not None,
                "createdAt": r.created_at.isoformat(),
            }
        )
    return out


async def delete_identity(db, *, org_id: str, user_id: str, identity_id: str) -> bool:
    """Remove one of the caller's handles. Returns False when it isn't theirs,
    which the route reports as 404 rather than 403 (don't confirm existence)."""
    res = await db.execute(
        text(
            "DELETE FROM provider_identities "
            " WHERE id = :id AND org_id = :org AND user_id = :uid"
        ),
        {"id": identity_id, "org": org_id, "uid": user_id},
    )
    return res.rowcount > 0
