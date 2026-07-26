"""Pytest bootstrap for integrations-svc unit tests.

These are PURE-LOGIC tests: nothing here touches Postgres, Kafka or the network.
They exercise provider signature verification, PKCE derivation, mention parsing
and the pure helpers around them.

We add the service root (the dir that contains the ``app`` package) to
``sys.path`` so ``import app.<module>`` resolves when pytest is invoked from
anywhere (repo root or the service dir). The ``app`` package's ``__init__``
files are empty, so importing the targeted submodules does not pull in the DB
engine / Kafka producer.
"""
from __future__ import annotations

import os
import sys

# tests/ lives directly under the service root (services/integrations-svc/).
_SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVICE_ROOT not in sys.path:
    sys.path.insert(0, _SERVICE_ROOT)
