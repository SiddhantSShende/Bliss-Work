"""Who is actually calling us.

── The bug this module exists to remove ─────────────────────────────────────
Every per-IP control in this service used `slowapi.util.get_remote_address`,
which returns `request.client.host`. Behind a reverse proxy that is the PROXY's
address, not the caller's — and uvicorn only rewrites it when the immediate peer
is in `--forwarded-allow-ips`, which defaults to `127.0.0.1`. Caddy runs in its
own container and reaches us over the bridge network, so it was never trusted
and `request.client.host` was Caddy's address on EVERY request in the world.

The consequence was not a slightly-wrong metric. It collapsed every per-IP
bucket into a single global one: `POST /auth/login` was configured at 10/min per
IP and enforced at 10/min for the entire platform, `/auth/refresh` at 30/min for
the entire platform, and the 120/min slowapi default at 120/min for the entire
platform. Because the sensitive limiter is Redis-backed, adding replicas made it
worse rather than better — they all drew from the one bucket.

── The trust model, stated ──────────────────────────────────────────────────
`X-Forwarded-For` is a list a CLIENT may pre-populate, and each proxy APPENDS
the peer it actually observed. So the leftmost entry is whatever the client
claimed and only the RIGHTMOST was seen by our own edge. Reading the leftmost
is what makes a limiter trivially bypassable — a fresh spoofed value per request
lands every request in a fresh bucket.

We therefore skip `TRUSTED_PROXY_HOPS` entries from the RIGHT (default 1: the
Caddy edge, which is the only thing that can reach these services — they publish
no ports). This is deliberately identical to the Go services' `clientIP`
(messaging-svc/internal/middleware/ratelimit.go), so the platform has one rule
rather than two.

If a second trusted proxy is ever put in front (a cloud load balancer ahead of
Caddy), raise TRUSTED_PROXY_HOPS to match. Setting it too HIGH is the dangerous
direction: it starts believing client-supplied entries.
"""
from __future__ import annotations

from starlette.requests import Request

from .config import settings


def _peer_ip(request: Request) -> str:
    """The immediate peer, with no header interpretation at all."""
    client = request.client
    if client is None or not client.host:
        return "unknown"
    return client.host


def client_ip(request: Request) -> str:
    """The caller's address, as observed by our own edge.

    Falls back to the immediate peer whenever the header is absent or has fewer
    entries than the configured hop count — which is the correct answer for a
    direct call (tests, in-cluster probes, a misrouted request) and is also the
    fail-safe direction: an unexpected shape narrows the bucket to the peer
    rather than widening it to something a caller chose.
    """
    hops = settings.trusted_proxy_hops
    if hops > 0:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            parts = [p.strip() for p in xff.split(",") if p.strip()]
            # Index from the right: hops=1 -> parts[-1], the address our edge saw.
            if len(parts) >= hops:
                candidate = parts[-hops]
                if candidate:
                    return candidate
    return _peer_ip(request)


def request_context(request: Request) -> tuple[str, str | None, str | None]:
    """(ip, user_agent, request_id), for audit-log enrichment — see
    docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 9. `ip` reuses `client_ip`
    above so the audited address is exactly the one rate limiting already
    trusts, never a second IP-extraction path. `request_id` reads the same
    `X-Request-Id` header `rate_limit.py`'s handler already reads."""
    return (
        client_ip(request),
        request.headers.get("user-agent"),
        request.headers.get("x-request-id"),
    )


def rate_limit_key(request: Request) -> str:
    """slowapi bucket key: the verified user when we have one, else the caller IP.

    `request.state.principal` is set by PrincipalMiddleware, which verifies the
    bearer token BEFORE the limiter runs. That ordering is the whole point: this
    used to read a `request.state.principal` that nothing ever assigned (the auth
    dependency takes only a Header and runs long after middleware), so the
    `user:` branch was unreachable and authenticated traffic bucketed by IP too.

    Keying by verified user rather than by IP matters for correctness in both
    directions: a shared office NAT is one IP for hundreds of people, and one
    person on a phone changes IP without changing their allowance.
    """
    principal = getattr(request.state, "principal", None)
    user_id = getattr(principal, "user_id", None) if principal is not None else None
    if user_id:
        return f"user:{user_id}"
    return f"ip:{client_ip(request)}"
