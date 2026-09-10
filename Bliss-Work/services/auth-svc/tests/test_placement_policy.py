"""Placement: the cascade, the ceiling, and the alert.

Pure-logic tests against app.routing.policy. Placement is decided ONCE per
organisation and there is no rebalancing, so a wrong branch here is not a
transient fault — it is an org living on the wrong continent for as long as it
exists.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.routing.policy import (
    REASON_CASCADE,
    REASON_LEAST_FILLED,
    REASON_NEAREST,
    REASON_NO_CAPACITY,
    REASON_UNKNOWN_CAPACITY,
    SiteCapacity,
    choose_site,
)

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
GB = 1 << 30
CEILING = 100_000 * GB  # the worked example from the spec: 100,000 GB per site


def site(name: str, pct: float, *, age: timedelta = timedelta(0), ceiling: int = CEILING) -> SiteCapacity:
    return SiteCapacity(
        site=name,
        used_bytes=int(ceiling * pct / 100),
        ceiling_bytes=ceiling,
        reported_at=NOW - age,
    )


def caps(*sites: SiteCapacity) -> dict[str, SiteCapacity]:
    return {s.site: s for s in sites}


# ── 1. normal placement ──────────────────────────────────────────────────────


def test_normal_placement_takes_the_nearest_site():
    decision = choose_site(["a", "b"], caps(site("a", 12.0), site("b", 3.0)), now=NOW)

    # Nearest wins outright: emptier is NOT better while the nearest has room.
    # Distance is the user's latency on every request for the life of the org;
    # fill percentage is a number on a dashboard.
    assert decision.site == "a"
    assert decision.reason == REASON_NEAREST
    assert decision.alerts == ()


# ── 2. cascade to the next site ──────────────────────────────────────────────


def test_cascade_skips_a_busy_site_and_takes_the_next_nearest():
    decision = choose_site(["a", "b", "c"], caps(site("a", 81.0), site("b", 40.0), site("c", 1.0)), now=NOW)

    # b, not c: the cascade takes the FIRST candidate with room, not the
    # emptiest one. Walking past b to reach c would trade the user's latency for
    # a fill percentage nobody asked about.
    assert decision.site == "b"
    assert decision.reason == REASON_CASCADE


def test_the_threshold_is_inclusive_at_eighty():
    # Exactly 80% is over the line, not under it. An off-by-one here is a site
    # that keeps taking new orgs for exactly as long as nobody notices.
    assert choose_site(["a", "b"], caps(site("a", 80.0), site("b", 5.0)), now=NOW).site == "b"
    assert choose_site(["a", "b"], caps(site("a", 79.999), site("b", 5.0)), now=NOW).site == "a"


# ── 3. every site above 80% ──────────────────────────────────────────────────


def test_when_every_site_is_busy_the_emptiest_wins_regardless_of_distance():
    decision = choose_site(
        ["a", "b"],
        caps(site("a", 95.0), site("b", 88.0), site("c", 82.0)),
        now=NOW,
    )

    # c is not even a candidate — it is the far side of the world — and it still
    # wins. A signup is never failed because the nearby sites are busy: latency
    # is a degradation, refusing the account is an outage.
    assert decision.site == "c"
    assert decision.reason == REASON_LEAST_FILLED


def test_the_busy_fallback_still_reports_every_site_over_the_line():
    decision = choose_site(["a"], caps(site("a", 95.0), site("b", 82.0)), now=NOW)

    # Including the site that just took the org. It is over 80% and someone
    # should hear about it even though it was the best available answer.
    assert {c.site for c in decision.alerts} == {"a", "b"}
    assert [c.site for c in decision.alerts] == ["a", "b"]  # fullest first


# ── 4. the hard ceiling ──────────────────────────────────────────────────────


def test_no_placement_when_even_the_emptiest_site_is_at_its_ceiling():
    decision = choose_site(["a", "b"], caps(site("a", 100.0), site("b", 100.0)), now=NOW)

    # A provisioning event, not a routing decision: there is no site with room,
    # and no amount of cascading invents one. The signup fails loudly rather
    # than quietly overfilling a disk.
    assert decision.site is None
    assert decision.reason == REASON_NO_CAPACITY


def test_a_site_over_its_ceiling_is_still_refused():
    over = SiteCapacity("a", used_bytes=CEILING + GB, ceiling_bytes=CEILING, reported_at=NOW)
    assert choose_site(["a"], caps(over), now=NOW).site is None


def test_a_site_with_no_configured_ceiling_reads_as_full_not_infinite():
    # The dangerous default. "Unconfigured" must never mean "unlimited", or the
    # one site somebody forgot becomes the destination for every new org.
    unconfigured = SiteCapacity("a", used_bytes=0, ceiling_bytes=0, reported_at=NOW)
    decision = choose_site(["a", "b"], caps(unconfigured, site("b", 10.0)), now=NOW)
    assert decision.site == "b"


def test_a_ceiling_breach_at_one_site_does_not_block_placement_elsewhere():
    # The ceiling stops placement only when there is nowhere left, not when the
    # nearest is full.
    decision = choose_site(["a", "b"], caps(site("a", 100.0), site("b", 20.0)), now=NOW)
    assert decision.site == "b"


# ── 5. the admin notification ────────────────────────────────────────────────


def test_crossing_eighty_percent_is_reported_even_though_placement_succeeds():
    decision = choose_site(["a", "b"], caps(site("a", 84.0), site("b", 10.0)), now=NOW)

    # The org goes to b; the alert is about a. Placement and notification are
    # independent outcomes of the same snapshot — which is why the policy
    # returns the alerts instead of sending them, so a failing mailer can never
    # delay the signup that observed the problem.
    assert decision.site == "b"
    assert [c.site for c in decision.alerts] == ["a"]
    assert decision.alerts[0].pct == 84.0


def test_a_healthy_deployment_raises_no_alerts():
    decision = choose_site(["a", "b"], caps(site("a", 10.0), site("b", 20.0)), now=NOW)
    assert decision.alerts == ()


# ── freshness ────────────────────────────────────────────────────────────────


def test_a_site_that_stopped_reporting_is_not_a_destination():
    # A stale "5% full" is exactly how a stream of new organisations gets routed
    # into a site that died an hour ago.
    decision = choose_site(
        ["a", "b"],
        caps(site("a", 5.0, age=timedelta(hours=2)), site("b", 40.0)),
        now=NOW,
        max_report_age=timedelta(minutes=15),
    )
    assert decision.site == "b"


def test_no_fresh_reports_at_all_fails_closed_rather_than_guessing():
    # Placing blind would defeat the ceiling, which exists because "we'll notice
    # when it fills up" does not work. Distinguished from a real ceiling breach
    # so the page says which of the two happened.
    decision = choose_site(
        ["a"], caps(site("a", 5.0, age=timedelta(days=1))), now=NOW, max_report_age=timedelta(minutes=15)
    )
    assert decision.site is None
    assert decision.reason == REASON_UNKNOWN_CAPACITY


def test_an_empty_deployment_fails_closed():
    assert choose_site(["a"], {}, now=NOW).reason == REASON_UNKNOWN_CAPACITY


def test_a_candidate_with_no_capacity_row_is_skipped_not_assumed_empty():
    decision = choose_site(["ghost", "b"], caps(site("b", 30.0)), now=NOW)
    assert decision.site == "b"
