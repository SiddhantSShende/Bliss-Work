"""What a task event does to a desktop pin — and what a user's pin/unpin does to it.

Separated from the Kafka consumer and the HTTP routes on purpose: this is the
product rule that was broken before, and a rule that can only be exercised by
standing up a broker and a database is a rule nobody re-checks. Everything here
is a plain function over plain data, so `tests/test_transitions.py` can state the
promise directly.

── The promise ───────────────────────────────────────────────────────────────
Two independent axes, never merged:

  LIFECYCLE (`status`, written only by `plan_transition`, from task events)
    A pin OPENS when a task is assigned, and CLOSES only when that task reaches
    a terminal status for that assignee. Nothing else closes it.

  USER INTENT (`pin_state`, written only by `plan_user_pin`, from PUT/DELETE)
    PINNED or UNPINNED, flipped only by the user, in either direction, any
    number of times while the task is open. A lifecycle event never flips it —
    except the one case in `plan_transition`: a task assigned afresh after a
    terminal close is a new commitment, so it starts PINNED.

A note belongs on screen iff the pin is OPEN *and* PINNED. An Unpin therefore
hides a note without closing the commitment, and a terminal status closes it
without ever being recorded as an Unpin. Conflating the two is what made the
old client-side "never re-pin" veto permanent.
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
# task-svc's deadline sweeper: the assignment's deadline passed before it was
# completed. Terminal for that assignee — a pin must not float for work that is
# now in the Missed bucket.
MISSED = "task.missed"
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
    MISSED: "MISSED",
    DELETED: "DELETED",
}

OPEN = "OPEN"
CLOSED = "CLOSED"

#: User intent (`pin_state`). See the module docstring.
PINNED = "PINNED"
UNPINNED = "UNPINNED"


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
        #
        # It also starts PINNED again (the consumer resets `pin_state`): an
        # Unpin was a decision about the PREVIOUS commitment, and a fresh
        # allocation must surface rather than be silently held back by it.
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


#: What `plan_user_pin` decided.
CHANGED = "changed"
UNCHANGED = "unchanged"
#: The commitment is already finished; a user cannot pin or unpin it.
CLOSED_OUTCOME = "closed"


def plan_user_pin(lifecycle_status: str, current_pin_state: str, want: str) -> str:
    """Decide what a user's pin (`want=PINNED`) or unpin (`want=UNPINNED`) does.

    Pure, and deliberately idempotent: asking for the state the pin is already in
    is `UNCHANGED`, so a retried request can never invert anything and emits no
    second event. Only an OPEN pin can change; a CLOSED one is a finished
    commitment and the lifecycle, not the user, owns it.
    """
    if lifecycle_status != OPEN:
        return CLOSED_OUTCOME
    if current_pin_state == want:
        return UNCHANGED
    return CHANGED
