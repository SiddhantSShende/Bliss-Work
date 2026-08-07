"""WhatsApp (Meta Cloud API) adapter — the sanctioned Business relay.

Connect is token-paste: a system-user access token + a phone_number_id (the
business number) + the app secret (for webhook signatures). Because every message
transits the business number, Bliss-Work owns the graph — inbound arrivals, our
outbound sends, and forwards done through the app are all trackable.

Inbound webhooks are authenticated by Meta's `X-Hub-Signature-256` = HMAC-SHA256
over the raw body with the app secret. Meta also carries `context.forwarded` /
`context.frequently_forwarded` on messages that arrived at the business number
having been forwarded (the only forward signal Meta exposes — it never reveals a
forward that happened between two other people's accounts).
"""
from __future__ import annotations

import hashlib
import hmac

import httpx

from ..resilience import CircuitBreaker, retry_async

_GRAPH = "https://graph.facebook.com/v21.0"
_TIMEOUT = 10.0
_wa_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="whatsapp")


class WhatsAppError(Exception):
    """A definitive WhatsApp/Graph API failure (bad token, bad request)."""


def verify_signature(app_secret: str, raw_body: bytes, signature: str) -> bool:
    """Verify Meta's X-Hub-Signature-256 (constant-time). Fail closed on any
    malformed input or mismatch."""
    if not app_secret or not signature or not signature.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(app_secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


async def get_phone_number(access_token: str, phone_number_id: str) -> dict:
    """Validate the token + phone_number_id by fetching the number's metadata.
    Returns e.g. {'display_phone_number': '+1…', 'verified_name': '…', 'id': pnid}."""
    if not phone_number_id:
        raise WhatsAppError("phone_number_id is required")

    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                f"{_GRAPH}/{phone_number_id}",
                params={"fields": "display_phone_number,verified_name"},
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if r.status_code == 200:
                return r.json()
            # Meta returns 4xx with an {"error": {...}} body for bad token/id.
            try:
                err = r.json().get("error", {}).get("message", r.text)
            except Exception:  # noqa: BLE001
                err = r.text
            raise WhatsAppError(f"{r.status_code}: {err}")

    return await retry_async(_attempt, attempts=3, breaker=_wa_breaker)


async def send_text(access_token: str, phone_number_id: str, to: str, text: str) -> dict:
    """Send a text message via the Cloud API. Returns the response (with the wamid)."""

    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{_GRAPH}/{phone_number_id}/messages",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                },
                json={
                    "messaging_product": "whatsapp",
                    "recipient_type": "individual",
                    "to": to,
                    "type": "text",
                    "text": {"preview_url": False, "body": text},
                },
            )
            if r.status_code in (200, 201):
                return r.json()
            try:
                err = r.json().get("error", {}).get("message", r.text)
            except Exception:  # noqa: BLE001
                err = r.text
            raise WhatsAppError(f"{r.status_code}: {err}")

    return await retry_async(_attempt, attempts=3, breaker=_wa_breaker)


async def send_template(
    access_token: str,
    phone_number_id: str,
    to: str,
    template: str,
    params: list[str],
    lang: str = "en_US",
) -> dict:
    """Send an approved template message. `params` fill the body's {{1}}, {{2}}…

    Needed because the Cloud API refuses free-form text to anyone who hasn't
    messaged the business number in the last 24 hours (see is_reengagement_error).
    A template is the ONLY way to open that conversation, and it has to be
    approved by Meta first — which is why the template name comes from the org,
    not from us.
    """

    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{_GRAPH}/{phone_number_id}/messages",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                },
                json={
                    "messaging_product": "whatsapp",
                    "recipient_type": "individual",
                    "to": to,
                    "type": "template",
                    "template": {
                        "name": template,
                        "language": {"code": lang},
                        "components": (
                            [
                                {
                                    "type": "body",
                                    "parameters": [
                                        {"type": "text", "text": p} for p in params
                                    ],
                                }
                            ]
                            if params
                            else []
                        ),
                    },
                },
            )
            if r.status_code in (200, 201):
                return r.json()
            try:
                err = r.json().get("error", {}).get("message", r.text)
            except Exception:  # noqa: BLE001
                err = r.text
            raise WhatsAppError(f"{r.status_code}: {err}")

    return await retry_async(_attempt, attempts=3, breaker=_wa_breaker)


#: Meta's codes for "this number hasn't talked to you recently, use a template":
#: 131047 is the documented re-engagement error; 470 is the legacy one still
#: returned by some numbers. Matched alongside the prose because Meta puts the
#: code in the message body for some failure shapes and not others.
_REENGAGEMENT_MARKERS = ("131047", "470", "re-engagement", "24 hour", "24-hour")


def is_reengagement_error(exc: Exception) -> bool:
    """True when a send failed only because the 24h session window is closed.

    Kept here rather than string-matching at the call site: the fallback
    decision (try a template / ask the admin to message us first) is only
    correct for THIS failure, and must not swallow a bad token or a bad number.
    """
    msg = str(exc).lower()
    return any(m in msg for m in _REENGAGEMENT_MARKERS)


def phone_number_id_of(payload: dict) -> str | None:
    """The business number (phone_number_id) a webhook was delivered to — used to
    resolve which connection it belongs to."""
    for entry in payload.get("entry", []) or []:
        for change in entry.get("changes", []) or []:
            meta = (change.get("value", {}) or {}).get("metadata", {}) or {}
            pnid = meta.get("phone_number_id")
            if pnid:
                return str(pnid)
    return None


def parse_inbound(payload: dict) -> list[dict]:
    """Flatten a Meta webhook into inbound message dicts. `forwarded` /
    `frequently_forwarded` come straight from Meta's `context` (the only forward
    signal the API exposes)."""
    out: list[dict] = []
    for entry in payload.get("entry", []) or []:
        for change in entry.get("changes", []) or []:
            value = change.get("value", {}) or {}
            for msg in value.get("messages", []) or []:
                ctx = msg.get("context", {}) or {}
                out.append(
                    {
                        "external_id": msg.get("id"),
                        "from": msg.get("from", ""),
                        "text": (msg.get("text", {}) or {}).get("body", ""),
                        "forwarded": bool(ctx.get("forwarded")),
                        "frequently_forwarded": bool(ctx.get("frequently_forwarded")),
                        "context_id": ctx.get("id"),
                    }
                )
    return out
