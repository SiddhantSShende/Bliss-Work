from __future__ import annotations

import base64
from datetime import datetime

import uuid6
from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .. import events
from ..auth import Principal, PrincipalDep
from crypto import cryptor
from ..db import session, set_org_context
from ..schemas import CreateTaskCommentRequest, TaskCommentDTO, TaskCommentPage
from .helpers import enqueue_outbox, iso, task_participants

router = APIRouter()

# Reddit-style thread: three top-level comments load up front (master spec),
# "Load more" pages in older ones. Replies load in a separate, smaller bounded
# page per comment rather than the whole reply tree at once.
_TOP_LEVEL_DEFAULT_LIMIT = 3
_TOP_LEVEL_MAX_LIMIT = 20
_REPLIES_DEFAULT_LIMIT = 10
_REPLIES_MAX_LIMIT = 50


def _encode_cursor(created_at: datetime, comment_id: str) -> str:
    raw = f"{created_at.isoformat()}|{comment_id}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        created_at_s, comment_id = raw.split("|", 1)
        return datetime.fromisoformat(created_at_s), comment_id
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid cursor") from exc


async def _require_access(
    db: AsyncSession, org_id: str, task_id: str, me: str
) -> tuple[str, list[str]]:
    """(sender_id, assignee_ids) for task_id, after checking `me` is either of
    them. 404 either way (wrong task, wrong org, or not a participant) —
    never discloses whether a task exists to someone who isn't on it, same
    convention as messaging-svc's internal channel-members lookup."""
    participants = await task_participants(db, org_id, task_id)
    if participants is None:
        raise HTTPException(status_code=404, detail="task not found")
    sender_id, assignee_ids = participants
    if me != sender_id and me not in assignee_ids:
        raise HTTPException(status_code=404, detail="task not found")
    return sender_id, assignee_ids


def _comment_dto(row, task_id: str, body: str) -> TaskCommentDTO:
    return TaskCommentDTO(
        id=str(row.id),
        taskId=task_id,
        parentCommentId=str(row.parent_comment_id) if row.parent_comment_id is not None else None,
        authorId=str(row.author_id),
        authorUsername=row.author_username,
        authorDisplayName=row.author_display_name,
        body=body,
        createdAt=iso(row.created_at),
        updatedAt=iso(row.updated_at),
        replyCount=getattr(row, "reply_count", 0) or 0,
    )


@router.get("/tasks/{task_id}/comments", response_model=TaskCommentPage)
async def list_comments(
    task_id: str,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=_TOP_LEVEL_DEFAULT_LIMIT, ge=1, le=_TOP_LEVEL_MAX_LIMIT),
    principal: Principal = PrincipalDep,
) -> TaskCommentPage:
    """Top-level comments only, newest-first. Three load up front; `cursor`
    (from a previous page's `nextCursor`) pages in older ones — a keyset
    cursor on (created_at, id) rather than OFFSET, so a comment posted while
    the thread is open never shifts an already-loaded page."""
    org_id, me = principal.org_id, principal.user_id
    async with session() as db:
        await set_org_context(db, org_id)
        await _require_access(db, org_id, task_id, me)

        params: dict[str, object] = {"tid": task_id, "org": org_id, "limit": limit + 1}
        cursor_clause = ""
        if cursor:
            cursor_created_at, cursor_id = _decode_cursor(cursor)
            cursor_clause = "AND (c.created_at, c.id) < (:ccreated, :cid) "
            params["ccreated"] = cursor_created_at
            params["cid"] = cursor_id

        rows = (
            await db.execute(
                text(
                    "SELECT c.id, c.parent_comment_id, c.author_id, c.body_enc, "
                    "       c.created_at, c.updated_at, "
                    "       COALESCE(up.username, '') AS author_username, "
                    "       COALESCE(up.display_name, '') AS author_display_name, "
                    "       (SELECT count(*) FROM task_comments r "
                    "          WHERE r.parent_comment_id = c.id) AS reply_count "
                    "FROM task_comments c "
                    "LEFT JOIN user_projection up "
                    "       ON up.user_id = c.author_id AND up.org_id = c.org_id "
                    "WHERE c.task_id = :tid AND c.org_id = :org AND c.parent_comment_id IS NULL "
                    f"{cursor_clause}"
                    "ORDER BY c.created_at DESC, c.id DESC "
                    "LIMIT :limit"
                ),
                params,
            )
        ).all()

        has_more = len(rows) > limit
        rows = rows[:limit]
        bodies = [await cryptor().decrypt(db, org_id, r.body_enc) or "" for r in rows]

    comments = [_comment_dto(r, task_id, body) for r, body in zip(rows, bodies)]
    next_cursor = _encode_cursor(rows[-1].created_at, str(rows[-1].id)) if rows and has_more else None
    return TaskCommentPage(comments=comments, nextCursor=next_cursor, hasMore=has_more)


@router.post("/tasks/{task_id}/comments", response_model=TaskCommentDTO)
async def create_comment(
    task_id: str,
    body: CreateTaskCommentRequest,
    principal: Principal = PrincipalDep,
) -> TaskCommentDTO:
    org_id, me = principal.org_id, principal.user_id
    async with session() as db:
        await set_org_context(db, org_id)
        sender_id, assignee_ids = await _require_access(db, org_id, task_id, me)

        comment_id = str(uuid6.uuid7())
        body_enc = await cryptor().encrypt(db, org_id, body.body)
        row = (
            await db.execute(
                text(
                    "INSERT INTO task_comments "
                    "(id, org_id, task_id, parent_comment_id, author_id, body_enc) "
                    "VALUES (:id, :org, :tid, NULL, :author, :body_enc) "
                    "RETURNING created_at, updated_at"
                ),
                {"id": comment_id, "org": org_id, "tid": task_id, "author": me, "body_enc": body_enc},
            )
        ).first()
        assert row is not None

        author_row = (
            await db.execute(
                text(
                    "SELECT COALESCE(username, '') AS u, COALESCE(display_name, '') AS d "
                    "FROM user_projection WHERE user_id = :uid AND org_id = :org"
                ),
                {"uid": me, "org": org_id},
            )
        ).first()

        members = sorted({sender_id, *assignee_ids})
        evt = events.task_comment_created(
            org_id=org_id,
            task_id=task_id,
            comment_id=comment_id,
            parent_comment_id=None,
            author_id=me,
            members=members,
        )
        await enqueue_outbox(db, events.TASK_TOPIC, task_id, evt)
        await db.commit()

    return TaskCommentDTO(
        id=comment_id,
        taskId=task_id,
        parentCommentId=None,
        authorId=me,
        authorUsername=author_row.u if author_row else "",
        authorDisplayName=author_row.d if author_row else "",
        body=body.body,
        createdAt=iso(row.created_at),
        updatedAt=iso(row.updated_at),
        replyCount=0,
    )


@router.get("/tasks/{task_id}/comments/{comment_id}/replies", response_model=TaskCommentPage)
async def list_replies(
    task_id: str,
    comment_id: str,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=_REPLIES_DEFAULT_LIMIT, ge=1, le=_REPLIES_MAX_LIMIT),
    principal: Principal = PrincipalDep,
) -> TaskCommentPage:
    """Replies to one top-level comment, oldest-first (natural reading order
    within a thread) — same keyset-cursor pagination as the top-level list."""
    org_id, me = principal.org_id, principal.user_id
    async with session() as db:
        await set_org_context(db, org_id)
        await _require_access(db, org_id, task_id, me)

        params: dict[str, object] = {"tid": task_id, "pid": comment_id, "org": org_id, "limit": limit + 1}
        cursor_clause = ""
        if cursor:
            cursor_created_at, cursor_id = _decode_cursor(cursor)
            cursor_clause = "AND (c.created_at, c.id) > (:ccreated, :cid) "
            params["ccreated"] = cursor_created_at
            params["cid"] = cursor_id

        rows = (
            await db.execute(
                text(
                    "SELECT c.id, c.parent_comment_id, c.author_id, c.body_enc, "
                    "       c.created_at, c.updated_at, "
                    "       COALESCE(up.username, '') AS author_username, "
                    "       COALESCE(up.display_name, '') AS author_display_name "
                    "FROM task_comments c "
                    "LEFT JOIN user_projection up "
                    "       ON up.user_id = c.author_id AND up.org_id = c.org_id "
                    "WHERE c.task_id = :tid AND c.org_id = :org AND c.parent_comment_id = :pid "
                    f"{cursor_clause}"
                    "ORDER BY c.created_at ASC, c.id ASC "
                    "LIMIT :limit"
                ),
                params,
            )
        ).all()

        has_more = len(rows) > limit
        rows = rows[:limit]
        bodies = [await cryptor().decrypt(db, org_id, r.body_enc) or "" for r in rows]

    comments = [_comment_dto(r, task_id, body) for r, body in zip(rows, bodies)]
    next_cursor = _encode_cursor(rows[-1].created_at, str(rows[-1].id)) if rows and has_more else None
    return TaskCommentPage(comments=comments, nextCursor=next_cursor, hasMore=has_more)


@router.post("/tasks/{task_id}/comments/{comment_id}/replies", response_model=TaskCommentDTO)
async def create_reply(
    task_id: str,
    comment_id: str,
    body: CreateTaskCommentRequest,
    principal: Principal = PrincipalDep,
) -> TaskCommentDTO:
    org_id, me = principal.org_id, principal.user_id
    async with session() as db:
        await set_org_context(db, org_id)
        sender_id, assignee_ids = await _require_access(db, org_id, task_id, me)

        # The parent must be a TOP-LEVEL comment belonging to THIS task — both
        # guard against the thread growing a third level and against a reply
        # smuggled onto a different task's comment via a guessed id.
        parent = (
            await db.execute(
                text(
                    "SELECT 1 FROM task_comments "
                    "WHERE id = :pid AND org_id = :org AND task_id = :tid "
                    "      AND parent_comment_id IS NULL"
                ),
                {"pid": comment_id, "org": org_id, "tid": task_id},
            )
        ).first()
        if parent is None:
            raise HTTPException(status_code=404, detail="comment not found")

        reply_id = str(uuid6.uuid7())
        body_enc = await cryptor().encrypt(db, org_id, body.body)
        row = (
            await db.execute(
                text(
                    "INSERT INTO task_comments "
                    "(id, org_id, task_id, parent_comment_id, author_id, body_enc) "
                    "VALUES (:id, :org, :tid, :pid, :author, :body_enc) "
                    "RETURNING created_at, updated_at"
                ),
                {
                    "id": reply_id,
                    "org": org_id,
                    "tid": task_id,
                    "pid": comment_id,
                    "author": me,
                    "body_enc": body_enc,
                },
            )
        ).first()
        assert row is not None

        author_row = (
            await db.execute(
                text(
                    "SELECT COALESCE(username, '') AS u, COALESCE(display_name, '') AS d "
                    "FROM user_projection WHERE user_id = :uid AND org_id = :org"
                ),
                {"uid": me, "org": org_id},
            )
        ).first()

        members = sorted({sender_id, *assignee_ids})
        evt = events.task_comment_created(
            org_id=org_id,
            task_id=task_id,
            comment_id=reply_id,
            parent_comment_id=comment_id,
            author_id=me,
            members=members,
        )
        await enqueue_outbox(db, events.TASK_TOPIC, task_id, evt)
        await db.commit()

    return TaskCommentDTO(
        id=reply_id,
        taskId=task_id,
        parentCommentId=comment_id,
        authorId=me,
        authorUsername=author_row.u if author_row else "",
        authorDisplayName=author_row.d if author_row else "",
        body=body.body,
        createdAt=iso(row.created_at),
        updatedAt=iso(row.updated_at),
        replyCount=0,
    )
