"""Pytest bootstrap for telemetry-svc unit tests.

PURE-LOGIC only: nothing here touches Postgres, Kafka or the network. The parts
that genuinely need a database — the prune safety guard, session lifecycle, the
rollup SQL — are exercised by the integration suite against a real Postgres,
because their failure modes (an RLS GUC reset by a COMMIT, a partition that does
not exist yet) cannot be reproduced against a mock.

The service root is added to sys.path so `import app.<module>` resolves whether
pytest is invoked from the repo root or the service directory.
"""
from __future__ import annotations

import os
import sys

_SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVICE_ROOT not in sys.path:
    sys.path.insert(0, _SERVICE_ROOT)
