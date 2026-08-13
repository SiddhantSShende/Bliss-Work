"""Entrypoint so the worker runs via `python -m app`.

Phase 6 splits the worker into TWO concurrent consumers:

  * EmailWorker      — auth.events / invite.created → SMTP (pre-existing).
  * RelayConsumer    — messaging.events.v1 + task.events.v1 → SMTP, gated by
                       presence (offline-only).

Both consumers run inside the same OS process for deployment simplicity (one
container, one set of credentials). Failure of one does not stop the other —
each catches and reports its own errors in its `run()` body.
"""
from __future__ import annotations

import asyncio
import signal

from .config import load_settings
from .logging_setup import configure_logging, get_logger
from .relay_consumer import RelayConsumer
from .tracing import setup_tracing
from .worker import EmailWorker


async def _amain() -> None:
    settings = load_settings()
    configure_logging(settings.log_level)
    # Gated on OTEL_EXPORTER_OTLP_ENDPOINT — no-ops when unset (dev default).
    setup_tracing()
    log = get_logger("entrypoint")

    invite_worker = EmailWorker(settings)
    relay_worker = RelayConsumer(settings)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, invite_worker.request_stop)
            loop.add_signal_handler(sig, relay_worker.request_stop)
        except NotImplementedError:
            # Signal handlers are unavailable on some platforms (e.g. Windows).
            pass

    log.info("starting workers", invite_group=settings.consumer_group,
             relay_group=settings.relay_consumer_group)
    await asyncio.gather(invite_worker.run(), relay_worker.run())


def main() -> None:
    try:
        asyncio.run(_amain())
    except KeyboardInterrupt:
        get_logger("entrypoint").info("interrupted")


if __name__ == "__main__":
    main()
