from __future__ import annotations

import ssl
from urllib.parse import parse_qs, urlsplit, urlunsplit

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration is sourced from the environment (12-factor).

    Mirrors task-svc/app/config.py deliberately — the DSN parsing, the SSL
    context and the production-sentinel validator are the same code, because a
    service that gets those subtly different is a service that is subtly less
    secure than its neighbours.
    """

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    sticky_database_url: str = "postgresql://taskboard:taskboard_dev_pw@postgres:5432/stickydb"
    kafka_brokers: str = "kafka:9092"

    jwks_url: str = "http://auth-svc:8001/.well-known/jwks.json"
    jwt_issuer: str = "task-board"

    web_origin: str = "http://localhost:5173"
    # How many reverse-proxy hops sit in front of this service. Every per-IP
    # control counts this many entries in from the RIGHT of X-Forwarded-For, so
    # it must equal the number of proxies that APPEND to that header before us.
    # 1 = the Caddy edge, the only thing that can reach this service (it
    # publishes no ports). See app/net.py — too HIGH starts trusting
    # client-supplied entries, which is how a per-IP limiter becomes bypassable.
    trusted_proxy_hops: int = 1

    log_level: str = "info"

    port: int = 8008

    # This service's OWN internal-endpoint secret (validates callers of
    # GET /internal/pins/undelivered — i.e. sticky-relay, and nothing else).
    internal_token: str = Field(default="", validation_alias="STICKY_INTERNAL_TOKEN")

    # Redis for distributed rate limiting (honest across replicas). Empty =
    # in-process fallback (per-replica, fails open). slowapi_storage_uri
    # overrides redis_url for the slowapi limiter specifically; usually set both
    # to the same redis:// URL. Mirrors auth-svc/app/config.py.
    redis_url: str = ""
    slowapi_storage_uri: str = ""

    # ── Deliberately NO at-rest column-encryption settings ────────────────────
    # This service stores task IDs and lifecycle timestamps, never a task's
    # title or description. Those are encrypted in task-svc under a per-org DEK
    # (see services/shared/crypto), and keeping a second encrypted copy of the
    # same PII here would double the key-rotation and compliance surface to save
    # one round-trip the client already makes for the note's content.

    # Deployment environment — see auth-svc/app/config.py. When "production"/"prod",
    # hard-fail at startup on any leftover dev sentinel so a misconfigured prod
    # deploy can never silently run on guessable secrets.
    tb_env: str = "development"

    @model_validator(mode="after")
    def _enforce_prod_safety(self) -> "Settings":
        if self.tb_env.strip().lower() not in {"production", "prod"}:
            return self
        problems: list[str] = []
        if "taskboard_dev_pw" in self.sticky_database_url:
            problems.append("STICKY_DATABASE_URL still uses the dev password")
        if "sslmode=verify-full" not in self.sticky_database_url:
            problems.append("STICKY_DATABASE_URL must use sslmode=verify-full in production")
        if not self.internal_token:
            problems.append("STICKY_INTERNAL_TOKEN must be set in production")
        if problems:
            raise ValueError(
                "refusing to start in production with insecure configuration:\n  - "
                + "\n  - ".join(problems)
            )
        return self

    @property
    def sqlalchemy_url(self) -> str:
        """Convert a plain postgresql:// URL to the asyncpg driver URL."""
        url = self._strip_query(self.sticky_database_url)
        if url.startswith("postgresql+asyncpg://"):
            return url
        if url.startswith("postgresql://"):
            return "postgresql+asyncpg://" + url[len("postgresql://"):]
        if url.startswith("postgres://"):
            return "postgresql+asyncpg://" + url[len("postgres://"):]
        return url

    @property
    def sqlalchemy_connect_args(self) -> dict[str, object]:
        ssl_context = self._ssl_context_from_database_url(self.sticky_database_url)
        connect_args: dict[str, object] = {"server_settings": {"statement_timeout": "30000"}}
        if ssl_context is not None:
            connect_args["ssl"] = ssl_context
        return connect_args

    @staticmethod
    def _strip_query(url: str) -> str:
        parts = urlsplit(url)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, "", parts.fragment))

    @staticmethod
    def _ssl_context_from_database_url(url: str) -> ssl.SSLContext | None:
        query = parse_qs(urlsplit(url).query)
        sslmode = query.get("sslmode", [""])[0]
        if not sslmode or sslmode == "disable":
            return None

        cafile = query.get("sslrootcert", [""])[0]
        if cafile:
            context = ssl.create_default_context(cafile=cafile)
        else:
            context = ssl.create_default_context()

        context.check_hostname = sslmode == "verify-full"
        context.verify_mode = ssl.CERT_REQUIRED
        return context


settings = Settings()
