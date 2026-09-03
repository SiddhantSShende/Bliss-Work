"""An AIOKafkaProducer that connects on first use, not at construction —
shared across this repo's Python outbox pollers (auth-svc, task-svc,
integrations-svc).

── Why connect-on-first-use ──────────────────────────────────────────────────
Each poller used to connect its producer during its own ``start()``. Compose's
`depends_on` ordering only applies to `docker compose up` — on a host reboot
the daemon restarts containers by restart-policy alone and ignores it, so the
service raced the broker's boot. Connecting eagerly made that race fatal
("Application startup failed. Exiting.") and crash-looped the container until
Kafka came up. Deferring the connect to first use, under whatever backoff the
poller's own retry loop already applies, removes the boot-order dependency
entirely.

A producer whose ``start()`` failed is not reusable, so a failed attempt is
discarded (``stop()``ped and dropped) rather than cached — the next call
builds a fresh one instead of retrying a producer stuck in a bad state.
"""
from __future__ import annotations

import contextlib
from typing import Any, Callable

from aiokafka import AIOKafkaProducer


class LazyKafkaProducer:
    """Wraps one AIOKafkaProducer per instance, connecting on first ``ensure()``.

    ``value_serializer``/``key_serializer`` are optional because callers differ:
    some hand this pre-encoded bytes (auth-svc), others want json+utf-8 encoding
    done for them (task-svc, integrations-svc) — see each `outbox.py`.
    """

    def __init__(
        self,
        *,
        bootstrap_servers: str,
        security_kwargs: dict[str, Any],
        value_serializer: Callable[[Any], bytes] | None = None,
        key_serializer: Callable[[Any], bytes | None] | None = None,
    ) -> None:
        self._bootstrap_servers = bootstrap_servers
        self._security_kwargs = security_kwargs
        self._value_serializer = value_serializer
        self._key_serializer = key_serializer
        self._producer: AIOKafkaProducer | None = None

    async def ensure(self) -> AIOKafkaProducer:
        """Return the connected producer, connecting on first call."""
        if self._producer is not None:
            return self._producer
        kwargs: dict[str, Any] = dict(
            bootstrap_servers=self._bootstrap_servers,
            # TLS/SASL when KAFKA_SECURITY_PROTOCOL asks for it; empty otherwise.
            **self._security_kwargs,
            enable_idempotence=True,
            acks="all",
        )
        if self._value_serializer is not None:
            kwargs["value_serializer"] = self._value_serializer
        if self._key_serializer is not None:
            kwargs["key_serializer"] = self._key_serializer
        producer = AIOKafkaProducer(**kwargs)
        try:
            await producer.start()
        except Exception:
            with contextlib.suppress(Exception):
                await producer.stop()
            raise
        self._producer = producer
        return producer

    async def stop(self) -> None:
        """Stop the producer if one was ever connected. Safe to call even when
        ``ensure()`` was never invoked (nothing to stop)."""
        if self._producer is not None:
            await self._producer.stop()
            self._producer = None
