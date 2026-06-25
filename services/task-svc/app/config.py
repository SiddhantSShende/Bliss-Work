from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration is sourced from the environment (12-factor)."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    task_database_url: str = "postgresql://taskboard:taskboard_dev_pw@postgres:5432/taskdb"
    kafka_brokers: str = "kafka:9092"

    jwks_url: str = "http://auth-svc:8001/.well-known/jwks.json"
    jwt_issuer: str = "task-board"

    web_origin: str = "http://localhost:5173"
    log_level: str = "info"

    port: int = 8002

    # messaging-svc internal endpoint base + shared-secret token used to
    # resolve channel members when a task is allocated to a channel.
    # Defaults match docker-compose; the token must equal the value the
    # messaging-svc reads from TB_INTERNAL_TOKEN (same .env source).
    messaging_internal_base: str = "http://messaging-svc:8004"
    internal_token: str = Field(default="", validation_alias="TB_INTERNAL_TOKEN")

    # ── At-rest column encryption (envelope: per-org DEK wrapped by a KEK) ──────
    # Mirrors auth-svc/app/config.py (same names + dev defaults). See
    # app/crypto.py. provider: "dev" (Argon2id-derived master KEK from a
    # passphrase) or "kms".
    data_kek_provider: str = "dev"
    data_master_passphrase: str = "dev-master-passphrase-change-me"
    data_master_salt: str = "dev-master-salt-change-me-16+bytes"
    data_kek_version: int = 1
    # Static app-wide key for the blind index (HMAC). task-svc doesn't use the
    # blind index today, but the Cryptor requires the key so the API matches
    # auth-svc; treat like the JWT private key if it's ever wired.
    data_blind_index_key: str = "dev-blind-index-key-change-me-32+bytes"
    data_dek_cache_ttl_seconds: float = 300.0
    # KMS (only when data_kek_provider="kms"): aws-kms | gcp-kms | vault-transit.
    data_kms_backend: str = "vault-transit"
    data_kms_key_id: str = ""
    # Vault Transit (when data_kms_backend="vault-transit").
    vault_addr: str = ""
    vault_token: str = ""

    @property
    def sqlalchemy_url(self) -> str:
        """Convert a plain postgresql:// URL to the asyncpg driver URL."""
        url = self.task_database_url.split("?", 1)[0]
        if url.startswith("postgresql+asyncpg://"):
            return url
        if url.startswith("postgresql://"):
            return "postgresql+asyncpg://" + url[len("postgresql://"):]
        if url.startswith("postgres://"):
            return "postgresql+asyncpg://" + url[len("postgres://"):]
        return url


settings = Settings()
