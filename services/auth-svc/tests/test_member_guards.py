"""Member-admin guards: last-admin protection and the self-action refusal.

Both are pure-logic, and both are the kind of rule that is only ever exercised
in anger — an org with exactly one admin, or an admin who clicks the wrong row.
Getting either wrong produces a workspace nobody can administer, which cannot be
repaired from inside the product.

The concurrency half of the last-admin invariant (the per-org advisory lock in
`_lock_org_admins`) is not testable here — it needs two real transactions. It
lives in the integration suite instead; this file pins the decision function the
lock protects.
"""
from __future__ import annotations

import pytest

members_service = pytest.importorskip(
    "app.routes.members_service",
    reason="auth-svc deps (fastapi/pydantic) not installed locally; CI installs requirements.txt.",
)
members = pytest.importorskip("app.routes.members")

would_orphan_org = members_service.would_orphan_org

ALICE, BOB, CAROL = "alice-id", "bob-id", "carol-id"


def test_demoting_the_only_admin_is_refused():
    assert would_orphan_org({ALICE}, ALICE) is True


def test_demoting_one_of_two_admins_is_allowed():
    assert would_orphan_org({ALICE, BOB}, ALICE) is False


def test_acting_on_a_non_admin_is_allowed_even_with_a_single_admin():
    # The org has exactly one admin, but the target is not that admin — the
    # count is irrelevant, only whether the admin SET survives. A naive
    # `len(admins) <= 1` check would wrongly block this.
    assert would_orphan_org({ALICE}, BOB) is False


def test_acting_on_a_non_admin_in_a_multi_admin_org_is_allowed():
    assert would_orphan_org({ALICE, BOB}, CAROL) is False


def test_zero_admins_is_treated_as_orphaning():
    # Degenerate state (require_live_admin means the caller is always in the
    # set, so it should be unreachable). Fail CLOSED if it ever happens.
    assert would_orphan_org(set(), ALICE) is True


class _P:
    def __init__(self, user_id: str) -> None:
        self.user_id = user_id


def test_self_action_is_refused():
    with pytest.raises(Exception) as exc:
        members._reject_self(_P(ALICE), ALICE)
    assert getattr(exc.value, "status_code", None) == 409


def test_action_on_someone_else_passes():
    assert members._reject_self(_P(ALICE), BOB) is None
