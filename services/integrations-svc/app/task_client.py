"""Creating a task in task-svc when a mention is claimed.

We forward the CALLER's own bearer token rather than using the internal shared
secret. task-svc then applies its normal authorization, and the resulting task is
authored by the human who clicked Claim — there is no path here for this service
to assert a user identity that task-svc cannot verify for itself.

Retries are safe because the Idempotency-Key is DERIVED FROM the activity id, not
random: task-svc's `idempotency_keys` table returns the original task id for a
repeat, so a retried (or re-clicked, or multi-device) claim can never produce a
second task. That property is what lets the caller retry freely after a crash.
"""

from __future__ import annotations

import uuid

import httpx

from .config import settings
from .resilience import CircuitBreaker, retry_async

_TIMEOUT = httpx.Timeout(5.0, connect=2.0)
_task_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="task-svc")

# Fixed namespace for claim keys. Derived from a URL namespace so it is
# reproducible from source rather than a magic constant someone might "tidy up".
_MENTION_NS = uuid.uuid5(uuid.NAMESPACE_URL, "https://blisswork.app/ns/mention-claim")


class TaskServiceError(Exception):
    """task-svc refused or was unreachable; nothing was created."""


def claim_idempotency_key(activity_id: str) -> str:
    """The SAME key for the same mention, forever, from any device."""
    return str(uuid.uuid5(_MENTION_NS, activity_id))


async def create_task(
    *, bearer: str, activity_id: str, title: str, description: str, assignee_id: str
) -> str:
    """Create a task assigned to `assignee_id`; returns its id.

    Raises TaskServiceError on any non-2xx or transport failure, so the caller
    leaves the mention `pending` and the user can simply try again.
    """

    async def _attempt() -> str:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{settings.task_internal_base.rstrip('/')}/api/v1/tasks",
                headers={
                    "Authorization": bearer,
                    "Idempotency-Key": claim_idempotency_key(activity_id),
                    "Content-Type": "application/json",
                },
                json={
                    "title": title,
                    "description": description,
                    "assigneeIds": [assignee_id],
                },
            )
            if r.status_code in (200, 201):
                task_id = (r.json() or {}).get("taskId")
                if not task_id:
                    raise TaskServiceError("task-svc returned no taskId")
                return str(task_id)
            # 4xx is definitive — retrying a rejected body just burns the budget.
            if 400 <= r.status_code < 500:
                raise TaskServiceError(f"task-svc rejected the task ({r.status_code})")
            r.raise_for_status()  # 5xx → let retry_async classify it as transient
            raise TaskServiceError(f"unexpected status {r.status_code}")

    try:
        return await retry_async(_attempt, attempts=3, breaker=_task_breaker)
    except TaskServiceError:
        raise
    except Exception as exc:  # noqa: BLE001 — transport/breaker/5xx exhaustion
        raise TaskServiceError(str(exc)) from exc


def build_task_text(
    *, body: str, provider: str, peer: str, occurred_at: str, permalink: str | None
) -> tuple[str, str]:
    """Turn a mention into (title, description).

    Tasks have no source/provenance columns, so where this came from has to ride
    in the text — otherwise a claimed task is an orphan sentence with no way back
    to the conversation that produced it.
    """
    first_line = " ".join((body or "").split())
    title = first_line[:120] if first_line else f"{provider.title()} mention from {peer}"
    parts = [
        (body or "").strip()[:4000],
        f"— via {provider} · {peer} · {occurred_at}",
        permalink or "",
    ]
    return title, "\n\n".join(p for p in parts if p)
