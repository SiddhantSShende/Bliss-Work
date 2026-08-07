"""Hub mentions API — the "someone tagged me" feed and its two actions.

  GET    /integrations/mentions?state=&limit=&cursor=  → keyset page
  POST   /integrations/mentions/{id}/claim             → create a task for me
  POST   /integrations/mentions/{id}/ignore            → dismiss permanently
  GET    /integrations/identities                      → my handles
  POST   /integrations/identities                      → declare a handle
  DELETE /integrations/identities/{id}                 → remove one

Both actions are IDEMPOTENT. Every state change is a conditional UPDATE guarded
on the current state, so a double-click, a retry after a dropped response, or two
devices racing all converge on one outcome instead of two tasks.

A mention belonging to someone else answers 404, never 403: 403 would confirm the
row exists, which leaks that a colleague was tagged.
"""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query, Response, status
from sqlalchemy import text

from ..auth import Principal, PrincipalDep
from ..crypto import cryptor
from ..cursor import decode_cursor, encode_cursor
from ..db import session, set_org_context
from ..identities import (
    HandleTakenError,
    add_declared_identity,
    delete_identity,
    list_identities,
)
from ..schemas import ClaimOut, IdentityIn, IdentityOut, MentionOut, MentionPageOut, StateOut
from ..task_client import TaskServiceError, build_task_text, create_task

# NOTE — do NOT add per-route @limiter.limit decorators here. Under
# `from __future__ import annotations` slowapi's wrapper shifts the
# annotation-resolution namespace and breaks FastAPI body parsing (post_identity
# takes a pydantic body); auth-svc/app/rate_limit.py documents the same trap and
# routes around it with middleware. SlowAPIMiddleware already applies the global
# 600/min per-user budget from app/rate_limit.py to every route here, and these
# endpoints are authenticated and bounded by the caller's own mention count.
router = APIRouter()

_STATES = ("pending", "claimed", "ignored")
_MAX_LIMIT = 50


@router.get("/integrations/mentions", response_model=MentionPageOut)
async def list_mentions(
    state: str = Query("pending"),
    limit: int = Query(25, ge=1, le=_MAX_LIMIT),
    cursor: str | None = Query(None),
    principal: Principal = PrincipalDep,
) -> MentionPageOut:
    if state not in _STATES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid state")

    cur_ts = cur_id = None
    if cursor:
        try:
            cur_ts, cur_id = decode_cursor(cursor)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="invalid cursor"
            ) from None

    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = (
            await db.execute(
                text(
                    """
                    SELECT id, provider, kind, peer_enc, body_enc,
                           external_thread_ref_enc, external_permalink_enc,
                           mention_state, claimed_task_id, occurred_at
                      FROM provider_activity
                     WHERE is_mention
                       AND mention_user_id = :uid
                       AND mention_state = :state
                       AND (
                             CAST(:cur_ts AS timestamptz) IS NULL
                             OR (occurred_at, id) < (CAST(:cur_ts AS timestamptz), CAST(:cur_id AS uuid))
                           )
                     ORDER BY occurred_at DESC, id DESC
                     LIMIT :lim
                    """
                ),
                {
                    "uid": principal.user_id,
                    "state": state,
                    "cur_ts": cur_ts,
                    "cur_id": cur_id,
                    # One extra row tells us whether another page exists without
                    # a second COUNT query.
                    "lim": limit + 1,
                },
            )
        ).all()

        has_more = len(rows) > limit
        page = rows[:limit]
        items = [await _row_to_mention(db, principal.org_id, r) for r in page]

    next_cursor = (
        encode_cursor(page[-1].occurred_at, str(page[-1].id)) if has_more and page else None
    )
    return MentionPageOut(items=items, nextCursor=next_cursor)


async def _row_to_mention(db, org_id: str, r) -> MentionOut:
    dec = cryptor().decrypt
    return MentionOut(
        id=str(r.id),
        provider=r.provider,
        kind=r.kind,
        peer=await dec(db, org_id, bytes(r.peer_enc)) if r.peer_enc else "",
        body=await dec(db, org_id, bytes(r.body_enc)) if r.body_enc else "",
        threadRef=await dec(db, org_id, bytes(r.external_thread_ref_enc))
        if r.external_thread_ref_enc
        else None,
        permalink=await dec(db, org_id, bytes(r.external_permalink_enc))
        if r.external_permalink_enc
        else None,
        state=r.mention_state,
        taskId=str(r.claimed_task_id) if r.claimed_task_id else None,
        occurredAt=r.occurred_at.isoformat(),
    )


@router.post("/integrations/mentions/{activity_id}/claim", response_model=ClaimOut)
async def claim_mention(
    activity_id: str,
    principal: Principal = PrincipalDep,
    authorization: str | None = Header(default=None),
) -> ClaimOut:
    """Turn a mention into a task assigned to the caller.

    Ordering is deliberate — TX1 (read) → HTTP → TX2 (conditional write) — and no
    lock is held across the network call.

    Every failure window is recoverable:
      * task created but TX2 lost      → row stays pending; clicking Claim again
                                         re-uses the deterministic idempotency
                                         key, so task-svc returns the SAME task
                                         and TX2 then succeeds. Self-healing.
      * TX2 committed but reply lost   → the retry short-circuits below at
                                         'claimed' and returns the stored id.
      * two devices at once            → same key ⇒ one task; the losing UPDATE
                                         reads back the identical id.
    """
    # ── TX1: validate + read the payload we need, then release. ───────────────
    async with session() as db:
        await set_org_context(db, principal.org_id)
        row = (
            await db.execute(
                text(
                    """
                    SELECT id, provider, peer_enc, body_enc, external_permalink_enc,
                           mention_state, claimed_task_id, occurred_at
                      FROM provider_activity
                     WHERE id = :id AND is_mention AND mention_user_id = :uid
                    """
                ),
                {"id": activity_id, "uid": principal.user_id},
            )
        ).one_or_none()

        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="mention not found")
        if row.mention_state == "claimed":
            # Replay, not an error.
            return ClaimOut(taskId=str(row.claimed_task_id), state="claimed")
        if row.mention_state == "ignored":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="mention was already dismissed"
            )

        dec = cryptor().decrypt
        body = await dec(db, principal.org_id, bytes(row.body_enc)) if row.body_enc else ""
        peer = await dec(db, principal.org_id, bytes(row.peer_enc)) if row.peer_enc else ""
        permalink = (
            await dec(db, principal.org_id, bytes(row.external_permalink_enc))
            if row.external_permalink_enc
            else None
        )
        provider = row.provider
        occurred_at = row.occurred_at.isoformat()

    # ── HTTP: create the task. Nothing is written if this fails. ──────────────
    title, description = build_task_text(
        body=body or "",
        provider=provider,
        peer=peer or "",
        occurred_at=occurred_at,
        permalink=permalink,
    )
    try:
        task_id = await create_task(
            bearer=authorization or "",
            activity_id=activity_id,
            title=title,
            description=description,
            assignee_id=principal.user_id,
        )
    except TaskServiceError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="couldn't create the task"
        ) from exc

    # ── TX2: record the claim, guarded on still being pending. ────────────────
    async with session() as db:
        await set_org_context(db, principal.org_id)
        res = await db.execute(
            text(
                """
                UPDATE provider_activity
                   SET mention_state = 'claimed', claimed_task_id = CAST(:tid AS uuid),
                       claimed_by = :uid, claimed_at = now()
                 WHERE id = :id AND is_mention AND mention_user_id = :uid
                   AND mention_state = 'pending'
                """
            ),
            {"tid": task_id, "uid": principal.user_id, "id": activity_id},
        )
        if res.rowcount == 0:
            # Someone else won the race (or it was ignored meanwhile).
            settled = (
                await db.execute(
                    text(
                        "SELECT mention_state, claimed_task_id FROM provider_activity "
                        " WHERE id = :id AND mention_user_id = :uid"
                    ),
                    {"id": activity_id, "uid": principal.user_id},
                )
            ).one_or_none()
            await db.commit()
            if settled is not None and settled.mention_state == "claimed":
                return ClaimOut(taskId=str(settled.claimed_task_id), state="claimed")
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="mention was already dismissed"
            )
        await db.commit()

    return ClaimOut(taskId=task_id, state="claimed")


@router.post("/integrations/mentions/{activity_id}/ignore", response_model=StateOut)
async def ignore_mention(activity_id: str, principal: Principal = PrincipalDep) -> StateOut:
    """Dismiss a mention permanently. Idempotent; 409 if already claimed."""
    async with session() as db:
        await set_org_context(db, principal.org_id)
        res = await db.execute(
            text(
                """
                UPDATE provider_activity
                   SET mention_state = 'ignored'
                 WHERE id = :id AND is_mention AND mention_user_id = :uid
                   AND mention_state = 'pending'
                """
            ),
            {"id": activity_id, "uid": principal.user_id},
        )
        if res.rowcount == 0:
            settled = (
                await db.execute(
                    text(
                        "SELECT mention_state, claimed_task_id FROM provider_activity "
                        " WHERE id = :id AND is_mention AND mention_user_id = :uid"
                    ),
                    {"id": activity_id, "uid": principal.user_id},
                )
            ).one_or_none()
            await db.commit()
            if settled is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="mention not found"
                )
            if settled.mention_state == "ignored":
                return StateOut(state="ignored")  # already dismissed — fine
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"mention was already claimed as task {settled.claimed_task_id}",
            )
        await db.commit()
    return StateOut(state="ignored")


# ── Declared handles ──────────────────────────────────────────────────────────
@router.get("/integrations/identities", response_model=list[IdentityOut])
async def get_identities(principal: Principal = PrincipalDep) -> list[IdentityOut]:
    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = await list_identities(db, org_id=principal.org_id, user_id=principal.user_id)
    return [IdentityOut(**r) for r in rows]


@router.post(
    "/integrations/identities", response_model=IdentityOut, status_code=status.HTTP_201_CREATED
)
async def post_identity(body: IdentityIn, principal: Principal = PrincipalDep) -> IdentityOut:
    handle = (body.handle or "").strip()
    if not handle:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="handle is required")

    kind = "email" if "@" in handle else "account"
    async with session() as db:
        await set_org_context(db, principal.org_id)
        try:
            await add_declared_identity(
                db,
                org_id=principal.org_id,
                user_id=principal.user_id,
                provider=body.provider,
                handle=handle,
                handle_kind=kind,
            )
        except HandleTakenError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="that handle is already mapped to another teammate",
            ) from None
        # Read BEFORE committing. `set_org_context` binds app.org_id with
        # is_local => true, so the commit ends the transaction and resets it —
        # a query after this point runs with no org context at all, RLS returns
        # zero rows, and the defensive 500 below fires on a handle that was
        # saved perfectly well. The new row is already visible inside this
        # transaction, so there is nothing to wait for.
        rows = await list_identities(db, org_id=principal.org_id, user_id=principal.user_id)
        await db.commit()

    match = next(
        (r for r in rows if r["provider"] == body.provider and r["handle"] == handle), None
    )
    if match is None:  # pragma: no cover — defensive
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="identity not readable"
        )
    return IdentityOut(**match)


@router.delete("/integrations/identities/{identity_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_identity(identity_id: str, principal: Principal = PrincipalDep) -> Response:
    async with session() as db:
        await set_org_context(db, principal.org_id)
        removed = await delete_identity(
            db, org_id=principal.org_id, user_id=principal.user_id, identity_id=identity_id
        )
        await db.commit()
    if not removed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="identity not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
