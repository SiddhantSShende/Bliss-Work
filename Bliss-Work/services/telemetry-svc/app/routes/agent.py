"""Agent pairing and agent ingest — the desktop sampler and the browser extension.

Neither agent can hold a session. The extension has no secure storage and cannot
perform the SameSite-cookie refresh dance; the desktop sampler runs in a process
that outlives every window. Handing either a JWT (let alone a refresh token)
would mean a compromised agent holds a full BlissWork session.

So they get a single-purpose secret instead:

  * minted by the MEMBER, from their own signed-in session, for themselves;
  * shown exactly once, then stored only as `sha256(raw)`;
  * scoped to one (org, user) — it can write that person's activity and nothing
    else, and cannot read anything at all;
  * revocable from the same screen that minted it, and expiring on its own.

The ingest endpoint is therefore the one authenticated path in the product that
does NOT go through `require_principal`.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone

import uuid6
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from sqlalchemy import text

from ..auth import Principal, require_principal
from ..db import session, set_bypass_rls, set_org_context
from ..ingest import ActivityRow, clamp_occurred_at, insert_events
from ..logging_setup import log
from ..rate_limit import limiter
from ..schemas import AgentBatch, AgentStatusPing, AgentTokenCreated, AgentTokenDTO
from ..sessionizer import sessionize_inserted

router = APIRouter(prefix="/telemetry", tags=["agent"])

# Long enough that re-pairing is rare, short enough that a token left on a
# decommissioned laptop stops working on its own.
TOKEN_TTL_DAYS = 365
# What an agent is allowed to claim. 'app' is the desktop sampler, 'site' the
# extension, 'system' the lock/unlock and idle signals from powerMonitor.
_AGENT_CATEGORIES = {"app", "site", "system"}


def _hash(raw: str) -> bytes:
    return hashlib.sha256(raw.encode("utf-8")).digest()


@router.post("/tokens", response_model=AgentTokenCreated, status_code=status.HTTP_201_CREATED)
async def create_token(
    kind: str = "extension",
    label: str = "",
    device_key: str | None = Query(default=None, max_length=128, alias="deviceKey"),
    principal: Principal = Depends(require_principal),
) -> AgentTokenCreated:
    """Mint a pairing secret for the CALLER's own agents.

    Deliberately not an admin endpoint: an admin minting a token on someone
    else's behalf would be an admin able to write activity attributed to that
    person, which would quietly destroy the record's meaning.

    `device_key` makes this safe to call automatically (e.g. on every login)
    instead of only from an explicit "Connect" click: a caller that already
    holds a paired token for THIS device never reaches here in practice (the
    client checks locally first), but if it does — a lost response, a state
    file wiped and recreated — this returns the existing row instead of
    minting a second live secret for the same installation. Omitting
    device_key (every manual "Connect" button today) keeps the original
    always-mint behaviour, so multi-device pairing is unaffected.
    """
    if kind not in {"extension", "desktop"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unknown agent kind")
    async with session() as db:
        await set_org_context(db, principal.org_id)
        if device_key:
            existing = (
                await db.execute(
                    text(
                        "SELECT id FROM ingest_tokens "
                        "WHERE org_id = :org AND user_id = :uid AND kind = :kind "
                        "AND device_key = :dk AND revoked_at IS NULL"
                    ),
                    {"org": principal.org_id, "uid": principal.user_id, "kind": kind, "dk": device_key},
                )
            ).first()
            if existing is not None:
                log.info("agent_token_already_provisioned", user_id=principal.user_id, kind=kind)
                return AgentTokenCreated(id=str(existing.id), kind=kind, token=None)
        raw = secrets.token_urlsafe(32)
        token_id = str(uuid6.uuid7())
        await db.execute(
            text(
                """
                INSERT INTO ingest_tokens
                    (id, org_id, user_id, kind, token_hash, label, device_key, expires_at)
                VALUES (:id, :org, :uid, :kind, :hash, :label, :dk,
                        now() + make_interval(days => :ttl))
                """
            ),
            {
                "id": token_id, "org": principal.org_id, "uid": principal.user_id,
                "kind": kind, "hash": _hash(raw), "label": label[:64], "dk": device_key,
                "ttl": TOKEN_TTL_DAYS,
            },
        )
        await db.commit()
    log.info("agent_token_created", user_id=principal.user_id, kind=kind, auto=bool(device_key))
    # The only time the raw secret exists outside the agent. Not recoverable —
    # losing it means minting another, which is the correct cost.
    return AgentTokenCreated(id=token_id, kind=kind, token=raw)


@router.get("/tokens", response_model=list[AgentTokenDTO])
async def list_tokens(
    principal: Principal = Depends(require_principal),
) -> list[AgentTokenDTO]:
    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = (
            await db.execute(
                text(
                    "SELECT id, kind, label, created_at, last_used_at, last_seen_at, "
                    "agent_version, platform, expires_at "
                    "FROM ingest_tokens "
                    "WHERE org_id = :org AND user_id = :uid AND revoked_at IS NULL "
                    "ORDER BY created_at DESC"
                ),
                {"org": principal.org_id, "uid": principal.user_id},
            )
        ).all()
    return [
        AgentTokenDTO(
            id=str(r.id), kind=r.kind, label=r.label,
            createdAt=_iso(r.created_at), lastUsedAt=_iso(r.last_used_at),
            lastSeenAt=_iso(r.last_seen_at), agentVersion=r.agent_version, platform=r.platform,
            expiresAt=_iso(r.expires_at),
        )
        for r in rows
    ]


@router.delete("/tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_token(
    token_id: str, principal: Principal = Depends(require_principal)
) -> Response:
    async with session() as db:
        await set_org_context(db, principal.org_id)
        await db.execute(
            text(
                "UPDATE ingest_tokens SET revoked_at = now() "
                "WHERE id = :id AND org_id = :org AND user_id = :uid AND revoked_at IS NULL"
            ),
            {"id": token_id, "org": principal.org_id, "uid": principal.user_id},
        )
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/ingest/agent", status_code=status.HTTP_202_ACCEPTED)
@limiter.limit("60/minute")
async def ingest_agent(
    request: Request,
    response: Response,  # required by slowapi (headers_enabled) to inject rate-limit headers
    body: AgentBatch,
    x_ingest_token: str | None = Header(default=None, alias="X-Ingest-Token"),
) -> dict[str, int]:
    """Accept a batch from a paired agent.

    Note what is NOT taken from the body: the org and the user. Both come from
    the token's own row, so a stolen token can only ever write activity for the
    person it was minted by — it cannot be pointed at a colleague.
    """
    if not x_ingest_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing agent token")

    now = datetime.now(timezone.utc)
    async with session() as db:
        # Pre-org-context: the token is looked up by hash before the org is
        # known, exactly like auth-svc's refresh-token path. Trusted server code,
        # never driven by request input beyond the hash itself.
        await set_bypass_rls(db)
        row = (
            await db.execute(
                text(
                    "SELECT id, org_id, user_id, kind FROM ingest_tokens "
                    "WHERE token_hash = :h AND revoked_at IS NULL AND expires_at > now()"
                ),
                {"h": _hash(x_ingest_token)},
            )
        ).first()
        if row is None:
            # One message for expired, revoked and never-existed alike: a paired
            # agent has no legitimate need to tell them apart, and distinguishing
            # them would confirm a guessed token had once been real.
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid agent token")

        org_id, user_id = str(row.org_id), str(row.user_id)
        source = "desktop" if row.kind == "desktop" else "extension"
        rows = [
            ActivityRow(
                org_id=org_id,
                user_id=user_id,
                occurred_at=clamp_occurred_at(_parse(e.occurredAt), now),
                source=source,
                category=e.category if e.category in _AGENT_CATEGORIES else "app",
                action=e.action,
                target_kind=e.targetKind,
                target_id=e.targetId,
                duration_ms=e.durationMs,
                detail=dict(e.detail or {}),
                client_event_id=e.clientEventId,
            )
            for e in body.events
        ]
        inserted = await insert_events(db, rows)
        # The desktop agent's app.focus rows and the extension's site.visit
        # rows both arrive through THIS route (they are the two agent kinds) —
        # this is where the two sensors' spans actually get correlated.
        await sessionize_inserted(db, inserted)
        # last_seen_at too: a real ingest is certainly also "seen" — see
        # report_status's docstring for why the two columns stay distinct.
        await db.execute(
            text(
                "UPDATE ingest_tokens SET last_used_at = now(), last_seen_at = now() "
                "WHERE id = :id"
            ),
            {"id": str(row.id)},
        )
        await db.commit()

    return {"accepted": len(inserted)}


@router.post("/tokens/status", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("30/minute")
async def report_status(
    request: Request,
    response: Response,  # required by slowapi (headers_enabled) to inject rate-limit headers
    body: AgentStatusPing,
    x_ingest_token: str | None = Header(default=None, alias="X-Ingest-Token"),
) -> Response:
    """A cheap heartbeat, separate from ingest on purpose: it must be safe to
    call even before the person has consented to sampling (or while paused),
    which means it must never write an activity_events row — a write here
    would itself be a data trail, which is exactly what "not tracking yet"
    has to mean. `last_seen_at` (this endpoint OR a real ingest) proves the
    credential still works; `last_used_at` (ingest only) proves it actually
    sent data — that distinction is what lets a client tell CONNECTED apart
    from TRACKING_ACTIVE without the server ever seeing the consent flag.
    """
    if not x_ingest_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing agent token")
    async with session() as db:
        await set_bypass_rls(db)
        row = (
            await db.execute(
                text(
                    "SELECT id FROM ingest_tokens "
                    "WHERE token_hash = :h AND revoked_at IS NULL AND expires_at > now()"
                ),
                {"h": _hash(x_ingest_token)},
            )
        ).first()
        if row is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid agent token")
        await db.execute(
            text(
                "UPDATE ingest_tokens SET last_seen_at = now(), "
                "agent_version = COALESCE(:v, agent_version), "
                "platform = COALESCE(:p, platform) "
                "WHERE id = :id"
            ),
            {"v": body.version, "p": body.platform, "id": row.id},
        )
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _iso(dt: datetime | None) -> str | None:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" if dt else None


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

