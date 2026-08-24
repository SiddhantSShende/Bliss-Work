"""Turning a routing decision into an HTTP answer — the one shared helper.

Both callers use this: an org-scoped request that reached the wrong site, and an
invite redemption that had only a token hash to go on. They were separate once
and the invite path was the one that answered 404 for a key that simply had not
replicated yet, which is why there is now exactly one place that decides what a
non-local key looks like on the wire.

── The three non-local answers ──────────────────────────────────────────────

  307  the key lives elsewhere. A TEMPORARY redirect that PRESERVES THE METHOD
       AND BODY — a 301/302 turns a POST into a GET at the far site, which for
       an invite redemption means the password never arrives. 307 is the only
       correct code here.
  503  we have never heard of this key. Retryable, with Retry-After, because the
       directory is replicated asynchronously and "a moment ago" is the most
       likely reason a key is missing.
  410  the key existed and no longer applies (an expired or revoked invite).
       Gone is gone at every site, so this is answered locally rather than
       redirected — bouncing someone across the world to be told no is a slower
       way to say the same thing.
"""
from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException, status
from fastapi.responses import RedirectResponse
from starlette.requests import Request

from .decision import Route, RouteDecision

# How long a caller should wait before retrying a key we do not have yet. Short:
# the bridge replicates in well under a second in a healthy deployment, and a
# long wait would make a first-click invite feel broken.
RETRY_AFTER_SECONDS = 2


class SiteEndpoints:
    """site name → public base URL. Deployment configuration, not discovery.

    Explicit rather than resolved from the directory, because a redirect sends a
    USER's browser somewhere: the address has to be the public, TLS-terminated
    one for that site, which is not something a peer's internal event should be
    able to choose. A site we have no endpoint for is a configuration error, and
    a loud one — see `enforce`.
    """

    def __init__(self, mapping: dict[str, str]) -> None:
        self._by_site = {k: v.rstrip("/") for k, v in mapping.items() if k and v}

    def url_for(self, site: str) -> str | None:
        return self._by_site.get(site)

    def __contains__(self, site: str) -> bool:
        return site in self._by_site

    def __len__(self) -> int:
        return len(self._by_site)


def redirect_target(base_url: str, request_url: str) -> str:
    """Rebuild this request's URL against another site's base.

    Path and query are carried over verbatim; scheme and host come from the
    CONFIGURED endpoint. Nothing from the incoming Host header is trusted — that
    is attacker-controlled, and a redirect built from it is an open redirect
    wearing a routing decision's clothes.
    """
    base = urlsplit(base_url)
    here = urlsplit(request_url)
    path = base.path.rstrip("/") + here.path
    return urlunsplit((base.scheme, base.netloc, path, here.query, ""))


def enforce(
    decision: RouteDecision,
    request: Request,
    endpoints: SiteEndpoints,
    *,
    key_kind: str = "resource",
) -> RedirectResponse | None:
    """Return the response the caller should send, or None to carry on locally.

    Raising for the error cases and RETURNING for the redirect is deliberate: a
    redirect is a normal outcome a route function returns, while a missing or
    expired key is an error every caller handles identically.
    """
    if decision.route is Route.LOCAL:
        return None

    if decision.route is Route.RETRY:
        # Not a 404. The key may exist perfectly well at another site and simply
        # not have reached us yet — see the module docstring.
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{key_kind} is not available at this site yet — retry shortly",
            headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
        )

    if decision.route is Route.GONE:
        raise HTTPException(status.HTTP_410_GONE, detail=f"{key_kind} is no longer valid")

    target_base = endpoints.url_for(decision.home_site or "")
    if target_base is None:
        # We know where it lives and cannot say where that is. Refusing beats
        # guessing: the alternative is a redirect to a host derived from
        # something a peer sent us.
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{key_kind} lives at another site, which is not reachable from here",
            headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
        )

    return RedirectResponse(
        url=redirect_target(target_base, str(request.url)),
        # 307: preserves method and body. A 302 here would silently turn an
        # invite redemption's POST into a GET at the far site.
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
    )
