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

import pytest

# tests/ lives directly under the service root (services/integrations-svc/).
_SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVICE_ROOT not in sys.path:
    sys.path.insert(0, _SERVICE_ROOT)


@pytest.fixture(autouse=True)
def _reset_shared_http_client():
    """app/providers/httpclient.py keeps ONE pooled httpx.AsyncClient as a
    process-wide module-level singleton (by design — see its own docstring).
    Several test files (test_oauth_identity.py,
    test_provider_send_no_duplicate_retry.py, test_httpclient.py) build their
    own mock/MockTransport-backed stand-in and rely on `shared()` constructing
    a fresh client, which only actually happens the FIRST time `shared()` is
    ever called in the process — every later test otherwise reuses whichever
    stand-in got cached first, leaking one test's fixture into another's
    assertions.

    Resetting the module attribute directly (not via `aclose()`) is
    deliberate: some of those stand-ins don't implement `.aclose()` at all
    (they only need whatever methods the code under test actually calls), so
    routing this through the production shutdown path would crash on exactly
    the mocks this fixture exists to isolate. This changes nothing about how
    production code itself manages the client's lifecycle."""
    from app.providers import httpclient

    httpclient._client = None
    yield
    httpclient._client = None
