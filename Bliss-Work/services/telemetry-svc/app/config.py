from __future__ import annotations

import ssl
from urllib.parse import parse_qs, urlsplit, urlunsplit

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration is sourced from the environment (12-factor).

    telemetry-svc owns the member activity record: sessions, the raw event
    stream and the daily rollups. It stores NO names and NO email addresses —
    only user ids, which the client joins against auth-svc's directory. That is
    deliberate: a compromise of this database, which by its nature holds the most
    behaviourally revealing data in the product, yields nothing directly
    identifying on its own.
    """

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    telemetry_database_url: str = (
        "postgresql://taskboard:taskboard_dev_pw@postgres:5432/telemetrydb"
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

    port: int = 8006

    internal_token: str = Field(default="", validation_alias="TB_INTERNAL_TOKEN")

    # Redis for distributed rate limiting (honest across pods). Empty = in-process
    # fallback (per-pod, fails open). slowapi_storage_uri overrides redis_url for
    # the slowapi limiter specifically; usually set both to the same redis:// URL.
    # Mirrors auth-svc/app/config.py — see app/rate_limit.py for why it matters
    # here in particular: ingest is the highest-QPS surface in the product.
    redis_url: str = ""
    slowapi_storage_uri: str = ""

    # ── Retention & session semantics ───────────────────────────────────────────
    # 90 days of raw events, daily rollups kept forever. `raw_retention_days`
    # drives BOTH the prune job and how far ahead partitions are pre-created, so
    # the two can never disagree about what "expired" means.
    raw_retention_days: int = 90
    partition_days_ahead: int = 30

    # How far back the per-event detail surfaces may be BROWSED. Distinct from
    # raw_retention_days, and deliberately much shorter: the timeline and the
    # session list are the intrusive views — a minute-by-minute record of one
    # named person — and there is no operational reason to scroll a quarter of
    # them. Aggregates (summary, org summary, export) are NOT bounded by this;
    # they answer "how has this workload trended", which needs the longer arc.
    #
    # Retention is unchanged. Nothing here deletes anything; the data stays in
    # the database for reports and for lawful requests, it just is not
    # browsable in the app. Enforced server-side by CLAMPING rather than
    # rejecting, so an old client asking for more silently gets the window
    # instead of an error.
    visible_window_days: int = 7

    # A client heartbeats every 60s while visible. Three missed beats (plus a
    # little slack for a slow network) is the point at which we call a session
    # over — the timeout is what resolves a killed tab or a closed laptop lid,
    # neither of which sends anything on the way out.
    session_timeout_seconds: int = 180
    sweeper_interval_seconds: int = 60

    # Rollups key on a `date`, which is only unambiguous once you name a zone.
    # Default UTC; set to the org's working timezone so "Monday" in the charts
    # means what an admin in that timezone expects. Changing this later requires
    # recomputing rollups, so decide while the history is short.
    rollup_timezone: str = "UTC"

    # Clock-skew clamp for client-supplied timestamps. A device with a wrong
    # clock must not be able to write rows into a partition that no longer
    # exists (or does not exist yet), nor bury real activity a year in the past.
    max_clock_skew_future_seconds: int = 300
    max_clock_backdate_seconds: int = 86_400

    # ── At-rest column encryption (envelope: per-org DEK wrapped by a KEK) ──────
    # IDENTICAL field names + dev defaults to auth/task/integrations so the shared
    # Cryptor and the key-rotation tooling work uniformly across every service.
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
        if "taskboard_dev_pw" in self.telemetry_database_url:
            problems.append("TELEMETRY_DATABASE_URL still uses the dev password")
        if "sslmode=verify-full" not in self.telemetry_database_url:
            problems.append("TELEMETRY_DATABASE_URL must use sslmode=verify-full in production")
        if not self.internal_token:
            problems.append("TB_INTERNAL_TOKEN must be set in production")
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
        url = self._strip_query(self.telemetry_database_url)
        if url.startswith("postgresql+asyncpg://"):
            return url
        if url.startswith("postgresql://"):
            return "postgresql+asyncpg://" + url[len("postgresql://"):]
        if url.startswith("postgres://"):
            return "postgresql+asyncpg://" + url[len("postgres://"):]
        return url

    @property
    def sqlalchemy_connect_args(self) -> dict[str, object]:
        ssl_context = self._ssl_context_from_database_url(self.telemetry_database_url)
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
