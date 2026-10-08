"""The boundaries that decide who can read what, and how much detail is kept.

`resolve_subject` is the entire enforcement point of the transparency model —
every member sees their own record, only an admin sees anyone else's — so it gets
a test of its own rather than being covered incidentally through a route.

The clamp and the coarsening functions are here for the same reason: each one is
a deliberate limit on what the record can contain, and each is a single
expression that would be easy to "simplify" away.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

subject = pytest.importorskip(
    "app.routes.subject",
    reason="telemetry-svc deps not installed locally; CI installs requirements.txt.",
)
ingest = pytest.importorskip("app.ingest")
sessions = pytest.importorskip("app.sessions")
auth = pytest.importorskip("app.auth")

ALICE, BOB = "alice-id", "bob-id"


def _p(user_id: str, *roles: str) -> "auth.Principal":
    return auth.Principal(user_id=user_id, org_id="org-1", roles=list(roles), username="u")


# ── who may read whose activity ───────────────────────────────────────────────
def test_a_member_may_read_their_own_record():
    assert subject.resolve_subject(_p(ALICE, "member"), ALICE) == ALICE


def test_me_resolves_to_the_caller():
    assert subject.resolve_subject(_p(ALICE, "member"), "me") == ALICE
    assert subject.resolve_subject(_p(ALICE, "member"), None) == ALICE


def test_a_member_may_NOT_read_someone_elses_record():
    with pytest.raises(Exception) as exc:
        subject.resolve_subject(_p(ALICE, "member"), BOB)
    assert getattr(exc.value, "status_code", None) == 403


def test_an_admin_may_read_anyone():
    assert subject.resolve_subject(_p(ALICE, "org_admin"), BOB) == BOB


def test_org_wide_views_require_admin():
    subject.require_admin(_p(ALICE, "org_admin"))  # does not raise
    with pytest.raises(Exception) as exc:
        subject.require_admin(_p(ALICE, "member"))
    assert getattr(exc.value, "status_code", None) == 403


# ── clock clamp ───────────────────────────────────────────────────────────────
NOW = datetime(2026, 8, 13, 12, 0, tzinfo=timezone.utc)


def test_a_wildly_future_clock_is_clamped():
    # Unclamped, this row would target a partition a year ahead that does not
    # exist and never will — the write would fail, and the recovery path cannot
    # create a partition that far out either.
    assert ingest.clamp_occurred_at(NOW + timedelta(days=365), NOW) <= NOW + timedelta(minutes=10)


def test_a_wildly_backdated_clock_is_clamped():
    # Unclamped, a device with a broken clock could write into a partition that
    # was pruned months ago, or bury today's activity in 1970.
    assert ingest.clamp_occurred_at(NOW - timedelta(days=365), NOW) >= NOW - timedelta(days=2)


def test_a_plausible_timestamp_is_left_alone():
    ten_min_ago = NOW - timedelta(minutes=10)
    assert ingest.clamp_occurred_at(ten_min_ago, NOW) == ten_min_ago


def test_a_naive_timestamp_is_treated_as_utc():
    naive = (NOW - timedelta(minutes=5)).replace(tzinfo=None)
    assert ingest.clamp_occurred_at(naive, NOW).tzinfo is not None


def test_absent_timestamp_falls_back_to_now():
    assert ingest.clamp_occurred_at(None, NOW) == NOW


# ── coarsening: what is stored in the clear ───────────────────────────────────
def test_ipv4_is_coarsened_to_a_24():
    assert sessions.ip_prefix("203.0.113.42") == "203.0.113.0/24"


def test_ipv6_is_coarsened_to_a_48():
    assert sessions.ip_prefix("2001:db8:1234:5678::1") == "2001:db8:1234::/48"


def test_compressed_ipv6_is_coarsened_by_address_bits_not_colon_components():
    assert sessions.ip_prefix("2001:db8::1") == "2001:db8::/48"


def test_garbage_addresses_produce_nothing_rather_than_a_wrong_prefix():
    assert sessions.ip_prefix(None) is None
    assert sessions.ip_prefix("") is None
    assert sessions.ip_prefix("not-an-ip") is None


@pytest.mark.parametrize(
    "ua,expected",
    [
        ("Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36", "Chrome · Windows"),
        # Edge and Chrome both contain "Chrome/"; longest-first ordering is what
        # keeps Edge from being mislabelled.
        ("Mozilla/5.0 (Windows NT 10.0) Chrome/141 Safari/537.36 Edg/141.0", "Edge · Windows"),
        ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", "Safari · macOS"),
        ("Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0", "Firefox · Linux"),
    ],
)
def test_device_label_is_readable_and_not_a_fingerprint(ua, expected):
    label = sessions.device_label(ua, "web")
    assert label == expected
    # The point of the label: the raw UA never reaches the UI.
    assert "Mozilla" not in label and "537.36" not in label


def test_desktop_is_labelled_by_the_app_not_the_embedded_browser():
    assert sessions.device_label(
        "Mozilla/5.0 (Windows NT 10.0) Electron/42 Chrome/141", "desktop"
    ) == "BlissWork Desktop · Windows"


def test_unknown_user_agent_still_produces_something_renderable():
    assert sessions.device_label(None, "web") == "Browser"
