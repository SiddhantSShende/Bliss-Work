"""Test bootstrap for email-worker pure-logic tests.

These tests target PURE logic (regex validation, string truncation, the
in-memory poison-failure / DLQ threshold counter) and must NOT require a live
SMTP server, Kafka, Postgres or Redis.

In CI the full ``requirements.txt`` is installed, so importing ``app.mailer`` /
``app.relay_consumer`` / ``app.worker`` pulls in the REAL third-party modules
and the tests exercise the real production code unchanged.

Locally those heavy deps (aiosmtplib, aiokafka, asyncpg, redis, structlog,
pydantic-settings) are typically absent, which would break test *collection*
before any pure function could run. To keep collection working everywhere we
install lightweight stand-ins for ONLY the modules that are genuinely missing
(each insertion is guarded by a real import attempt). When a real module is
present we never shadow it, so CI always runs against the real dependency.

The stubs expose just the names the ``app`` package imports at module load
time -- they are deliberately inert and are never used to assert behaviour.
"""
from __future__ import annotations

import os
import sys
import types

# Make the service root importable as ``app`` regardless of where pytest is run.
_SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVICE_ROOT not in sys.path:
    sys.path.insert(0, _SERVICE_ROOT)


def _ensure_stub(name: str, **attrs: object) -> None:
    """Register a minimal module stub IFF the real module cannot be imported.

    Guard order matters: we try the real import first so a fully-provisioned
    environment (CI) keeps the genuine module and these tests validate real
    code. The stub is a last resort to keep collection alive on a dev box that
    has not installed the worker's runtime requirements.
    """
    if name in sys.modules:
        return
    try:  # real module wins whenever it is installed
        __import__(name)
        return
    except Exception:  # noqa: BLE001 - any import failure -> fall back to stub
        pass
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module


def _noop_logger(*_a: object, **_k: object) -> object:
    return types.SimpleNamespace(
        info=lambda *a, **k: None,
        warning=lambda *a, **k: None,
        error=lambda *a, **k: None,
        debug=lambda *a, **k: None,
        bind=lambda *a, **k: _noop_logger(),
    )


async def _async_noop(*_a: object, **_k: object) -> None:
    return None


# --- aiosmtplib (imported at the top of app/mailer.py) -----------------------
class _StubSMTPException(Exception):
    pass


_ensure_stub("aiosmtplib", SMTPException=_StubSMTPException, send=_async_noop)

# --- structlog (app/relay_consumer.py) ---------------------------------------
_ensure_stub("structlog", get_logger=_noop_logger)

# --- aiokafka + aiokafka.errors ----------------------------------------------
_ensure_stub("aiokafka", AIOKafkaConsumer=object, AIOKafkaProducer=object)


class _StubKafkaError(Exception):
    pass


class _StubKafkaConnectionError(_StubKafkaError):
    pass


_ensure_stub(
    "aiokafka.errors",
    KafkaError=_StubKafkaError,
    KafkaConnectionError=_StubKafkaConnectionError,
)
# Make ``aiokafka.errors`` reachable as an attribute too (some import styles).
if isinstance(sys.modules.get("aiokafka"), types.ModuleType):
    sys.modules["aiokafka"].errors = sys.modules["aiokafka.errors"]

# --- asyncpg / redis ----------------------------------------------------------
_ensure_stub("asyncpg", Pool=object, create_pool=_async_noop)
_ensure_stub("redis")
_ensure_stub("redis.asyncio", Redis=object)

# --- pydantic-settings (+ pydantic primitives if even pydantic is absent) -----
try:
    import pydantic_settings  # noqa: F401  (real module present -> use it)
except Exception:  # noqa: BLE001
    try:
        from pydantic import BaseModel as _RealBaseModel

        class _StubBaseSettings(_RealBaseModel):  # type: ignore[misc, valid-type]
            pass
    except Exception:  # noqa: BLE001 - pydantic itself missing
        class _StubBaseSettings:  # type: ignore[no-redef]
            def __init__(self, **_k: object) -> None:
                pass

        def _Field(default: object = None, **_k: object) -> object:
            return default

        class _AliasChoices:  # noqa: N801 - mirror pydantic's name
            def __init__(self, *_a: object) -> None:
                pass

        _ensure_stub("pydantic", Field=_Field, AliasChoices=_AliasChoices)

    def _SettingsConfigDict(**kwargs: object) -> dict:  # noqa: N802
        return dict(**kwargs)

    _ensure_stub(
        "pydantic_settings",
        BaseSettings=_StubBaseSettings,
        SettingsConfigDict=_SettingsConfigDict,
    )
