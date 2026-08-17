"""Who is actually calling us.

── The bug this module exists to remove ─────────────────────────────────────
Every per-IP control in this service used `slowapi.util.get_remote_address`,
which returns `request.client.host`. Behind a reverse proxy that is the PROXY's
address, not the caller's — and uvicorn only rewrites it when the immediate peer
is in `--forwarded-allow-ips`, which defaults to `127.0.0.1`. Caddy runs in its
own container and reaches us over the bridge network, so it was never trusted
and `request.client.host` was Caddy's address on EVERY request in the world.

That collapsed every per-IP bucket into a single global one: the 600/minute
default below was enforced as 600/minute for the entire platform, not per caller.

── The trust model, stated ──────────────────────────────────────────────────
`X-Forwarded-For` is a list a CLIENT may pre-populate, and each proxy APPENDS
the peer it actually observed. So the leftmost entry is whatever the client
claimed and only the RIGHTMOST was seen by our own edge. Reading the leftmost
is what makes a limiter trivially bypassable — a fresh spoofed value per request
lands every request in a fresh bucket.

We therefore skip `TRUSTED_PROXY_HOPS` entries from the RIGHT (default 1: the
Caddy edge, which is the only thing that can reach these services — they publish
no ports). This is deliberately identical to the Go services' `clientIP`
(messaging-svc/internal/middleware/ratelimit.go) and to auth-svc/app/net.py, so
the platform has one rule rather than several.

If a second trusted proxy is ever put in front, raise TRUSTED_PROXY_HOPS to
match. Setting it too HIGH is the dangerous direction: it starts believing
client-supplied entries.
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
    entries than the configured hop count — the correct answer for a direct call
    (tests, in-cluster probes) and the fail-safe direction: an unexpected shape
    narrows the bucket to the peer rather than widening it to a caller's choice.
    """
    hops = getattr(settings, "trusted_proxy_hops", 1)
    if hops > 0:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            parts = [p.strip() for p in xff.split(",") if p.strip()]
            if len(parts) >= hops:
                candidate = parts[-hops]
                if candidate:
                    return candidate
    return _peer_ip(request)


def rate_limit_key(request: Request) -> str:
    """slowapi bucket key: the verified user when we have one, else the caller IP.

    `request.state.principal` is set by PrincipalMiddleware, which verifies the
    bearer token BEFORE the limiter runs. That ordering is the whole point: this
    used to read a `request.state.principal` that nothing ever assigned (the auth
    dependency takes only a Header and runs long after middleware), so the
    `user:` branch was unreachable and authenticated traffic bucketed by IP too.
    """
    principal = getattr(request.state, "principal", None)
    user_id = getattr(principal, "user_id", None) if principal is not None else None
    if user_id:
        return f"user:{user_id}"
    return f"ip:{client_ip(request)}"
