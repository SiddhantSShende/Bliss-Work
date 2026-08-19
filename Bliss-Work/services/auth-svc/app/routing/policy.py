"""Where a new organisation's data lives — the placement decision, as pure logic.

Org data is NOT replicated across sites: every org has exactly one home site and
stays there. So this function runs once per organisation, at signup, and the
answer is permanent. There is no rebalancing to fix a bad choice later, which is
why the policy is here as a pure function over a capacity snapshot rather than
spread through the signup transaction — it is the piece worth being able to
reason about, and to test, on its own.

── The cascade ───────────────────────────────────────────────────────────────

    1. score each site: storage used as a percentage of ITS OWN ceiling
    2. walk the candidates nearest-first
    3. take the first one under WARN_PCT (80%)
    4. if every site is at or over 80%, take the globally least-filled one,
       distance be damned — a slow org beats no org
    5. unless even that one is at its HARD ceiling, in which case place nothing
       and say so: that is a provisioning event, not a routing decision

Step 4 is the one that needs stating out loud. A signup is never failed because
the nearest sites are busy; latency is a degradation, and refusing to create the
account is an outage. Step 5 is the exception, and it is not a capacity opinion —
it is "there is no disk", which no routing decision can solve.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Mapping, Sequence

# The percentage at which a site stops being a preferred destination and starts
# being an alert. One number, used for both, deliberately: the moment we begin
# routing around a site is exactly the moment someone should be told about it.
WARN_PCT = 80.0


@dataclass(frozen=True)
class SiteCapacity:
    """One site's storage position, as last reported by that site.

    Replicated to every site through the same event bus as everything else, so
    this is always a LOCAL read — see the non-goal about cross-site queries on a
    hot path. It is therefore eventually consistent by construction, and
    `reported_at` is what keeps a dead site's last cheerful number from being
    treated as current.
    """

    site: str
    used_bytes: int
    ceiling_bytes: int
    reported_at: datetime

    @property
    def pct(self) -> float:
        """Fill percentage against this site's own ceiling.

        A missing or nonsensical ceiling reads as FULL rather than empty. The
        alternative — dividing by zero, or treating "unknown" as "plenty of
        room" — sends every new organisation to the one site nobody has
        configured properly.
        """
        if self.ceiling_bytes <= 0:
            return 100.0
        return (self.used_bytes / self.ceiling_bytes) * 100.0

    @property
    def at_ceiling(self) -> bool:
        """At or past the hard ceiling: no further placement, at any distance."""
        return self.ceiling_bytes <= 0 or self.used_bytes >= self.ceiling_bytes

    def is_fresh(self, now: datetime, max_age: timedelta) -> bool:
        return (now - self.reported_at) <= max_age


# Why a placement was made, carried through to the logs and the audit trail. The
# distinction matters months later: an org on a distant site is a question
# ("why is this one slow?") whose answer is here.
REASON_NEAREST = "nearest"          # first choice had room
REASON_CASCADE = "cascade"          # nearer sites were busy; took the next one
REASON_LEAST_FILLED = "least-filled"  # everything was busy; took the emptiest
REASON_NO_CAPACITY = "no-capacity"    # nowhere to put it — page ops
REASON_UNKNOWN_CAPACITY = "capacity-unknown"  # no fresh reports to reason from


@dataclass(frozen=True)
class Placement:
    """The decision, plus everything the caller has to do about it.

    `alerts` is separate from `site` on purpose. Notifying an admin that a site
    crossed 80% is not part of placing an org, must not run inside the placement
    transaction, and must never be able to delay or fail a signup — so the
    policy names who should be told and the caller dispatches it afterwards, out
    of band.
    """

    site: str | None
    reason: str
    alerts: tuple[SiteCapacity, ...] = ()

    @property
    def placed(self) -> bool:
        return self.site is not None


def choose_site(
    candidates: Sequence[str],
    capacity: Mapping[str, SiteCapacity],
    *,
    now: datetime,
    max_report_age: timedelta = timedelta(minutes=15),
    warn_pct: float = WARN_PCT,
) -> Placement:
    """Pick a home site, or refuse.

    `candidates` is nearest-first for the signing-up user; `capacity` is every
    site the deployment knows about, including ones not in `candidates` — the
    least-filled fallback is explicitly allowed to leave the candidate list.

    Sites whose last report is older than `max_report_age` are treated as
    UNKNOWN rather than as their last value. A site that has stopped reporting
    has usually stopped doing other things too, and sending it a stream of new
    organisations on the strength of a stale "40% full" is worse than routing
    around it.
    """
    fresh = {
        site: cap for site, cap in capacity.items() if cap.is_fresh(now, max_report_age)
    }
    # Everyone who is over the line gets an alert, whether or not they end up
    # being chosen — including a site that is over 80% and still gets the org
    # because it was the emptiest one left.
    alerts = tuple(
        sorted((c for c in fresh.values() if c.pct >= warn_pct), key=lambda c: -c.pct)
    )

    if not fresh:
        # Nothing to reason from. Placing blind would defeat the hard ceiling,
        # which exists precisely because "we'll notice when it fills up" does not
        # work — so this fails closed and pages, like a ceiling breach.
        #
        # It should be unreachable in a healthy deployment: a site reports its
        # own capacity at startup, so its own row is present within seconds of
        # boot. Reaching it means capacity replication is broken, which is worth
        # a page on its own.
        return Placement(None, REASON_UNKNOWN_CAPACITY, alerts)

    for index, site in enumerate(candidates):
        cap = fresh.get(site)
        if cap is None or cap.pct >= warn_pct:
            continue
        return Placement(site, REASON_NEAREST if index == 0 else REASON_CASCADE, alerts)

    # Every candidate is busy (or unknown). Widen to the whole deployment and
    # take the emptiest site there is — distance is a latency cost, and a slow
    # org beats a failed signup.
    emptiest = min(fresh.values(), key=lambda c: (c.pct, c.site))
    if emptiest.at_ceiling:
        # Not a routing decision any more. Somebody has to add storage.
        return Placement(None, REASON_NO_CAPACITY, alerts)
    return Placement(emptiest.site, REASON_LEAST_FILLED, alerts)
