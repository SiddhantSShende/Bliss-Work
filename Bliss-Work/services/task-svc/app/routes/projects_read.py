from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text

from crypto import cryptor

from ..auth import Principal, PrincipalDep
from ..db import session, set_org_context
from ..projects import normalize_project_name, project_name_hash
from ..schemas import ProjectDTO

router = APIRouter()

_DEFAULT_LIMIT = 50
_MAX_LIMIT = 100

_AUTHORIZED_PROJECT = (
    "("
    "EXISTS ("
    "SELECT 1 FROM tasks t "
    "WHERE t.org_id = p.org_id AND t.project_id = p.id "
    "AND (t.sender_id = :me OR EXISTS ("
    "SELECT 1 FROM task_assignees ta "
    "WHERE ta.org_id = t.org_id AND ta.task_id = t.id AND ta.assignee_id = :me"
    "))"
    ")"
    " OR EXISTS ("
    "SELECT 1 FROM task_schedules s "
    "WHERE s.org_id = p.org_id AND s.project_id = p.id "
    "AND (s.sender_id = :me OR :me = ANY(s.assignee_ids))"
    ")"
    ")"
)


async def _project_dto(db, org_id: str, row) -> ProjectDTO:
    name = await cryptor().decrypt(db, org_id, row.name_enc)
    return ProjectDTO(id=str(row.id), name=name or "", channelId=str(row.channel_id))


@router.get("/projects/by-name", response_model=ProjectDTO)
async def project_by_name(
    name: str = Query(min_length=1, max_length=200),
    principal: Principal = PrincipalDep,
) -> ProjectDTO:
    normalized = normalize_project_name(name)
    if not normalized:
        raise HTTPException(status_code=404, detail="project not found")
    name_hash = project_name_hash(normalized)
    async with session() as db:
        await set_org_context(db, principal.org_id)
        row = (
            await db.execute(
                text(
                    "SELECT p.id, p.name_enc, p.channel_id FROM projects p "
                    "WHERE p.org_id = :org AND p.name_hash = :name_hash "
                    "AND p.channel_id IS NOT NULL AND " + _AUTHORIZED_PROJECT
                ),
                {"org": principal.org_id, "name_hash": name_hash, "me": principal.user_id},
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="project not found")
        return await _project_dto(db, principal.org_id, row)


@router.get("/projects", response_model=list[ProjectDTO])
async def projects(
    principal: Principal = PrincipalDep,
    limit: int = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
) -> list[ProjectDTO]:
    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = (
            await db.execute(
                text(
                    "SELECT p.id, p.name_enc, p.channel_id FROM projects p "
                    "WHERE p.org_id = :org AND p.channel_id IS NOT NULL AND "
                    + _AUTHORIZED_PROJECT
                    + " ORDER BY p.created_at DESC, p.id DESC LIMIT :limit OFFSET :offset"
                ),
                {
                    "org": principal.org_id,
                    "me": principal.user_id,
                    "limit": limit,
                    "offset": offset,
                },
            )
        ).all()
        ciphertexts = [row.name_enc for row in rows]
        versions = {version for version in (cryptor().peek_version(blob) for blob in ciphertexts) if version is not None}
        await cryptor().warm_dek_versions(db, principal.org_id, versions)

    names = await asyncio.to_thread(
        cryptor().decrypt_batch_cached, principal.org_id, ciphertexts
    )
    return [
        ProjectDTO(id=str(row.id), name=name or "", channelId=str(row.channel_id))
        for row, name in zip(rows, names, strict=True)
    ]


@router.get("/projects/{project_id}", response_model=ProjectDTO)
async def project_detail(
    project_id: str,
    principal: Principal = PrincipalDep,
) -> ProjectDTO:
    try:
        canonical_id = str(uuid.UUID(project_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="project not found") from exc
    async with session() as db:
        await set_org_context(db, principal.org_id)
        row = (
            await db.execute(
                text(
                    "SELECT p.id, p.name_enc, p.channel_id FROM projects p "
                    "WHERE p.id = :id AND p.org_id = :org "
                    "AND p.channel_id IS NOT NULL AND " + _AUTHORIZED_PROJECT
                ),
                {"id": canonical_id, "org": principal.org_id, "me": principal.user_id},
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="project not found")
        return await _project_dto(db, principal.org_id, row)
