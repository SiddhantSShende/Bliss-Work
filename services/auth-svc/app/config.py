"""Environment-driven configuration (12-factor)."""
from __future__ import annotations

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
            return url
        if url.startswith("postgresql://"):
            return "postgresql+asyncpg://" + url[len("postgresql://") :]
        if url.startswith("postgres://"):
            return "postgresql+asyncpg://" + url[len("postgres://") :]
        return url


settings = Settings()
