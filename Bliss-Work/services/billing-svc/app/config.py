from __future__ import annotations

from urllib.parse import parse_qs, urlsplit, urlunsplit
import ssl

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration is sourced from the environment (12-factor)."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    billing_database_url: str = "postgresql://billing:billing_dev_pw@postgres:5432/billingdb"
    kafka_brokers: str = "kafka:9092"

    jwks_url: str = "http://auth-svc:8001/.well-known/jwks.json"
    jwt_issuer: str = "task-board"

    web_origin: str = "http://localhost:5173"
    trusted_proxy_hops: int = 1

    log_level: str = "info"
    port: int = 8010

    tb_env: str = "development"

    # This service's own /internal/* secret — validated against the caller's
    # X-Internal-Token (see app/routes/internal.py), mirroring task-svc's
    # TASK_INTERNAL_TOKEN. auth-svc is the only caller today (BILLING_INTERNAL_TOKEN
    # in its own config.py), and this is BILLING_INTERNAL_TOKEN in THIS service's
    # env — the two must be the same value, but each service validates its own.
    internal_token: str = Field(default="", validation_alias="BILLING_INTERNAL_TOKEN")

    @property
    def sqlalchemy_url(self) -> str:
        url = self._strip_query(self.billing_database_url)
        if url.startswith("postgresql+asyncpg://"):
            return url
        if url.startswith("postgresql://"):
            return "postgresql+asyncpg://" + url[len("postgresql://"):]
        if url.startswith("postgres://"):
            return "postgresql+asyncpg://" + url[len("postgres://"):]
        return url

    @property
    def sqlalchemy_connect_args(self) -> dict[str, object]:
        ssl_context = self._ssl_context_from_database_url(self.billing_database_url)
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
        context = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
        context.check_hostname = sslmode == "verify-full"
        context.verify_mode = ssl.CERT_REQUIRED
        return context


settings = Settings()
