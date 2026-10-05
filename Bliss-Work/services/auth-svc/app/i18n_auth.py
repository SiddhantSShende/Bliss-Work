"""How auth-svc authenticates to Google Cloud Translation. Server-side only.

Three ways, checked in this order — the first that is configured wins:

  1. GOOGLE_APPLICATION_CREDENTIALS — path to a service-account JSON file
     (mounted read-only, e.g. under /keys). Preferred for a self-hosted box.
  2. GOOGLE_TRANSLATE_USE_ADC=true — Application Default Credentials with no
     file: the attached service account on GCE/GKE/Cloud Run, workload
     identity, or `gcloud auth application-default login` on a dev laptop.
  3. GOOGLE_TRANSLATE_API_KEY — the original, simplest option.

1 and 2 produce a short-lived OAuth2 bearer token that google-auth refreshes
itself; Cloud Translation Basic (v2) accepts it exactly like a key. The token
and the key only ever go in a request header — never a URL, never a log line.
`gcloud auth application-default print-access-token` output is a ~1h token and
must not be pasted into an env file; that is what this module's refresh is for.
"""
from __future__ import annotations

import asyncio
from typing import Any

from .config import settings
from .logging_config import log

_SCOPE = "https://www.googleapis.com/auth/cloud-translation"

_credentials: Any = None
_credentials_lock = asyncio.Lock()


class TranslationAuthError(Exception):
    """Credentials are configured but unusable (missing file, revoked, Google's
    token endpoint down). Message never contains key or token material."""


def _uses_adc() -> bool:
    return bool(settings.google_application_credentials or settings.google_translate_use_adc)


def is_configured() -> bool:
    return _uses_adc() or bool(settings.google_translate_api_key)


def _load_credentials() -> Any:
    # Imported here so the API-key-only path (and the unit tests) never need
    # google-auth importable.
    if settings.google_application_credentials:
        from google.oauth2 import service_account

        return service_account.Credentials.from_service_account_file(
            settings.google_application_credentials, scopes=[_SCOPE]
        )
    import google.auth

    creds, _project = google.auth.default(scopes=[_SCOPE])
    return creds


def _refresh(creds: Any) -> None:
    from google.auth.transport.requests import Request

    creds.refresh(Request())


async def auth_headers() -> dict[str, str]:
    """Headers to put on a Google Translation request. Raises
    TranslationAuthError when credentials are configured but cannot be used."""
    global _credentials
    if not _uses_adc():
        return {"x-goog-api-key": settings.google_translate_api_key}
    try:
        async with _credentials_lock:
            if _credentials is None:
                _credentials = await asyncio.to_thread(_load_credentials)
            if not _credentials.valid:
                await asyncio.to_thread(_refresh, _credentials)
            return {"authorization": f"Bearer {_credentials.token}"}
    except Exception as exc:  # noqa: BLE001 - google-auth raises many types
        _credentials = None  # retry from scratch next call (rotated key file, etc.)
        # Class name only: a message can echo a file path or a token endpoint body.
        log.warning("i18n_google_auth_failed", error=type(exc).__name__)
        raise TranslationAuthError(type(exc).__name__) from None
