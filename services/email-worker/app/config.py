"""Environment-driven configuration for email-worker."""
from __future__ import annotations

import ssl
from urllib.parse import parse_qs, urlsplit, urlunsplit

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All config sourced from environment variables (see .env.example)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Kafka
    kafka_brokers: str = Field(
        default="kafka:9092",
        validation_alias=AliasChoices("KAFKA_BROKERS", "kafka_brokers"),
    )
    auth_topic: str = "auth.events"
    messaging_topic: str = "messaging.events.v1"
    task_topic: str = "task.events.v1"
    consumer_group: str = "email-worker"
    relay_consumer_group: str = "email-worker-relay"
    # Dead-letter topic for poison messages (events that fail repeatedly).
    dlq_topic: str = Field(
        default="email-worker-dlq",
        validation_alias=AliasChoices("EMAIL_DLQ_TOPIC", "dlq_topic"),
    )
    # After this many consecutive failures for the SAME event_id, route the
    # event to the DLQ and commit so a poison message can't loop forever.
    poison_max_failures: int = Field(
        default=3,
        validation_alias=AliasChoices("POISON_MAX_FAILURES", "poison_max_failures"),
    )

    # Phase 6 offline-relay — strict microservice boundaries:
    #  * email_db_url   → email-worker's OWN database (emaildb) for dedup state.
    #  * auth_internal_base + internal_token → resolve recipient e-mail/username
    #    by ASKING auth-svc's internal API (the identity owner), never by reading
    #    another service's database.
    email_db_url: str = Field(
        default="postgres://postgres:postgres@postgres:5432/emaildb",
        validation_alias=AliasChoices("EMAIL_DATABASE_URL", "email_db_url"),
    )
    auth_internal_base: str = Field(
        default="http://auth-svc:8001",
        validation_alias=AliasChoices("AUTH_INTERNAL_BASE", "auth_internal_base"),
    )
    internal_token: str = Field(
        default="dev-internal-token",
        validation_alias=AliasChoices("TB_INTERNAL_TOKEN", "internal_token"),
    )
    redis_url: str = Field(
        default="redis://redis:6379/0",
        validation_alias=AliasChoices("REDIS_URL", "redis_url"),
    )
    # Recipient is considered "offline" when SCARD presence:user:<id> == 0 AND
    # event.occurredAt is older than this many seconds (avoids spamming users
    # who legitimately just signed off between the message landing and the
    # consumer reading it).
    offline_threshold_seconds: int = Field(
        default=60,
        validation_alias=AliasChoices("OFFLINE_THRESHOLD_SECONDS", "offline_threshold_seconds"),
    )
    # Deep-link prefix used in email CTAs.
    web_base_url: str = Field(
        default="http://localhost:5173",
        validation_alias=AliasChoices("WEB_BASE_URL", "web_base_url"),
    )

    # SMTP. Defaults target Mailpit (local dev catcher, no auth/TLS). Set
    # SMTP_USERNAME/SMTP_PASSWORD (+ a real host/port) to deliver to real inboxes.
    smtp_host: str = Field(
        default="mailpit",
        validation_alias=AliasChoices("SMTP_HOST", "smtp_host"),
    )
    smtp_port: int = Field(
        default=1025,
        validation_alias=AliasChoices("SMTP_PORT", "smtp_port"),
    )
    smtp_from: str = Field(
        default="no-reply@task-board.local",
        validation_alias=AliasChoices("SMTP_FROM", "smtp_from"),
    )
    smtp_username: str = Field(
        default="",
        validation_alias=AliasChoices("SMTP_USERNAME", "smtp_username"),
    )
    smtp_password: str = Field(
        default="",
        validation_alias=AliasChoices("SMTP_PASSWORD", "smtp_password"),
    )
    smtp_starttls: bool = Field(
        default=False,
        validation_alias=AliasChoices("SMTP_STARTTLS", "smtp_starttls"),
    )

    # Logging
    log_level: str = Field(
        default="info",
        validation_alias=AliasChoices("LOG_LEVEL", "log_level"),
    )

    @property
    def email_db_dsn(self) -> str:
        return _strip_query(self.email_db_url)

    @property
    def email_db_ssl_context(self) -> ssl.SSLContext | None:
        return _ssl_context_from_database_url(self.email_db_url)


def load_settings() -> Settings:
    return Settings()


def _strip_query(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", parts.fragment))


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
