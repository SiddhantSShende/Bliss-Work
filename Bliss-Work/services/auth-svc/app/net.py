"""Who is actually calling us.

The identity algorithm — reading X-Forwarded-For from the right, falling back
to the immediate peer, keying by verified user over IP — now lives in
services/shared/client_ip/client_ip.py, shared with task-svc, integrations-svc
and telemetry-svc; see that module's docstring for the full trust-model
rationale (the bug it fixed, why the rightmost entry and not the leftmost).

This file stays as auth-svc's own thin adapter for two reasons: `settings`
here is auth-svc's own config (the shared module takes `hops` as a plain
parameter rather than importing any service's settings), and `request_context`
below is specific to this service's audit logging.
"""
from __future__ import annotations

from starlette.requests import Request

from client_ip import client_ip as _client_ip
from client_ip import rate_limit_key as _rate_limit_key

from .config import settings


def client_ip(request: Request) -> str:
    return _client_ip(request, settings.trusted_proxy_hops)


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
    return _rate_limit_key(request, settings.trusted_proxy_hops)
