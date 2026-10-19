from __future__ import annotations

import structlog
from shared_logging_setup import configure_logging

__all__ = ["configure_logging", "log"]

log = structlog.get_logger("billing-svc")
