"""Environment-driven configuration (12-factor)."""
from __future__ import annotations

import ssl
from urllib.parse import parse_qs, urlsplit, urlunsplit

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
