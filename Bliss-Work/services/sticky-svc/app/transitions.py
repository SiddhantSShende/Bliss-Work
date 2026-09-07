"""What a task event does to a desktop pin — the whole rule, kept pure.

Separated from the Kafka consumer on purpose: this is the product rule that was
broken before, and a rule that can only be exercised by standing up a broker and
a database is a rule nobody re-checks. Everything here is a plain function over
plain data, so `tests/test_transitions.py` can state the promise directly.

── The promise ───────────────────────────────────────────────────────────────
A pin OPENS when a task is assigned, and CLOSES only when that task reaches a
terminal status for that assignee. Nothing else closes it. In particular there
is no "the user dismissed it" transition, because hiding a note is a local,
this-session decision — persisting one is what made this feature stop working.
"""

from __future__ import annotations

from dataclasses import dataclass

# Event types this service acts on. Anything else (task.reviewed, and whatever
# is added to the topic later) is ignored rather than guessed at.
ASSIGNED = "task.assigned"
ACKNOWLEDGED = "task.acknowledged"
COMPLETED = "task.completed"
IGNORED = "task.ignored"
LEFT = "task.left"
# An admin hard-deleted the task via task-svc's internal by-title endpoint.
# Terminal like the others above: the task is gone, so any pin for it must
# close rather than sit open forever waiting for a lifecycle event that will
# never arrive.
DELETED = "task.deleted"

#: Terminal event type -> the close_reason recorded against the pin.
TERMINAL_REASONS = {
    COMPLETED: "COMPLETED",
    IGNORED: "IGNORED",
    LEFT: "LEFT",
    DELETED: "DELETED",
}

OPEN = "OPEN"
CLOSED = "CLOSED"


@dataclass(frozen=True)
class PinRow:
    """The pin as it currently stands, or None where there is no row yet."""

    status: str
    assignee_status: str
    status_version: int


@dataclass(frozen=True)
class Transition:
    """What to write. `None` from `plan_transition` means "do nothing"."""

    status: str
    assignee_status: str
    status_version: int
    close_reason: str | None = None


def plan_transition(
    current: PinRow | None,
    event_type: str,
    status_version: int,
) -> Transition | None:
    """Decide the new pin state for one task event, or None to ignore it.

    `status_version` is task-svc's monotonic per-assignee counter. It is the
    guard that makes this safe on an at-least-once topic: Kafka can redeliver,
    and a partition can be read out of order, so an event carrying a version at
    or below the one already recorded must not be applied. Without it a
    redelivered `task.assigned` would reopen a pin the user had already
    completed, and the note would come back from the dead.
    """
    if event_type not in _HANDLED:
        return None

    # A first sighting. Only an assignment may create a pin: a terminal or
    # acknowledgement event for a task we never saw assigned means we missed the
    # assignment entirely, and inventing an OPEN pin from it would put a note on
    # someone's desktop for a task they have already finished.
    if current is None:
        if event_type != ASSIGNED:
            return None
        return Transition(status=OPEN, assignee_status="SENT", status_version=status_version)

    if status_version <= current.status_version and event_type != ASSIGNED:
        return None

    if event_type == ASSIGNED:
        # Reassignment after a terminal status is a genuine new commitment, so
        # this deliberately REOPENS. The version guard above is skipped for
        # exactly this case: task-svc restarts the counter at 0 for a new
        # assignee row, so a reassignment legitimately arrives with a version
        # lower than the one the closed pin is carrying.
        if current.status == CLOSED:
            return Transition(status=OPEN, assignee_status="SENT", status_version=status_version)
        # Otherwise it is a duplicate of an assignment we already have.
        return None

    if event_type == ACKNOWLEDGED:
        # Acknowledging is not a removal. The note stays; it just stops offering
        # Ignore and starts offering Complete. This is the transition people
        # most often expect to close a pin, and it must not.
        if current.status != OPEN:
            return None
        return Transition(
            status=OPEN,
            assignee_status="ACKNOWLEDGED",
            status_version=status_version,
        )

    # Terminal. The only thing that takes a note away for good.
    if current.status == CLOSED:
        return None
    return Transition(
        status=CLOSED,
        assignee_status=current.assignee_status,
        status_version=status_version,
        close_reason=TERMINAL_REASONS[event_type],
    )


_HANDLED = frozenset({ASSIGNED, ACKNOWLEDGED, *TERMINAL_REASONS})
