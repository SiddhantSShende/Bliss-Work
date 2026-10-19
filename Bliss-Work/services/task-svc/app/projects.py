from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

import httpx
import uuid6
from fastapi import HTTPException
from sqlalchemy import text

from crypto import cryptor

from .config import settings
from .db import session, set_org_context
from .logging_setup import log


@dataclass(frozen=True)
class ProjectResolution:
    project_id: str
    name: str
    channel_id: str
    created: bool


def normalize_project_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip())


def project_name_hash(name: str) -> bytes:
    normalized = normalize_project_name(name)
    if not normalized:
        raise HTTPException(status_code=400, detail="project name must not be blank")
    return cryptor().blind_index(normalized)


async def _create_project_channel(org_id: str, creator_id: str, name: str) -> str:
    headers = {"X-Internal-Token": settings.messaging_internal_token}
    url = f"{settings.messaging_internal_base.rstrip('/')}/internal/channels"
    payload = {
        "orgId": org_id,
        "name": name,
        "isLocked": True,
        "creatorId": creator_id,
        "memberIds": [],
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=2.0)) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        log.warning("project_channel_create_unreachable", org_id=org_id, error=str(exc))
        raise HTTPException(status_code=503, detail="messaging service unavailable; retry project creation") from exc

    if response.status_code != 201:
        log.warning(
            "project_channel_create_failed",
            org_id=org_id,
            status=response.status_code,
            # A 404 here means messaging-svc has no POST /internal/channels
            # route at all (deployed-image version skew), not a normal
            # business-logic rejection — the body distinguishes the two.
            response_body=response.text[:500],
        )
        raise HTTPException(status_code=502, detail="project channel could not be created; retry task creation")

    try:
        channel_id = str(uuid.UUID(response.json()["channelId"]))
    except (ValueError, KeyError, TypeError) as exc:
        log.error("project_channel_create_invalid_response", org_id=org_id)
        raise HTTPException(status_code=502, detail="messaging service returned an invalid project channel") from exc
    return channel_id


async def fetch_channel_members(channel_id: str, org_id: str, caller_id: str) -> list[str]:
    """Current member ids of an existing channel, verified org/membership
    server-side by messaging-svc. Same internal endpoint and contract as
    tasks_write._resolve_channel_members — duplicated narrowly here (just the
    member-ids half) since that helper is private to tasks_write and this
    needs no channel name."""
    headers = {"X-Internal-Token": settings.messaging_internal_token}
    url = f"{settings.messaging_internal_base.rstrip('/')}/internal/channels/{channel_id}/members"
    params = {"orgId": org_id, "callerId": caller_id}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0)) as client:
            resp = await client.get(url, headers=headers, params=params)
    except httpx.HTTPError as exc:
        log.warning("project_link_channel_members_unreachable", channel_id=channel_id, error=str(exc))
        raise HTTPException(status_code=503, detail="messaging service unreachable") from exc
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="channel not found")
    if resp.status_code != 200:
        log.warning("project_link_channel_members_failed", channel_id=channel_id, status=resp.status_code)
        raise HTTPException(status_code=502, detail="messaging service error")
    body = resp.json()
    if body.get("orgId") != org_id:
        raise HTTPException(status_code=404, detail="channel not found")
    return list(body.get("memberIds") or [])


async def resolve_or_create_project(
    org_id: str, creator_id: str, raw_name: str
) -> ProjectResolution:
    """Resolve one org-scoped project and create its private channel atomically.

    The advisory lock is held through the messaging request and the channel-id
    update. A failed create rolls back the project row as part of this same
    transaction; a crash after messaging-svc commits but before this transaction
    commits can leave only an unreferenced, creator-only locked channel.
    """
    name = normalize_project_name(raw_name)
    name_hash = project_name_hash(name)
    async with session() as db:
        await set_org_context(db, org_id)
        await db.execute(text("SET LOCAL lock_timeout = '10s'"))
        result = await db.execute(
            text(
                "SELECT id, name_enc, channel_id FROM projects "
                "WHERE org_id = :org AND name_hash = :name_hash"
            ),
            {"org": org_id, "name_hash": name_hash},
        )
        existing = result.first()
        if existing is not None:
            if existing.channel_id is None:
                raise HTTPException(status_code=503, detail="project channel is not ready; retry task creation")
            existing_name = await cryptor().decrypt(db, org_id, existing.name_enc)
            await _ensure_project_channel_link(db, org_id, str(existing.id), str(existing.channel_id))
            await db.commit()
            return ProjectResolution(
                str(existing.id), existing_name or name, str(existing.channel_id), False
            )

        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:org), hashtext(:name_hash))"),
            {"org": org_id, "name_hash": name_hash.hex()},
        )
        result = await db.execute(
            text(
                "SELECT id, name_enc, channel_id FROM projects "
                "WHERE org_id = :org AND name_hash = :name_hash"
            ),
            {"org": org_id, "name_hash": name_hash},
        )
        existing = result.first()
        if existing is not None:
            if existing.channel_id is None:
                raise HTTPException(status_code=503, detail="project channel is not ready; retry task creation")
            existing_name = await cryptor().decrypt(db, org_id, existing.name_enc)
            await _ensure_project_channel_link(db, org_id, str(existing.id), str(existing.channel_id))
            await db.commit()
            return ProjectResolution(
                str(existing.id), existing_name or name, str(existing.channel_id), False
            )

        project_id = str(uuid6.uuid7())
        name_enc = await cryptor().encrypt(db, org_id, name)
        await db.execute(
            text(
                "INSERT INTO projects (id, org_id, name_enc, name_hash, channel_id, created_by) "
                "VALUES (:id, :org, :name_enc, :name_hash, NULL, :creator)"
            ),
            {
                "id": project_id,
                "org": org_id,
                "name_enc": name_enc,
                "name_hash": name_hash,
                "creator": creator_id,
            },
        )
        channel_id = await _create_project_channel(org_id, creator_id, name)
        await db.execute(
            text("UPDATE projects SET channel_id = :channel, updated_at = now() WHERE id = :id AND org_id = :org"),
            {"channel": channel_id, "id": project_id, "org": org_id},
        )
        await _ensure_project_channel_link(db, org_id, project_id, channel_id)
        await db.commit()
        return ProjectResolution(project_id, name, channel_id, True)


async def _ensure_project_channel_link(db, org_id: str, project_id: str, channel_id: str) -> None:
    """project_channels mirrors projects.channel_id for every project read via
    ProjectDTO.channelIds. Called on both the create and reuse paths so a
    project resolved before 018_project_channels.sql (whose backfill only ran
    once, at migration time) still ends up linked the first time it is
    touched again."""
    await db.execute(
        text(
            "INSERT INTO project_channels (project_id, org_id, channel_id) "
            "VALUES (:pid, :org, :cid) ON CONFLICT DO NOTHING"
        ),
        {"pid": project_id, "org": org_id, "cid": channel_id},
    )


async def link_channels_to_project(
    db, org_id: str, project_id: str, channel_ids: list[str], caller_id: str
) -> None:
    """Make a multi-channel/multi-project/mixed merge (Rules B/E/G/H) real:
    once a NEW project is named for the combined scope, every channel that
    went into that scope is linked into its project_channels — not just the
    project's own auto-created channel — so picking this project again later
    (Rule F) shows the whole merge, not just a label.

    A channel that does not qualify for project membership (fewer than 2
    real members — Section 5's domain invariant) is silently skipped rather
    than failing the task: it still works fine as a plain task-allocation
    channel (task_channels), it just never counted as a PROJECT channel.
    Likewise a channel fetch_channel_members can't resolve (deleted, wrong
    org, caller not a member) is skipped rather than blocking task creation
    over a project-membership technicality.
    """
    for channel_id in channel_ids:
        try:
            member_ids = await fetch_channel_members(channel_id, org_id, caller_id)
        except HTTPException:
            continue
        if len(member_ids) < 2:
            continue
        await _ensure_project_channel_link(db, org_id, project_id, channel_id)


async def sync_assignees_to_project_channel(
    org_id: str, channel_id: str, actor_id: str, assignee_ids: list[str]
) -> None:
    member_ids = list(dict.fromkeys(str(uuid.UUID(user_id)) for user_id in assignee_ids))
    if not member_ids:
        return
    headers = {"X-Internal-Token": settings.messaging_internal_token}
    url = (
        f"{settings.messaging_internal_base.rstrip('/')}/internal/channels/"
        f"{uuid.UUID(channel_id)}/members"
    )
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=2.0)) as client:
            response = await client.post(
                url,
                headers=headers,
                json={"orgId": org_id, "memberIds": member_ids, "actorId": actor_id},
            )
    except httpx.HTTPError as exc:
        log.warning(
            "project_channel_member_sync_unreachable",
            org_id=org_id,
            channel_id=channel_id,
            error=str(exc),
        )
        raise HTTPException(status_code=503, detail="project channel membership sync failed; retry task creation") from exc
    if response.status_code != 204:
        log.warning(
            "project_channel_member_sync_failed",
            org_id=org_id,
            channel_id=channel_id,
            status=response.status_code,
        )
        raise HTTPException(status_code=502, detail="project channel membership sync failed; retry task creation")
