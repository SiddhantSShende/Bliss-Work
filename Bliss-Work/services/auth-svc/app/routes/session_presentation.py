"""Turn a refresh-token family into what "Active sessions" shows a human.

Shared by routes/sessions.py (self-service) and routes/members.py (admin
viewing a member's sessions) so the two surfaces render sessions identically
rather than drifting into two slightly different device-label/IP-masking
implementations.
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

# Ordered longest-first so a fork isn't mis-labelled by a shorter substring
# match (e.g. Edge's UA also contains "Chrome/"). Intentionally the same
# coarse, non-identifying vocabulary as telemetry-svc's device_label
# (services/telemetry-svc/app/sessions.py) — duplicated rather than imported
# because there is no shared Python package between these services (see that
# file's own docstring, and task-svc/app/middleware.py's note on why auth
# services are duplicated per service for independent deployability). Kept
# deliberately tiny so the duplication costs little to keep in sync.
_BROWSERS = (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
             ("Chrome/", "Chrome"), ("Safari/", "Safari"))
# iPhone/iPad MUST be checked before Macintosh/"Mac OS X": iOS Safari's own UA
# literally contains the substring "like Mac OS X" (e.g. "CPU iPhone OS 17_4
# like Mac OS X"), so a naive first-match-wins scan in the other order reports
# every iPhone as a Mac. Caught by tests/test_session_presentation.py; the
# telemetry-svc source this was ported from (services/telemetry-svc/app/
# sessions.py) has the same ordering bug — not fixed there as part of this
# change since that service is out of scope here.
_PLATFORMS = (("iPhone", "iOS"), ("iPad", "iPadOS"), ("Windows", "Windows"),
              ("Macintosh", "macOS"), ("Mac OS X", "macOS"), ("Android", "Android"),
              ("Linux", "Linux"))


def device_label(user_agent: str | None) -> str:
    """A short, non-identifying description, e.g. "Chrome · Windows" — never
    the raw user agent, which is a fingerprint and is not returned by this API."""
    if not user_agent:
        return "Unknown device"
    if "Electron" in user_agent or "taskboard-desktop" in user_agent:
        base = "BlissWork Desktop"
    else:
        base = next((name for token, name in _BROWSERS if token in user_agent), "Browser")
    platform = next((name for token, name in _PLATFORMS if token in user_agent), None)
    return f"{base} · {platform}" if platform else base


def ip_prefix(ip: str | None) -> str | None:
    """Coarsen to a /24 (v4) or /48 (v6) — enough to notice a sign-in from
    somewhere new, not enough to identify a household. Mirrors
    telemetry-svc's ip_prefix (see _BROWSERS docstring above)."""
    if not ip:
        return None
    if ":" in ip:
        parts = [p for p in ip.split(":") if p != ""][:3]
        return ":".join(parts) + "::/48" if parts else None
    octets = ip.split(".")
    if len(octets) != 4:
        return None
    return ".".join(octets[:3]) + ".0/24"


async def session_origins(
    conn: AsyncConnection, org_id: str, family_ids: list[str]
) -> dict[str, dict]:
    """family_id -> {ip, userAgent} from the login/switch audit event that
    opened it (session_events.session_started / org_switched). At most one
    such event exists per family (build_session mints a fresh family every
    time), so this is a plain lookup, not an aggregate. A family with none —
    e.g. opened by signup, which does not call session_started — simply gets
    an empty dict and the caller falls back to "Unknown device". Uses
    migrations/0019_session_management.sql's partial index.
    """
    if not family_ids:
        return {}
    rows = (
        await conn.execute(
            text(
                """
                SELECT meta->>'sessionId' AS family_id,
                       meta->>'ip' AS ip,
                       meta->>'userAgent' AS user_agent
                FROM audit_log
                WHERE org_id = :org
                  AND action IN ('auth.login', 'auth.org_switched')
                  AND meta->>'sessionId' = ANY(:fams)
                """
            ),
            {"org": org_id, "fams": family_ids},
        )
    ).all()
    return {r.family_id: {"ip": r.ip, "userAgent": r.user_agent} for r in rows}
