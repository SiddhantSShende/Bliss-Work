from __future__ import annotations

import ssl
from urllib.parse import parse_qs, urlsplit, urlunsplit

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration is sourced from the environment (12-factor).

    integrations-svc owns per-user/per-org external-account connections. The
    USER's OAuth/access tokens are stored per-row, encrypted at rest with the
    per-org envelope Cryptor (see services/shared/crypto/crypto.py) — never in env. Only the app's
    OWN OAuth client credentials (our registered developer app) live here.
    """

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    integrations_database_url: str = (
        "postgresql://taskboard:taskboard_dev_pw@postgres:5432/integrationsdb"
    )
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

    port: int = 8005

    # This service's OWN internal-endpoint secret — validates callers of
    # /internal/messages/send (e.g. messaging-svc
    # asking us to deliver an outbound-to-external forward). NOT the same
    # value used to call OUT to messaging-svc below — see
    # docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 2: every service now has a
    # distinct per-callee secret rather than one token shared platform-wide.
    internal_token: str = Field(default="", validation_alias="INTEGRATIONS_INTERNAL_TOKEN")

    # Public base URL of the deployment (e.g. https://communication.rnrtechs.com).
    # Used to build OAuth redirect URIs + webhook callback URLs. Empty in dev.
    public_base_url: str = ""

    # task-svc base for the mention→task hop. Private-network only. NOTE this
    # carries no shared secret: we forward the CALLER's own JWT, so task-svc
    # applies its normal authorization and the task is authored by the human who
    # clicked Claim rather than by a trusted service impersonating them.
    task_internal_base: str = "http://task-svc:8002"

    # messaging-svc base + its OWN internal-endpoint secret — mail_sync_worker's
    # producer (POST /internal/mail/inbound) and write-back endpoints
    # (external-ref, hide-for-owner). Mirrors email-worker/app/config.py's
    # identical fields; this is messaging-svc's secret, not ours, shared only
    # because every internal caller of messaging-svc presents the same value.
    messaging_internal_base: str = Field(
        default="http://messaging-svc:8004", validation_alias="MESSAGING_INTERNAL_BASE"
    )
    messaging_internal_token: str = Field(default="", validation_alias="MESSAGING_INTERNAL_TOKEN")

    # ── App-level OAuth client credentials (OUR developer apps) ─────────────────
    # Per-user tokens obtained through these flows are stored encrypted per-row.
    # All optional: a provider whose creds are unset is simply not connectable.
    google_client_id: str = ""
    google_client_secret: str = ""
    ms_client_id: str = ""
    ms_client_secret: str = ""
    ms_tenant: str = "common"

    # Redis for distributed rate limiting (honest across replicas). Empty =
    # in-process fallback (per-replica, fails open). slowapi_storage_uri
    # overrides redis_url for the slowapi limiter specifically; usually set both
    # to the same redis:// URL. Mirrors auth-svc/app/config.py.
    redis_url: str = ""
    slowapi_storage_uri: str = ""

    # ── At-rest column encryption (envelope: per-org DEK wrapped by a KEK) ──────
    # IDENTICAL field names + dev defaults to task-svc/auth-svc so the shared
    # Cryptor + key-rotation tooling work uniformly across services.
    data_kek_provider: str = "dev"
    data_master_passphrase: str = "dev-master-passphrase-change-me"
    data_master_salt: str = "dev-master-salt-change-me-16+bytes"
    data_kek_version: int = 1
    data_blind_index_key: str = "dev-blind-index-key-change-me-32+bytes"
    data_dek_cache_ttl_seconds: float = 300.0
    data_kms_backend: str = "vault-transit"
    data_kms_key_id: str = ""
    vault_addr: str = ""
    vault_token: str = ""

    # Deployment environment — when "production"/"prod", hard-fail at startup on
    # any leftover dev sentinel so a misconfigured prod deploy can never silently
    # run on guessable secrets. Mirrors task-svc/auth-svc.
    tb_env: str = "development"

    @model_validator(mode="after")
    def _enforce_prod_safety(self) -> "Settings":
        if self.tb_env.strip().lower() not in {"production", "prod"}:
            return self
        problems: list[str] = []
        if self.data_master_passphrase == "dev-master-passphrase-change-me":
            problems.append("DATA_MASTER_PASSPHRASE is still the dev default")
        if self.data_master_salt == "dev-master-salt-change-me-16+bytes":
            problems.append("DATA_MASTER_SALT is still the dev default")
        if self.data_blind_index_key == "dev-blind-index-key-change-me-32+bytes":
            problems.append("DATA_BLIND_INDEX_KEY is still the dev default")
        if "taskboard_dev_pw" in self.integrations_database_url:
            problems.append("INTEGRATIONS_DATABASE_URL still uses the dev password")
        if "sslmode=verify-full" not in self.integrations_database_url:
            problems.append("INTEGRATIONS_DATABASE_URL must use sslmode=verify-full in production")
        if not self.internal_token:
            problems.append("INTEGRATIONS_INTERNAL_TOKEN must be set in production")
        if not self.messaging_internal_token:
            problems.append("MESSAGING_INTERNAL_TOKEN must be set in production")
        if not self.public_base_url:
            problems.append("PUBLIC_BASE_URL must be set in production (OAuth/webhook callbacks)")
        if self.data_kek_provider == "kms":
            if not self.data_kms_key_id:
                problems.append("DATA_KMS_KEY_ID must be set when DATA_KEK_PROVIDER=kms")
            if self.data_kms_backend == "vault-transit" and not (self.vault_addr and self.vault_token):
                problems.append("VAULT_ADDR and VAULT_TOKEN are required for vault-transit KMS")
        if problems:
            raise ValueError(
                "refusing to start in production with insecure configuration:\n  - "
                + "\n  - ".join(problems)
            )
        return self

    @property
    def sqlalchemy_url(self) -> str:
        """Convert a plain postgresql:// URL to the asyncpg driver URL."""
        url = self._strip_query(self.integrations_database_url)
        if url.startswith("postgresql+asyncpg://"):
            return url
        if url.startswith("postgresql://"):
            return "postgresql+asyncpg://" + url[len("postgresql://"):]
        if url.startswith("postgres://"):
            return "postgresql+asyncpg://" + url[len("postgres://"):]
        return url

    @property
    def sqlalchemy_connect_args(self) -> dict[str, object]:
        ssl_context = self._ssl_context_from_database_url(self.integrations_database_url)
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
