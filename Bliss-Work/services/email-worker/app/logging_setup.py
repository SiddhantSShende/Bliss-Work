"""Structured JSON logging to stdout via structlog.

The processor-pipeline setup lives in the shared `shared_logging_setup`
package (services/shared/logging_setup) — identical across every Python
service in this repo. email-worker is the one service that asks for many
per-module loggers (worker, mailer, tracing, ...) rather than one flat
service-wide logger, so it keeps its own `get_logger` factory rather than a
single module-level `log`.
"""
from __future__ import annotations

import structlog
from shared_logging_setup import configure_logging

__all__ = ["configure_logging", "get_logger"]


def get_logger(*args, **kwargs) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(*args, **kwargs)
