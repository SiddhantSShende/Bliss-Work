"""The authenticated front door for UI translation: `GET /i18n/languages` and
`GET /i18n/catalog`, the routes the web, Electron and mobile clients call.

This module contains NO translation logic. Everything translation-related —
the supported-language list, the English source catalogs, placeholder
protection, the cache and the Google Cloud Translation calls (authenticated by
Application Default Credentials) — lives in services/translate-gw, written in
Go. auth-svc's whole job here is the part only it can do: verify the caller's
session (`get_principal`), then forward the request to the gateway with the
shared secret `X-Internal-Token`. The gateway is never reachable from a browser
and trusts nothing but that header; auth-svc holds no Google credential.

The client sends a locale code, never text, so nothing a user wrote can be
routed through here to Google.

Degradation (the client treats both as "English only", never as a crash):
  * /i18n/languages answers 200 `{"languages": []}` when the gateway is not
    configured, down, or has no Google credentials yet;
  * /i18n/catalog answers 503 in those cases, 400 for a locale the gateway does
    not offer.
"""
from __future__ import annotations

import json
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..config import settings
from ..logging_config import log
from ..security.auth_dep import Principal, get_principal

router = APIRouter(prefix="/i18n", tags=["i18n"])

# Same shape the gateway enforces ("es", "zh-TW", "pt-BR"); checked here too so
# a malformed value never leaves auth-svc.
_LOCALE_SHAPE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$")

_LANGUAGES_TIMEOUT = 10.0
# A never-before-requested locale is built from Google in one go (a couple of
# dozen batched calls); the gateway bounds that at two minutes.
_CATALOG_TIMEOUT = 140.0

# Test seam: tests point the proxy at an in-process fake gateway.
_transport: httpx.AsyncBaseTransport | None = None


def _configured() -> bool:
    return bool(settings.translate_gw_url and settings.translate_internal_token)


async def _gateway_get(path: str, params: dict[str, str], timeout: float) -> httpx.Response | None:
    """The gateway's response, or None when it could not be reached. Logs the
    failure CLASS only: an httpx error message embeds the request URL."""
    try:
        async with httpx.AsyncClient(timeout=timeout, transport=_transport) as client:
            return await client.get(
                settings.translate_gw_url.rstrip("/") + path,
                params=params,
                headers={"X-Internal-Token": settings.translate_internal_token},
            )
    except Exception as exc:  # noqa: BLE001 - connection refused, timeout, DNS…
        log.warning("i18n_gateway_unreachable", path=path, error=type(exc).__name__)
        return None


@router.get("/languages")
async def list_languages(principal: Principal = Depends(get_principal)) -> dict:
    """The live set of languages BlissWork can translate into today, as decided
    by the gateway — never a hardcoded list. Empty (not an error) whenever the
    gateway cannot say, so the client's switcher just shows bundled English."""
    if not _configured():
        return {"languages": []}
    res = await _gateway_get("/v1/languages", {}, _LANGUAGES_TIMEOUT)
    if res is None or res.status_code != 200:
        if res is not None:
            log.warning("i18n_gateway_languages_failed", status=res.status_code)
        return {"languages": []}
    try:
        offered = res.json()["languages"]
        # Re-built field by field: the client contract is exactly {code, name}.
        return {"languages": [{"code": str(item["code"]), "name": str(item["name"])} for item in offered]}
    except (ValueError, KeyError, TypeError):
        log.warning("i18n_gateway_languages_malformed")
        return {"languages": []}


@router.get("/catalog")
async def get_catalog(locale: str, principal: Principal = Depends(get_principal)) -> Response:
    """The translated catalog for `locale`, namespace-shaped exactly like the
    English source: `{"locale", "namespaces", "partial"}`. The client feeds each
    namespace straight into i18next's `addResourceBundle`."""
    if not locale or not _LOCALE_SHAPE.match(locale):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "locale is required" if not locale else f"unsupported locale: {locale}")
    unavailable = HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "translation service is unavailable")
    if not _configured():
        raise unavailable
    res = await _gateway_get("/v1/catalog", {"locale": locale}, _CATALOG_TIMEOUT)
    if res is None:
        raise unavailable
    if res.status_code == 400:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unsupported locale: {locale}")
    if res.status_code != 200:
        log.warning("i18n_gateway_catalog_failed", status=res.status_code)
        raise unavailable
    try:
        body = res.json()
        if not (isinstance(body["locale"], str) and isinstance(body["namespaces"], dict) and isinstance(body["partial"], bool)):
            raise TypeError
    except (ValueError, KeyError, TypeError):
        log.warning("i18n_gateway_catalog_malformed")
        raise unavailable from None
    return Response(
        content=json.dumps({"locale": body["locale"], "namespaces": body["namespaces"], "partial": body["partial"]}),
        media_type="application/json",
    )
