"""Request-time routing: same site, cross-site, not-yet-replicated, expired.

One decision function serves both the org-mismatch case and invite redemption,
because they are the same question with different keys. These tests are what
stop the invite path from re-acquiring its own answer for "I have never heard of
this key", which is the bug that made a freshly-minted invite link look invalid.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.routing.decision import DirectoryEntry, Route, route_for

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
LOCAL = "site-a"


def org(home: str) -> DirectoryEntry:
    return DirectoryEntry(key_type="org", key_value="11111111-1111-4111-8111-111111111111", home_site=home)


def invite(home: str, *, expires_in: timedelta = timedelta(hours=72), revoked: bool = False) -> DirectoryEntry:
    return DirectoryEntry(
        key_type="invite",
        key_value="deadbeef",
        home_site=home,
        expires_at=NOW + expires_in,
        revoked_at=NOW - timedelta(minutes=1) if revoked else None,
    )


# ── 6. same-site request ─────────────────────────────────────────────────────


def test_a_key_that_lives_here_is_served_here():
    assert route_for(org(LOCAL), LOCAL, now=NOW).route is Route.LOCAL
    assert route_for(invite(LOCAL), LOCAL, now=NOW).route is Route.LOCAL


def test_the_local_decision_carries_no_redirect():
    decision = route_for(org(LOCAL), LOCAL, now=NOW)
    assert decision.is_local
    assert decision.home_site == LOCAL


# ── 7. cross-site redirect ───────────────────────────────────────────────────


def test_a_key_that_lives_elsewhere_is_redirected_there():
    decision = route_for(org("site-b"), LOCAL, now=NOW)
    assert decision.route is Route.REDIRECT
    assert decision.home_site == "site-b"


def test_an_invite_from_another_site_redirects_rather_than_being_rejected():
    # The case that made this shared: the invite exists, it is perfectly valid,
    # and it simply belongs to an org that lives somewhere else.
    decision = route_for(invite("site-b"), LOCAL, now=NOW)
    assert decision.route is Route.REDIRECT
    assert decision.home_site == "site-b"


def test_routing_generalises_past_two_sites():
    for home in ("site-b", "site-c", "site-z"):
        assert route_for(org(home), LOCAL, now=NOW).home_site == home


# ── 8. not yet replicated ────────────────────────────────────────────────────


def test_an_unknown_key_is_retryable_and_never_a_404():
    # The directory replicates asynchronously. An org created a moment ago at
    # another site, or an invite minted seconds before the link was clicked, is
    # legitimately absent here — and answering "invalid" turns 100ms of lag into
    # a support ticket the user cannot distinguish from a real expiry.
    decision = route_for(None, LOCAL, now=NOW)
    assert decision.route is Route.RETRY
    assert decision.home_site is None
    assert "replicat" in decision.reason


# ── 9. expired invite ────────────────────────────────────────────────────────


def test_an_expired_invite_is_gone():
    decision = route_for(invite(LOCAL, expires_in=timedelta(seconds=-1)), LOCAL, now=NOW)
    assert decision.route is Route.GONE
    assert decision.reason == "expired"


def test_expiry_is_decided_here_rather_than_at_the_home_site():
    # An expired invite is expired everywhere, so a remote one is answered
    # locally: bouncing the user across the world to be told no is a slower way
    # to say the same thing.
    decision = route_for(invite("site-b", expires_in=timedelta(seconds=-1)), LOCAL, now=NOW)
    assert decision.route is Route.GONE


def test_expiry_is_inclusive_at_the_boundary():
    assert route_for(invite(LOCAL, expires_in=timedelta(0)), LOCAL, now=NOW).route is Route.GONE


def test_a_revoked_invite_is_gone_even_before_it_expires():
    decision = route_for(invite(LOCAL, revoked=True), LOCAL, now=NOW)
    assert decision.route is Route.GONE
    assert decision.reason == "revoked"


def test_an_org_is_never_expired_or_revoked():
    # Orgs have no TTL and no second home; the columns are nullable for invites
    # alone, and an org row must never take either branch.
    entry = org(LOCAL)
    assert entry.expires_at is None and entry.revoked_at is None
    assert route_for(entry, LOCAL, now=NOW + timedelta(days=3650)).route is Route.LOCAL


def test_absence_is_checked_before_expiry():
    # We know nothing about an absent key — including whether it is expired — so
    # the honest answer is "ask again", not "gone".
    assert route_for(None, LOCAL, now=NOW).route is Route.RETRY
