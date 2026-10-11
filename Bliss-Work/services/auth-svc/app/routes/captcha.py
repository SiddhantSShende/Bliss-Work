"""GET /auth/captcha — mint a fresh CAPTCHA challenge for login/registration.

No auth required (both callers are pre-session), no CSRF guard (it's a GET
that sets no cookie — same reasoning `enforce_origin` already applies
elsewhere: CSRF matters for cookie-bearing state changes, not for handing out
a public, single-use, short-lived challenge). Rate-limited via the existing
`_SENSITIVE_LIMITS` mechanism (rate_limit.py) rather than a second limiter —
see CAPTCHA_RATE_LIMIT_PER_MINUTE in config.py.
"""
from __future__ import annotations

import base64

from fastapi import APIRouter, Query, Response

from ..schemas import CaptchaChallengeDTO
from . import captcha_service

router = APIRouter(prefix="/auth", tags=["captcha"])


@router.get("/captcha", response_model=CaptchaChallengeDTO)
async def get_captcha(
    response: Response,
    # The id of the challenge a refresh is replacing; it is invalidated so only
    # the new one can be answered. Omitted on the first load.
    replaces: str | None = Query(default=None, max_length=64),
) -> CaptchaChallengeDTO:
    captcha_id, png, ttl = await captcha_service.generate_challenge(replaces)
    # Never cache a one-time challenge — the same hygiene the outbox-events
    # pull endpoint applies to its own secret-adjacent response.
    response.headers["Cache-Control"] = "no-store"
    data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    return CaptchaChallengeDTO(captchaId=captcha_id, captchaImage=data_url, expiresIn=ttl)
