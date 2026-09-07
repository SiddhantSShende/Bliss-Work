"""The unified activity detail contract. Mirrors packages/shared/src/types/activity.ts.

Not a new activity model — see that file's docstring for the full reasoning.
`ActivityRow.detail` (ingest.py) and `BeaconEvent.detail` (schemas.py) are
already a free-form, encrypted, per-org `dict[str, str]` that the timeline
handler decrypts and returns unchanged. This module only names the keys a
producer SHOULD use for page/window titles, the domain, and the "switched
from" reading — so every producer spells the same concept the same way. No
schema change; every key stays optional, and a row written before this
contract existed simply has none of them.
"""
from __future__ import annotations

# Keys formalized for TimelineEntry / BeaconEvent `detail`. Kept as plain
# string constants, not an enum or a TypedDict: `detail` is validated
# server-side as an untyped `dict[str, str]`, and a TypedDict here would claim
# a runtime guarantee this module does not enforce. The value is a single
# place every route/producer imports the spelling from, rather than several
# copies of the same string.
DETAIL_TITLE = "title"      # page title (browser) or window title (desktop)
DETAIL_DOMAIN = "domain"    # registrable domain, mirrored alongside targetId
DETAIL_FROM = "from"        # already in production use — see activityLabels.ts
