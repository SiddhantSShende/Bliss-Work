"""Structured JSON logging to stdout via structlog.

The processor-pipeline setup lives in the shared `shared_logging_setup`
package (services/shared/logging_setup) — identical across every Python
service in this repo. This file supplies only what's specific to task-svc:
its own logger name.
"""
from __future__ import annotations

import structlog
from shared_logging_setup import configure_logging

__all__ = ["configure_logging", "log"]

log = structlog.get_logger("task-svc")
