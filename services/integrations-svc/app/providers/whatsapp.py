"""WhatsApp (Meta Cloud API) adapter — Business accounts only.

Connect is token-paste: a system-user access token, the WhatsApp Business Account
(WABA) id, the phone_number_id of a number on it, and the app secret (for webhook
signatures). Because every message transits the business number, Bliss-Work owns
the graph — inbound arrivals, our outbound sends, and forwards done through the
app are all trackable.

BUSINESS ONLY, and enforced rather than assumed. The Cloud API is already
structurally out of reach of a personal account — a phone_number_id and a
system-user token only exist for a number registered to a WABA — but that says
nothing about whether the business is real. An unverified number, a number still
in Meta's test state, or an on-premise deployment would all have connected
identically. `check_business_account` below is the gate: the number must be a
VERIFIED Cloud API number that genuinely belongs to an APPROVED Business Account.

Inbound webhooks are authenticated by Meta's `X-Hub-Signature-256` = HMAC-SHA256
over the raw body with the app secret. Meta also carries `context.forwarded` /
`context.frequently_forwarded` on messages that arrived at the business number
having been forwarded (the only forward signal Meta exposes — it never reveals a
forward that happened between two other people's accounts).
"""
from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass

import httpx

from ..logging_setup import log
from ..resilience import CircuitBreaker, retry_async

#: Pinned Graph version. Exported because the browser's Embedded Signup popup
#: must init the Facebook SDK against the SAME version the server exchanges
#: against — a mismatch fails at the code exchange, not in the popup.
GRAPH_VERSION = "v21.0"
_GRAPH = f"https://graph.facebook.com/{GRAPH_VERSION}"
_TIMEOUT = 10.0
_wa_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="whatsapp")


class WhatsAppError(Exception):
    """A definitive WhatsApp/Graph API failure (bad token, bad request)."""


class WhatsAppPermissionError(WhatsAppError):
    """The token authenticated but isn't allowed to read the Business Account.

    Its own class because it is the single most likely first failure of a setup
    and the only one with a precise fix: sending needs
    `whatsapp_business_messaging`, but reading WABA metadata needs
    `whatsapp_business_management`, and people grant only the first.
    """


class NotABusinessAccount(WhatsAppError):
    """The credentials work, but they don't describe an approved business number.

    Distinct from WhatsApp Error so the route can answer 400-with-this-reason
    instead of "WhatsApp rejected the credentials", which would send an admin
    hunting for a typo in a token that is perfectly fine.
    """


def verify_signature(app_secret: str, raw_body: bytes, signature: str) -> bool:
    """Verify Meta's X-Hub-Signature-256 (constant-time). Fail closed on any
    malformed input or mismatch."""
    if not app_secret or not signature or not signature.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(app_secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


#: Meta error codes for "the token is valid but lacks the permission".
_PERMISSION_CODES = {10, 200, 299}


class _UnknownField(WhatsAppError):
    """Graph refused the request because a name in `fields` doesn't exist."""


def _is_unknown_field(message: str) -> bool:
    m = message.lower()
    return "nonexisting field" in m or "unknown field" in m


async def _graph_get_raw(access_token: str, path: str, fields: str | None) -> dict:
    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                f"{_GRAPH}/{path}",
                params={"fields": fields} if fields else None,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if r.status_code == 200:
                return r.json()
            # Meta returns 4xx with an {"error": {...}} body for bad token/id.
            code, err = None, r.text
            try:
                body = r.json().get("error", {})
                code, err = body.get("code"), body.get("message", r.text)
            except Exception:  # noqa: BLE001
                pass
            if code in _PERMISSION_CODES or "permission" in str(err).lower():
                raise WhatsAppPermissionError(
                    "your system-user token also needs the "
                    "`whatsapp_business_management` permission to read the "
                    f"Business Account ({err})"
                )
            if _is_unknown_field(str(err)):
                raise _UnknownField(str(err))
            raise WhatsAppError(f"{r.status_code}: {err}")

    return await retry_async(_attempt, attempts=3, breaker=_wa_breaker)


async def _graph_get(access_token: str, path: str, fields: str) -> dict:
    """One authenticated Graph read, with the shared retry + breaker.

    Graph rejects the WHOLE request with a 400 if any name in `fields` is
    unknown — so if Meta ever renames or retires one of the fields the business
    gate asks for, every WhatsApp connect starts failing at once, for a reason
    that reads like the admin's credentials are bad. Retrying without `fields`
    falls back to Meta's default projection: the checks then see whatever it
    does return and fail CLOSED on anything they can't confirm, which is the
    right way for a gate to break. The warning is what makes it findable.
    """
    try:
        return await _graph_get_raw(access_token, path, fields)
    except _UnknownField as exc:
        log.warning(
            "whatsapp_graph_unknown_field",
            path=path,
            fields=fields,
            error=str(exc),
        )
        return await _graph_get_raw(access_token, path, None)


@dataclass(frozen=True)
class BusinessNumber:
    """A phone number confirmed to belong to an approved WhatsApp Business Account."""

    phone_number_id: str
    display_phone_number: str
    verified_name: str
    business_name: str


async def check_business_account(
    access_token: str, waba_id: str, phone_number_id: str
) -> BusinessNumber:
    """Prove these credentials describe a WhatsApp BUSINESS number, or raise.

    Two reads, in this order:

      GET /{waba_id}                 → is the business itself approved?
      GET /{waba_id}/phone_numbers   → does this number belong to it, and is it
                                       a verified Cloud API number?

    Listing the WABA's numbers rather than reading /{phone_number_id} directly is
    deliberate and load-bearing. Reading the number alone would tell us it is
    verified but not WHOSE it is — so pasting any approved WABA id alongside an
    unrelated number would sail through the gate. Membership in this list is the
    binding, and the list carries the per-number fields anyway, so it costs
    nothing extra.
    """
    if not waba_id:
        raise WhatsAppError("a WhatsApp Business Account ID is required")
    if not phone_number_id:
        raise WhatsAppError("a phone number ID is required")

    account = await _graph_get(access_token, waba_id, "id,name,account_review_status")
    review = str(account.get("account_review_status") or "").upper()
    if review != "APPROVED":
        raise NotABusinessAccount(
            "that WhatsApp Business Account hasn't been approved by Meta yet"
            + (f" (Meta says: {review.lower()})" if review else "")
        )

    listing = await _graph_get(
        access_token,
        f"{waba_id}/phone_numbers",
        "id,display_phone_number,verified_name,code_verification_status,platform_type",
    )
    numbers = listing.get("data") or []
    match = next((n for n in numbers if str(n.get("id")) == str(phone_number_id)), None)
    if match is None:
        raise NotABusinessAccount(
            "that phone number ID doesn't belong to the Business Account you entered"
        )

    if str(match.get("code_verification_status") or "").upper() != "VERIFIED":
        raise NotABusinessAccount(
            "that business number hasn't completed Meta's verification yet"
        )
    # ON_PREMISE numbers don't deliver through the Cloud API endpoints this
    # integration is built on, so accepting one would produce a connection that
    # passes every check and then silently fails to send.
    platform = str(match.get("platform_type") or "").upper()
    if platform and platform != "CLOUD_API":
        raise NotABusinessAccount(
            f"only Cloud API numbers can connect — this one is {platform.lower()}"
        )

    return BusinessNumber(
        phone_number_id=str(phone_number_id),
        display_phone_number=str(match.get("display_phone_number") or ""),
        verified_name=str(match.get("verified_name") or ""),
        business_name=str(account.get("name") or ""),
    )


# ── Embedded Signup (Meta Tech Provider) ──────────────────────────────────────
# The one-click path. The customer never sees a developer console: they sign in
# to their own WhatsApp Business account in a Meta-hosted popup, and Meta hands
# US a code. These three calls turn that code into a working connection.


async def _graph_post(access_token: str, path: str, params: dict | None = None) -> dict:
    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{_GRAPH}/{path}",
                params=params or {},
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if r.status_code in (200, 201):
                return r.json()
            code, err = None, r.text
            try:
                body = r.json().get("error", {})
                code, err = body.get("code"), body.get("message", r.text)
            except Exception:  # noqa: BLE001
                pass
            if code in _PERMISSION_CODES or "permission" in str(err).lower():
                raise WhatsAppPermissionError(str(err))
            raise WhatsAppError(f"{r.status_code}: {err}")

    return await retry_async(_attempt, attempts=3, breaker=_wa_breaker)


async def exchange_embedded_code(app_id: str, app_secret: str, code: str) -> str:
    """Turn the Embedded Signup popup's code into the customer's business token.

    Meta's token endpoint takes its parameters as a QUERY STRING, not a POST
    form, which is why this doesn't go through the OAuth helper the Google and
    Microsoft providers share. The token that comes back is a system-user token
    scoped to the customer's WABA and does not expire, so there is no refresh
    grant to wire up either.
    """
    if not code:
        raise WhatsAppError("no authorization code was returned")

    async def _attempt() -> str:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                f"{_GRAPH}/oauth/access_token",
                params={"client_id": app_id, "client_secret": app_secret, "code": code},
            )
            if r.status_code == 200:
                token = str((r.json() or {}).get("access_token") or "")
                if not token:
                    raise WhatsAppError("Meta returned no access token")
                return token
            try:
                err = r.json().get("error", {}).get("message", r.text)
            except Exception:  # noqa: BLE001
                err = r.text
            raise WhatsAppError(f"{r.status_code}: {err}")

    return await retry_async(_attempt, attempts=3, breaker=_wa_breaker)


async def subscribe_app(access_token: str, waba_id: str) -> None:
    """Subscribe OUR app to this Business Account's webhooks.

    This is the Embedded Signup equivalent of the admin pasting a webhook URL,
    and it is what lets that step disappear: from here on Meta delivers this
    customer's messages to our single app-level webhook. Its success is the
    proof the manual flow gets from the hub.challenge handshake, which is why an
    Embedded Signup connection is created `connected` rather than `pending`.
    """
    res = await _graph_post(access_token, f"{waba_id}/subscribed_apps")
    if not res.get("success", True):
        raise WhatsAppError("Meta refused to subscribe BlissWork to that account's webhooks")


#: Meta's code for "this number is already registered", which is a success for
#: our purposes — re-registering an in-use number is not an error to surface.
_ALREADY_REGISTERED = ("already registered", "131070", "133005")


async def register_number(access_token: str, phone_number_id: str, pin: str) -> None:
    """Enable Cloud API messaging on the number. Idempotent in practice.

    A number that exists but was never registered accepts no sends, so skipping
    this would produce a connection that passes every check and then fails on
    the first forward.
    """
    try:
        await _graph_post(
            access_token,
            f"{phone_number_id}/register",
            {"messaging_product": "whatsapp", "pin": pin},
        )
    except WhatsAppError as exc:
        msg = str(exc).lower()
        if any(m in msg for m in _ALREADY_REGISTERED):
            return
        raise


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
