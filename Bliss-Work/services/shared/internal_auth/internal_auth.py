"""Constant-time internal-service-secret comparison, shared across this repo's
Python services.

Why this exists
----------------
Every service that exposes an ``/internal/*`` route used to check the caller's
``X-Internal-Token`` header against a SINGLE shared secret
(``TB_INTERNAL_TOKEN``), identical across every service and every caller. Any
one compromised service — or the deployment env file itself — handed an
attacker the same credential every other internal endpoint on the platform
also trusted. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 2.

Each service now validates against its OWN secret (``AUTH_INTERNAL_TOKEN``,
``TASK_INTERNAL_TOKEN``, etc. — one env var per service that exposes an
``/internal/*`` route), and each caller is configured with only the secrets of
the services it actually calls. What stays identical across services is the
comparison itself: constant-time, and fail-CLOSED when the expected secret is
unconfigured (an empty expected value must never mean "accept anything").

The Go services carry the same contract in ``services/shared/internalauth``;
this package is deliberately status-code-agnostic (it returns a bool rather
than raising an HTTPException) so each caller keeps its own existing choice of
401 vs. 403 and its own error body shape — the shared behavior is only the
comparison, not the HTTP response.
"""

from __future__ import annotations

import secrets


def internal_token_matches(provided: str | None, expected: str) -> bool:
    """Constant-time equality check for a service-to-service shared secret.

    Fails CLOSED: an unconfigured `expected` (empty string) always returns
    False — never "any caller is accepted" — and a missing/empty `provided`
    is likewise rejected before the comparison, so the compare_digest call
    only ever runs on two non-empty values.
    """
    if not expected or not provided:
        return False
    return secrets.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))
