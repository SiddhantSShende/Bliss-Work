from __future__ import annotations

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from .. import events
from ..auth import Principal, PrincipalDep
from crypto import cryptor
from ..db import session, set_org_context
from ..schemas import ReviewRequest, ReviewResponse
from .helpers import enqueue_outbox, iso, resolve_username, task_sender

router = APIRouter()


@router.post(
    "/tasks/{task_id}/assignees/{assignee_id}/review",
    response_model=ReviewResponse,
)
async def review_assignment(
    task_id: str,
    assignee_id: str,
    body: ReviewRequest,
    principal: Principal = PrincipalDep,
) -> ReviewResponse:
    """The task SENDER (allocator) leaves a review on an assignee who COMPLETED.

    Sender-only. Only allowed once the assignee is COMPLETED (409 otherwise).
    The review is editable — re-posting overwrites (the UPDATE is naturally
    idempotent). Review text is PII, encrypted at rest under the org DEK.
    """
    org_id, me = principal.org_id, principal.user_id
    async with session() as db:
        # RLS: bind org context first so task_sender, the encrypt() (reads
        # org_keys), the UPDATE (... WITH CHECK) and resolve_username all stay
        # scoped to this org and pass the org_isolation policy.
        await set_org_context(db, org_id)

        sender_id = await task_sender(db, org_id, task_id)
        if sender_id is None:
            raise HTTPException(status_code=404, detail="task not found")
        if sender_id != me:
            # Only the allocator may review. Don't disclose existence to others.
            raise HTTPException(status_code=403, detail="only the allocator can review")

        review_enc = await cryptor().encrypt(db, org_id, body.text)
        res = await db.execute(
            text(
                "UPDATE task_assignees "
                "SET review_enc = :enc, review_rating = :rating, reviewed_at = now() "
                "WHERE org_id = :org AND task_id = :tid AND assignee_id = :aid "
                "      AND status = 'COMPLETED' "
                "RETURNING reviewed_at, status_version"
            ),
            {
                "enc": review_enc,
                "rating": body.rating,
                "org": org_id,
                "tid": task_id,
                "aid": assignee_id,
            },
        )
        updated = res.first()
        if updated is None:
            await db.rollback()
            # Either no such assignment, or it isn't COMPLETED yet.
            raise HTTPException(
                status_code=409, detail="assignment must be completed before review"
            )

        reviewer_username = await resolve_username(db, org_id, me) or principal.username
        evt = events.task_reviewed(
            org_id=org_id,
            task_id=task_id,
            assignee_id=assignee_id,
            sender_id=me,
            status_version=updated.status_version,
            reviewer_username=reviewer_username,
        )
        await enqueue_outbox(db, events.TASK_TOPIC, task_id, evt)
        await db.commit()
        return ReviewResponse(
            reviewedAt=iso(updated.reviewed_at),
            review=body.text,
            reviewRating=body.rating,
        )
