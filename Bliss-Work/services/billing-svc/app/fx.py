"""Live FX rates, USD-based.

Provider: open.er-api.com (exchangerate-api.com's free, no-key "open access"
endpoint), confirmed live on 2026-10-21:

    GET https://open.er-api.com/v6/latest/USD
    -> {
         "result": "success",
         "time_last_update_unix": 1792540952,
         "time_next_update_unix": 1792628462,
         "base_code": "USD",
         "rates": {"USD": 1, "INR": 89.xx, "GBP": 0.75, "EUR": 0.86, ...}
       }

No API key required. Rate-limited IPs get HTTP 429. This module fails
LOUDLY (raises FxUnavailableError) on any network error, non-"success"
result, missing/non-positive rate, or a cached rate older than the
configured TTL with no fresh fetch available — there is deliberately no
hardcoded fallback rate, since a wrong FX rate directly misprices a
real-money charge.

Caching: a db-backed cache (`fx_rate_cache`, migrations/0007) keyed by
(currency_pair, source), TTL from billing_pricing['fx_rate_cache_ttl_seconds']
(default 3600s / 1h) — short enough that INR pricing tracks the market
within an hour, long enough that a quote burst doesn't hammer the provider.
A process-local in-memory copy of the last-fetched rates avoids a db round
trip on every call within the same TTL window.
"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

FX_PROVIDER = "open.er-api.com"
FX_BASE_URL = "https://open.er-api.com/v6/latest/USD"
_DEFAULT_TTL_SECONDS = 3600
_FETCH_TIMEOUT = 5.0

_memory_cache: dict[str, tuple[float, datetime]] = {}  # currency -> (rate, fetched_at)


class FxUnavailableError(RuntimeError):
    """Raised when a live FX rate cannot be obtained. Never swallow this into
    a fallback rate — callers must surface it as a 503 to the client."""


async def _ttl_seconds(db: AsyncSession) -> int:
    row = (
        await db.execute(
            text("SELECT value FROM billing_pricing WHERE key = 'fx_rate_cache_ttl_seconds'")
        )
    ).first()
    if row is None or not isinstance(row[0], (int, float)):
        return _DEFAULT_TTL_SECONDS
    return int(row[0])


async def _fetch_live() -> dict[str, float]:
    try:
        async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT) as client:
            resp = await client.get(FX_BASE_URL)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        raise FxUnavailableError(f"fx provider request failed: {exc}") from exc

    if data.get("result") != "success":
        raise FxUnavailableError(f"fx provider returned non-success result: {data.get('result')}")
    rates = data.get("rates")
    if not isinstance(rates, dict) or not rates:
        raise FxUnavailableError("fx provider response missing rates")
    return rates


async def get_usd_rate(db: AsyncSession, target_currency: str) -> tuple[float, str, datetime]:
    """Returns (rate, source, fetched_at) for 1 USD -> target_currency.

    Raises FxUnavailableError if the provider is unreachable, the response is
    malformed, or the resulting rate is not a positive number. No fallback.
    """
    currency = target_currency.strip().upper()
    ttl = await _ttl_seconds(db)
    now = datetime.now(timezone.utc)

    cached = _memory_cache.get(currency)
    if cached is not None:
        rate, fetched_at = cached
        if (now - fetched_at).total_seconds() < ttl:
            return rate, FX_PROVIDER, fetched_at

    db_row = (
        await db.execute(
            text(
                "SELECT rate, fetched_at FROM fx_rate_cache "
                "WHERE currency_pair = :pair AND source = :source"
            ),
            {"pair": f"USD{currency}", "source": FX_PROVIDER},
        )
    ).first()
    if db_row is not None:
        rate, fetched_at = float(db_row[0]), db_row[1]
        if fetched_at.tzinfo is None:
            fetched_at = fetched_at.replace(tzinfo=timezone.utc)
        if (now - fetched_at).total_seconds() < ttl:
            _memory_cache[currency] = (rate, fetched_at)
            return rate, FX_PROVIDER, fetched_at

    rates = await _fetch_live()
    rate = rates.get(currency)
    if not isinstance(rate, (int, float)) or rate <= 0:
        raise FxUnavailableError(f"fx provider has no usable rate for {currency}")
    rate = float(rate)

    await db.execute(
        text(
            "INSERT INTO fx_rate_cache (currency_pair, source, rate, fetched_at) "
            "VALUES (:pair, :source, :rate, :now) "
            "ON CONFLICT (currency_pair, source) DO UPDATE SET rate = :rate, fetched_at = :now"
        ),
        {"pair": f"USD{currency}", "source": FX_PROVIDER, "rate": rate, "now": now},
    )
    _memory_cache[currency] = (rate, now)
    return rate, FX_PROVIDER, now
