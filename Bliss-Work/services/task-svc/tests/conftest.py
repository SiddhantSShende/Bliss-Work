"""Pytest bootstrap for task-svc unit tests.

These are pure-logic tests: no DB, Kafka, or Redis is touched. We only need
the service root (the directory that contains the ``app`` package) on
``sys.path`` so ``import app.auth`` / ``import app.consumer`` resolve the
same way they do when the service runs (``uvicorn app.main:app``).
"""
from __future__ import annotations

import sys
from pathlib import Path

# tests/ lives at services/task-svc/tests, so the service root is the parent.
_SERVICE_ROOT = Path(__file__).resolve().parent.parent
if str(_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_SERVICE_ROOT))
