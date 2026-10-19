"""A tiny, dependency-free home for timestamp formatting shared across routes.

`iso_z` used to live in `routes/invites_service.py`, which every one of its
callers (members.py, invites.py, members_service.py, sessions.py,
account_service.py, org_lifecycle.py) imported from directly. That made
`invites_service` a hub every other route module had to import through, and
account_service.py -> mfa_service.py -> invites_service.py closed into a
circular import the moment invites_service also needed something from
account_service.py. Living here instead — below every route module, with no
imports of its own from the package — breaks that cycle for good.
"""
from __future__ import annotations

from datetime import datetime, timezone


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
