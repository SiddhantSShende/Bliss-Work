"""Who is actually calling us — shared across this repo's Python services.

── The bug this module exists to remove ─────────────────────────────────────
Every per-IP control in these services used `slowapi.util.get_remote_address`,
which returns `request.client.host`. Behind a reverse proxy that is the PROXY's
address, not the caller's — and uvicorn only rewrites it when the immediate peer
is in `--forwarded-allow-ips`, which defaults to `127.0.0.1`. Caddy runs in its
own container and reaches these services over the bridge network, so it was
never trusted and `request.client.host` was Caddy's address on EVERY request.

The consequence was not a slightly-wrong metric. It collapsed every per-IP
bucket into a single global one — a limit configured as N/minute per IP was
enforced as N/minute for the entire platform. Because the limiter is often
Redis-backed, adding replicas made it worse rather than better: they all drew
from the one bucket.

── The trust model, stated ──────────────────────────────────────────────────
`X-Forwarded-For` is a list a CLIENT may pre-populate, and each proxy APPENDS
the peer it actually observed. So the leftmost entry is whatever the client
claimed and only the RIGHTMOST was seen by our own edge. Reading the leftmost
is what makes a limiter trivially bypassable — a fresh spoofed value per request
lands every request in a fresh bucket.

We therefore skip `hops` entries from the RIGHT (each service's own
TRUSTED_PROXY_HOPS setting, default 1: the Caddy edge, which is the only thing
that can reach these services — they publish no ports). This is deliberately
identical to the Go services' `clientIP`
(messaging-svc/internal/middleware/ratelimit.go), so the platform has one rule
rather than several.

If a second trusted proxy is ever put in front (a cloud load balancer ahead of
Caddy), the calling service should raise its TRUSTED_PROXY_HOPS to match.
Setting it too HIGH is the dangerous direction: it starts believing
client-supplied entries.

── Why `hops` is a parameter, not read from settings here ───────────────────
This module has no per-service config dependency, matching the convention in
services/shared/internal_auth: each caller passes its own configured value in,
so this package never needs to know a given service's settings shape.
"""
from __future__ import annotations

from starlette.requests import Request


def _peer_ip(request: Request) -> str:
    """The immediate peer, with no header interpretation at all."""
    client = request.client
    if client is None or not client.host:
        return "unknown"
    return client.host


def client_ip(request: Request, hops: int) -> str:
    """The caller's address, as observed by our own edge.

    Falls back to the immediate peer whenever the header is absent or has fewer
    entries than the configured hop count — which is the correct answer for a
    direct call (tests, in-cluster probes, a misrouted request) and is also the
    fail-safe direction: an unexpected shape narrows the bucket to the peer
    rather than widening it to something a caller chose.
    """
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


def rate_limit_key(request: Request, hops: int) -> str:
    """slowapi bucket key: the verified user when we have one, else the caller IP.

    `request.state.principal` is expected to be set by each service's own
    principal-resolving middleware, which verifies the bearer token BEFORE the
    limiter runs — keying by verified user rather than by IP matters for
    correctness in both directions: a shared office NAT is one IP for hundreds
    of people, and one person on a phone changes IP without changing their
    allowance.
    """
    principal = getattr(request.state, "principal", None)
    user_id = getattr(principal, "user_id", None) if principal is not None else None
    if user_id:
        return f"user:{user_id}"
    return f"ip:{client_ip(request, hops)}"
