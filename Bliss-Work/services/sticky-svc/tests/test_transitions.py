"""The pin lifecycle rule, stated as tests.

These are the product promise in executable form: an allocation opens a pin, and
only Completing / Ignoring / Leaving closes it. If one of these has to be
changed to make a refactor pass, the desktop-sticking feature has been broken.
"""

from __future__ import annotations

import pytest

from app.transitions import (
    ACKNOWLEDGED,
    ASSIGNED,
    CLOSED,
    COMPLETED,
    IGNORED,
    LEFT,
    OPEN,
    PinRow,
    plan_transition,
)


def test_assignment_opens_a_pin():
    t = plan_transition(None, ASSIGNED, 0)
    assert t is not None
    assert t.status == OPEN
    assert t.assignee_status == "SENT"


def test_acknowledging_does_NOT_close_the_pin():
    # The transition people most often expect to remove the note. It must not:
    # acknowledging is taking the task on, not finishing it. The note stays and
    # swaps Acknowledge/Ignore for Complete.
    t = plan_transition(PinRow(OPEN, "SENT", 0), ACKNOWLEDGED, 1)
    assert t is not None
    assert t.status == OPEN
    assert t.assignee_status == "ACKNOWLEDGED"


@pytest.mark.parametrize(
    ("event", "reason"),
    [(COMPLETED, "COMPLETED"), (IGNORED, "IGNORED"), (LEFT, "LEFT")],
)
def test_only_a_terminal_status_closes_a_pin(event, reason):
    t = plan_transition(PinRow(OPEN, "ACKNOWLEDGED", 1), event, 2)
    assert t is not None
    assert t.status == CLOSED
    assert t.close_reason == reason


def test_there_is_no_dismissed_transition():
    # There is deliberately no event that means "the user cleared the note".
    # Hiding is a client-side, this-session decision; persisting one is exactly
    # what made reading a task retire its note for good.
    for made_up in ("task.dismissed", "sticky.dismissed", "task.read", "task.opened"):
        assert plan_transition(PinRow(OPEN, "SENT", 0), made_up, 9) is None


def test_an_unknown_event_type_is_ignored_not_guessed_at():
    assert plan_transition(PinRow(OPEN, "SENT", 0), "task.reviewed", 5) is None
    assert plan_transition(None, "something.new", 1) is None


class TestRedeliveryIsSafe:
    """Kafka is at-least-once, so every one of these WILL happen in production."""

    def test_a_redelivered_assignment_does_not_disturb_an_open_pin(self):
        assert plan_transition(PinRow(OPEN, "ACKNOWLEDGED", 3), ASSIGNED, 0) is None

    def test_a_stale_event_cannot_reopen_a_closed_pin(self):
        # The dangerous one: without the version guard, a redelivered
        # acknowledgement after completion would put the note back on a desktop
        # for a task that is already done.
        assert plan_transition(PinRow(CLOSED, "ACKNOWLEDGED", 5), ACKNOWLEDGED, 2) is None

    def test_a_repeated_terminal_event_is_a_no_op(self):
        assert plan_transition(PinRow(CLOSED, "ACKNOWLEDGED", 5), COMPLETED, 6) is None

    def test_an_out_of_order_acknowledgement_is_dropped(self):
        assert plan_transition(PinRow(OPEN, "ACKNOWLEDGED", 4), ACKNOWLEDGED, 4) is None


class TestPinsAreNotInventedFromNothing:
    """A pin may only be created by an assignment we actually saw."""

    @pytest.mark.parametrize("event", [ACKNOWLEDGED, COMPLETED, IGNORED, LEFT])
    def test_a_non_assignment_event_for_an_unknown_task_creates_nothing(self, event):
        # Otherwise a missed assignment plus a completion would put a note on
        # someone's desktop for a task they have already finished.
        assert plan_transition(None, event, 3) is None


def test_reassignment_after_a_terminal_status_reopens_the_pin():
    # A genuine new commitment. task-svc restarts status_version at 0 for the
    # new assignee row, so this arrives with a LOWER version than the closed pin
    # carries — which is why the version guard deliberately skips this case.
    t = plan_transition(PinRow(CLOSED, "ACKNOWLEDGED", 7), ASSIGNED, 0)
    assert t is not None
    assert t.status == OPEN
    assert t.assignee_status == "SENT"
    assert t.close_reason is None


# ── User pin intent (pin_state) ───────────────────────────────────────────────
# The second axis. A user's Pin / Unpin and the task lifecycle are separate:
# these state the half of the promise `plan_transition` cannot.

from app.transitions import (  # noqa: E402
    CHANGED,
    CLOSED_OUTCOME,
    PINNED,
    UNCHANGED,
    UNPINNED,
    plan_user_pin,
)


def test_unpinning_a_pinned_open_task_changes_it():
    assert plan_user_pin(OPEN, PINNED, UNPINNED) == CHANGED


def test_repinning_an_unpinned_open_task_changes_it():
    # The whole point of replacing the permanent veto: Unpin is reversible.
    assert plan_user_pin(OPEN, UNPINNED, PINNED) == CHANGED


@pytest.mark.parametrize("state", [PINNED, UNPINNED])
def test_asking_for_the_state_it_is_already_in_is_a_no_op(state):
    # Idempotent: a retried request must not invert, and must not emit again.
    assert plan_user_pin(OPEN, state, state) == UNCHANGED


@pytest.mark.parametrize("want", [PINNED, UNPINNED])
@pytest.mark.parametrize("state", [PINNED, UNPINNED])
def test_a_user_cannot_change_a_closed_pin(state, want):
    # A finished commitment belongs to the lifecycle, not to the user.
    assert plan_user_pin(CLOSED, state, want) == CLOSED_OUTCOME


def test_no_task_event_can_flip_the_users_choice():
    # plan_transition has no notion of pin_state at all: whatever a lifecycle
    # event plans, it can only ever say OPEN or CLOSED. This pins that contract
    # so adding a pin_state to Transition is a deliberate, reviewed change.
    assert not hasattr(plan_transition(None, ASSIGNED, 0), "pin_state")
