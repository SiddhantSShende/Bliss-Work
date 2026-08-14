"""Environment-driven configuration (12-factor)."""
from __future__ import annotations

import os
import ssl
from urllib.parse import parse_qs, urlsplit, urlunsplit

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # Database
    auth_database_url: str = "postgresql://taskboard:taskboard_dev_pw@postgres:5432/authdb"

    # Kafka
    kafka_brokers: str = "kafka:9092"

    # JWT / signing
    jwt_issuer: str = "task-board"
    jwt_access_ttl_seconds: int = 900
    jwt_refresh_ttl_seconds: int = 2592000
    jwt_private_key_path: str = "/keys/ed25519_private.pem"
    jwt_public_key_path: str = "/keys/ed25519_public.pem"
    jwt_kid: str = "dev-ed25519-1"
    jwks_url: str = "http://auth-svc:8001/.well-known/jwks.json"

    # Public URLs
    web_origin: str = "http://localhost:5173"
    invite_base_url: str = "http://localhost:5173/invite"
    # Base URLs for the emailed password-reset and email-verification links.
    # These MUST point at the WEB app (browser), not the desktop app — the
    # emailed link opens in a browser. `?token=<raw>` is appended.
    reset_password_url: str = "http://localhost:5173/reset-password"
    verify_email_url: str = "http://localhost:5173/verify-email"

    # Single-use email-token TTLs. Reset is short (an emailed secret that grants
    # a password change); verification is longer (lower-risk, higher-latency).
    reset_token_ttl_minutes: int = 30
    email_verify_ttl_hours: int = 48

    # Login hardening. After `login_max_failed_attempts` bad passwords an account
    # is locked for `lockout_minutes` (throttles password-spraying that rotates
    # IPs, which per-IP rate limits don't catch). require_email_verification, when
    # true, blocks login until the email is confirmed (default off so a brand-new
    # org admin and pre-existing prod users are never locked out on rollout).
    login_max_failed_attempts: int = 8
    lockout_minutes: int = 15
    require_email_verification: bool = False

    # How long a requested org deletion stays cancellable before the purge job
    # will act on it. Long enough that a mistake is caught by a human coming
    # back on Monday, and long enough that at least one nightly backup was taken
    # while the data still existed — the purge is scheduled after the backup for
    # exactly that reason. Lowering this below one day removes both properties.
    org_delete_grace_days: int = 7

    # Redis for distributed rate limiting (honest across pods). Empty = in-process
    # fallback (per-pod, fails open). slowapi_storage_uri overrides redis_url for
    # the slowapi limiter specifically; usually set both to the same redis:// URL.
    redis_url: str = ""
    slowapi_storage_uri: str = ""

    # Refresh-cookie security. `secure` MUST be True in production so the cookie
    # is only sent over TLS; driven by env (COOKIE_SECURE) so a prod deploy flips
    # it without a code change instead of relying on someone remembering to edit
    # cookies.py. samesite "lax" works when the web app and auth-svc share a
    # registrable domain; set "none" (with secure=True) for cross-site.
    cookie_secure: bool = False
    cookie_samesite: str = "lax"

    # ── At-rest column encryption (envelope: per-org DEK wrapped by a KEK) ──────
    # provider: "dev" (Argon2id-derived master KEK from a passphrase) or "kms".
    data_kek_provider: str = "dev"
    data_master_passphrase: str = "dev-master-passphrase-change-me"
    data_master_salt: str = "dev-master-salt-change-me-16+bytes"
    data_kek_version: int = 1
    # Static app-wide key for the email blind index (HMAC). Treat like the JWT
    # private key; rotating it requires re-indexing every email.
    data_blind_index_key: str = "dev-blind-index-key-change-me-32+bytes"
    data_dek_cache_ttl_seconds: float = 300.0
    # KMS (only when data_kek_provider="kms"): aws-kms | gcp-kms | vault-transit.
    data_kms_backend: str = "vault-transit"
    data_kms_key_id: str = ""
    # Vault Transit (when data_kms_backend="vault-transit"); data_kms_key_id is the
    # transit key name (e.g. "taskboard-dek").
    vault_addr: str = ""
    vault_token: str = ""

    # Argon2 password-hash params (env-tunable; 0 = library default).
    argon2_time_cost: int = 0
    argon2_memory_kib: int = 0
    argon2_parallelism: int = 0

    # Misc
    log_level: str = "info"

    # Deployment environment. When "production"/"prod", _enforce_prod_safety below
    # HARD-FAILS at startup on any leftover dev sentinel (crypto keys, dev DB
    # password, non-TLS DB, insecure cookie, missing internal token, half-configured
    # KMS) so a misconfigured prod deploy can never silently run on guessable
    # secrets. The dev/test path (no TB_ENV) keeps the convenient defaults untouched.
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
        if "taskboard_dev_pw" in self.auth_database_url:
            problems.append("AUTH_DATABASE_URL still uses the dev password")
        if "sslmode=verify-full" not in self.auth_database_url:
            problems.append("AUTH_DATABASE_URL must use sslmode=verify-full in production")
        if not self.cookie_secure:
            problems.append("COOKIE_SECURE must be true behind TLS in production")
        if not os.getenv("TB_INTERNAL_TOKEN"):
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
        """SQLAlchemy async requires the asyncpg driver."""
        url = self.auth_database_url
        if url.startswith("postgresql+asyncpg://"):
            return self._strip_query(url)
        if url.startswith("postgresql://"):
            return "postgresql+asyncpg://" + self._strip_query(url[len("postgresql://") :])
        if url.startswith("postgres://"):
            return "postgresql+asyncpg://" + self._strip_query(url[len("postgres://") :])
        return self._strip_query(url)

    @property
    def sqlalchemy_connect_args(self) -> dict[str, object]:
        """Build asyncpg connect args from libpq-style SSL query params."""
        ssl_context = self._ssl_context_from_database_url(self.auth_database_url)
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
