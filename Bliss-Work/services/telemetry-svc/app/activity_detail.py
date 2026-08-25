"""The unified activity detail contract. Mirrors packages/shared/src/types/activity.ts.

Not a new activity model — see that file's docstring for the full reasoning.
`ActivityRow.detail` (ingest.py) and `AgentEvent`/`BeaconEvent.detail`
(schemas.py) are already a free-form, encrypted, per-org `dict[str, str]` that
four producers write to and the timeline handler decrypts and returns
unchanged. This module only names the keys a producer SHOULD use for page/
window titles, the reporting browser, the OS process name, the domain, the
full URL, and the "switched from" reading — so every producer spells the same
concept the same way. No schema change; every key stays optional, and a row
written before this contract existed simply has none of them.
"""
from __future__ import annotations

# Keys formalized for TimelineEntry / AgentEvent / BeaconEvent `detail`.
# Kept as plain string constants, not an enum or a TypedDict: `detail` is
# validated server-side as an untyped `dict[str, str]` (see AgentEvent's
# `_bound_detail`), and a TypedDict here would claim a runtime guarantee this
# module does not enforce. The value is a single place every route/producer
# imports the spelling from, rather than five copies of the same string.
DETAIL_TITLE = "title"      # page title (browser) or window title (desktop)
DETAIL_BROWSER = "browser"  # "chrome" | "edge" | "brave" | "opera" | "arc" | "firefox" | "safari"
DETAIL_PROCESS = "process"  # OS process/executable name
DETAIL_DOMAIN = "domain"    # registrable domain, mirrored alongside targetId
DETAIL_URL = "url"          # full page URL — already written by the extension
DETAIL_FROM = "from"        # already in production use — see activityLabels.ts
DETAIL_SITE_KIND = "siteKind"  # "video" | "repository" | "document" | ... — generic,
                                # not YouTube-specific; the extension point for
                                # per-site enrichment (see apps/extension/src/siteEnrichment.ts)
DETAIL_SITE_REF = "siteRef"    # the site's own id for what siteKind names —
                                # a YouTube video id, a GitHub "owner/repo", etc.

# Browsers this contract names today. Not enforced (an unrecognized value is
# still stored and still rendered — see the "wire-tolerant" comments elsewhere
# in this codebase for why a client ahead of the backend must not break), only
# documented, so the Chromium-first extension rollout has a fixed vocabulary to
# grow from without inventing a new spelling per browser.
KNOWN_BROWSERS = frozenset({"chrome", "edge", "brave", "opera", "arc", "firefox", "safari"})
