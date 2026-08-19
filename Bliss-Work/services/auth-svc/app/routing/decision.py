"""What to do with a request whose data may live at another site — pure logic.

ONE decision function for both cases the deployment has:

  * an org-scoped request that reached the wrong site
  * an invite redemption, which is looked up by token hash alone and therefore
    cannot know its org — or its site — until the directory answers

They are the same question ("where does this key live?") and they were the same
bug twice when they were two code paths, so they are one function here and one
helper (routing/redirect.py) at the HTTP layer.

── Why "not found" is a retry and not a 404 ─────────────────────────────────

The directory is replicated through the region bridge, which is asynchronous.
An org created a moment ago at another site, or an invite minted seconds before
the link was clicked, may genuinely not be here yet. Answering 404 turns a
hundred milliseconds of replication lag into "your invite link is invalid",
which the user cannot distinguish from a real expiry and will not retry.

So an absent key is TEMPORARY by default. The cost of being wrong in this
direction is a client retrying a request that will keep failing; the cost of
being wrong in the other is telling someone their account does not exist.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum


class Route(Enum):
    """What the caller should do with the request."""

    LOCAL = "local"        # this site owns the data: carry on
    REDIRECT = "redirect"  # another site owns it: send the caller there
    RETRY = "retry"        # not replicated here yet: short-lived, retryable
    GONE = "gone"          # the key existed and no longer applies (expired/revoked)


@dataclass(frozen=True)
class DirectoryEntry:
    """One row of the local routing directory."""

    key_type: str          # "org" | "invite"
    key_value: str         # org id, or an invite's token hash
    home_site: str
    expires_at: datetime | None = None   # invites only; orgs never expire
    revoked_at: datetime | None = None   # invites only; orgs are never revoked


@dataclass(frozen=True)
class RouteDecision:
    route: Route
    home_site: str | None = None
    reason: str = ""

    @property
    def is_local(self) -> bool:
        return self.route is Route.LOCAL


def route_for(
    entry: DirectoryEntry | None,
    local_site: str,
    *,
    now: datetime,
) -> RouteDecision:
    """Decide where a keyed request belongs.

    Order is load-bearing:

      absent   → RETRY, before anything else. We know nothing about this key,
                 including whether it is expired, so the honest answer is "ask
                 again shortly".
      expired  → GONE, BEFORE the local/remote split. An expired invite is
                 expired at every site, and bouncing the user across the world
                 to be told so is a slower way to say the same thing.
      local    → LOCAL.
      anything else → REDIRECT.
    """
    if entry is None:
        return RouteDecision(Route.RETRY, None, "not replicated to this site yet")

    if entry.revoked_at is not None:
        return RouteDecision(Route.GONE, entry.home_site, "revoked")
    if entry.expires_at is not None and entry.expires_at <= now:
        return RouteDecision(Route.GONE, entry.home_site, "expired")

    if entry.home_site == local_site:
        return RouteDecision(Route.LOCAL, entry.home_site, "home site")
    return RouteDecision(Route.REDIRECT, entry.home_site, f"home site is {entry.home_site}")
