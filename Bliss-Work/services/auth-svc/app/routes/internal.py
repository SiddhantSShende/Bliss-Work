"""Internal service-to-service endpoints — no JWT, shared-secret auth.

Mirrors the messaging-svc internal pattern (X-Internal-Token /
AUTH_INTERNAL_TOKEN — auth-svc's own secret, not shared with any other
service's callees; see docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 2). auth-svc
owns identity, so other services resolve a user's e-mail / username by ASKING
auth-svc here rather than reaching into authdb. Used by email-worker's offline
relay. NOT mounted under the public CORS/JWT surface.
"""
from __future__ import annotations

import json
import os

from fastapi import APIRouter, Header, HTTPException, Response, status
from internal_auth import internal_token_matches
from sqlalchemy import text

from .. import service
from crypto import cryptor
from ..db import engine
from ..events.outbox import SECRET_EVENT_TYPES, TOPIC_AUTH, build_event, enqueue_event
from ..schemas import UserDTO
from . import members_service

router = APIRouter(prefix="/internal", tags=["internal"])

_INTERNAL_TOKEN = os.getenv("AUTH_INTERNAL_TOKEN", "")

#: Members re-emitted by one /users/reproject call. See the endpoint's docstring.
_REPROJECT_MAX = 5000


@router.get("/users/{user_id}", response_model=UserDTO)
async def internal_get_user(
    user_id: str,
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> UserDTO:
    # Fail CLOSED: if the shared secret is not configured the endpoint must reject
    # everything, not (as before) accept any caller. Constant-time compare avoids
    # leaking the token via response timing.
    if not internal_token_matches(x_internal_token, _INTERNAL_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal token")
    async with engine.connect() as conn:
        # Trusted service-to-service lookup by user_id with no org context (the
        # caller doesn't know the user's org). user_dto reads users + org_keys
        # (RLS), so this cross-org trusted path runs under bypass.
        await service.set_bypass_rls(conn)
        dto = await service.user_dto(conn, user_id)
    if dto is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    return dto


@router.get("/audit/verify/{org_id}")
async def verify_audit_chain(
    org_id: str,
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> dict:
    """Tamper-evidence check: re-walk an org's audit hash chain. Returns
    {ok, count, broken_at, reason}. For ops / incident response."""
    if not internal_token_matches(x_internal_token, _INTERNAL_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal token")
    async with engine.connect() as conn:
        await service.set_org_guc(conn, org_id)
        return await service.verify_audit_chain(conn, org_id)


@router.post("/keys/rotate/{org_id}")
async def rotate_org_dek(
    org_id: str,
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> dict:
    """Rotate an org's Data Encryption Key (authdb). New writes use the new
    generation; existing ciphertext stays readable via its embedded key_version
    (lazy rotation). Repeat per service DB to fully rotate an org."""
    if not internal_token_matches(x_internal_token, _INTERNAL_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal token")
    async with engine.begin() as conn:
        await service.set_org_guc(conn, org_id)  # org_keys is RLS-protected
        old_version, new_version = await cryptor().rotate_dek(conn, org_id)
    return {"orgId": org_id, "oldVersion": old_version, "newVersion": new_version}


@router.post("/users/reproject/{org_id}")
async def reproject_org_users(
    org_id: str,
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> dict:
    """Re-emit `user.created` for every active member of an org.

    The projections other services keep of the directory (messaging-svc's
    user_projection, and task-svc's) are built exclusively from this event, so a
    field ADDED to it is missing for every member who joined before it existed.
    Re-emitting is how they converge: the consumers' upsert path already handles
    a repeat, and it fills every consumer at once rather than one backfill script
    per service reaching into a database it does not own.

    Idempotent by construction — each emission carries a fresh eventId, so
    consumer-side dedup does not suppress it, and the write it drives is an
    upsert of values that are already authoritative here.
    """
    if not internal_token_matches(x_internal_token, _INTERNAL_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal token")

    emitted = 0
    async with engine.begin() as conn:
        await service.set_org_guc(conn, org_id)
        # Bounded by REPROJECT_MAX rather than unbounded: this walks a whole
        # org's directory and decrypts two columns per member, and an org large
        # enough to exceed it wants a paged tool, not a slower single request.
        members = await service.user_dtos_for_org(conn, org_id, limit=_REPROJECT_MAX)
        for dto in members:
            event = build_event(
                "user.created",
                org_id,
                userId=dto.id,
                username=dto.username,
                displayName=dto.displayName,
                email=dto.email,
            )
            await enqueue_event(conn, topic=TOPIC_AUTH, kafka_key=dto.id, event=event)
            emitted += 1
    return {"orgId": org_id, "emitted": emitted, "truncated": emitted == _REPROJECT_MAX}


@router.get("/v1/orgs/{org_id}/admins")
async def internal_org_admins(
    org_id: str,
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> dict:
    """Return the user ids of `org_id`'s CURRENT active org_admin members.

    Built for notification-svc's billing consumer, which needs "the org's
    admins" to route membership.low_balance / grace_started / suspended
    notices (see services/notification-svc/internal/consumer/billing.go).
    Reuses `members_service._active_admin_ids` — the exact same query that
    already guards the no-last-admin invariant elsewhere in this service —
    rather than standing up a second source of truth for who administers an
    org.

    No PII: ids only, no emails/usernames. Trusted service-to-service call,
    same X-Internal-Token pattern as every other endpoint in this module.
    """
    if not internal_token_matches(x_internal_token, _INTERNAL_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal token")
    async with engine.connect() as conn:
        await service.set_org_guc(conn, org_id)
        admin_ids = await members_service._active_admin_ids(conn, org_id)
    return {"adminUserIds": sorted(admin_ids)}


@router.get("/outbox-events/{outbox_id}")
async def internal_outbox_event(
    outbox_id: str,
    response: Response,
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> dict:
    """Return the still-full stored payload for one outbox row.

    This is the ONLY way the raw password-reset / email-verification / invite
    secret ever leaves auth-svc: email-worker pulls it here instead of the
    secret ever being broadcast over Kafka (see
    docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 3 — the poller strips these
    fields before publish and adds `outboxId`, which is what callers pass in
    here).

    Restricted to SECRET_EVENT_TYPES so this can't be used as a generic
    outbox-payload-leak oracle for unrelated event types. `Cache-Control:
    no-store` so nothing between here and the caller retains the secret.

    404 is a PERMANENT outcome for the caller (row not found, wrong type, or
    already redacted past its own expiry) — there is nothing useful to retry,
    matching this service's existing single-generic-error posture for
    single-use tokens. Any other failure (5xx, connection drop) is transient.
    """
    if not internal_token_matches(x_internal_token, _INTERNAL_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal token")
    response.headers["Cache-Control"] = "no-store"
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT payload FROM outbox WHERE id = :id "
                    "AND payload ->> 'type' = ANY(:types)"
                ),
                {"id": outbox_id, "types": list(SECRET_EVENT_TYPES)},
            )
        ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    payload = json.loads(row.payload) if isinstance(row.payload, str) else row.payload
    # Already redacted (past its own expiresAt) — permanently gone, same 404
    # as "row not found": there's nothing here for the caller to retry.
    if not any(field in payload for field in ("resetUrl", "verifyUrl", "inviteUrl")):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    return payload
