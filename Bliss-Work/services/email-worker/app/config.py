"""Environment-driven configuration for email-worker."""
from __future__ import annotations

import ssl
from urllib.parse import parse_qs, urlsplit, urlunsplit

from pydantic import AliasChoices, Field, model_validator
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
    #  * auth_internal_base + auth_internal_token → resolve recipient e-mail/
    #    username by ASKING auth-svc's internal API (the identity owner), never
    #    by reading another service's database.
    #
    # Each callee below is authenticated with ITS OWN secret rather than one
    # shared platform-wide token — see docs/AUTH_AUTHZ_REMEDIATION_PLAN.md,
    # Phase 2. email-worker calls three different services' /internal/* routes
    # and needs all three of their secrets, but a compromise of any one of
    # them no longer hands out the other two.
    email_db_url: str = Field(
        default="postgres://postgres:postgres@postgres:5432/emaildb",
        validation_alias=AliasChoices("EMAIL_DATABASE_URL", "email_db_url"),
    )
    auth_internal_base: str = Field(
        default="http://auth-svc:8001",
        validation_alias=AliasChoices("AUTH_INTERNAL_BASE", "auth_internal_base"),
    )
    auth_internal_token: str = Field(
        default="dev-internal-token",
        validation_alias=AliasChoices("AUTH_INTERNAL_TOKEN", "auth_internal_token"),
    )
    #  * messaging_internal_base → fetch the bytes of a file attached to an
    #    outbound mail. The blob volume is mounted into messaging-svc alone, so
    #    the files are asked for rather than read off another service's disk.
    messaging_internal_base: str = Field(
        default="http://messaging-svc:8004",
        validation_alias=AliasChoices("MESSAGING_INTERNAL_BASE", "messaging_internal_base"),
    )
    messaging_internal_token: str = Field(
        default="dev-internal-token",
        validation_alias=AliasChoices("MESSAGING_INTERNAL_TOKEN", "messaging_internal_token"),
    )
    #  * integrations_internal_base → ask whether the member who composed a mail
    #    has a connected mailbox to send it through, and send it there. Mail sent
    #    that way is genuinely from them: their own address in From, signed by
    #    their own domain, and filed in their own Sent folder. The SMTP settings
    #    below stay the fallback for members with no connection, and remain the
    #    ONLY path for mail the product itself sends.
    integrations_internal_base: str = Field(
        default="http://integrations-svc:8005",
        validation_alias=AliasChoices(
            "INTEGRATIONS_INTERNAL_BASE", "integrations_internal_base"
        ),
    )
    integrations_internal_token: str = Field(
        default="dev-internal-token",
        validation_alias=AliasChoices(
            "INTEGRATIONS_INTERNAL_TOKEN", "integrations_internal_token"
        ),
    )
    # Total RAW bytes of attachments carried on one outbound email. Base64 adds
    # about a third on top, so the default lands near 13.6 MB on the wire —
    # comfortably under the 25 MB Gmail accepts and the 20 MB or less that many
    # providers do. Uploads themselves are capped far higher (MEDIA_MAX_BYTES,
    # 100 MB); what exceeds this budget is named in the mail rather than
    # attached, and the in-app copy still carries every file.
    # Set to 0 to relay no attachments at all.
    mail_attachment_budget_bytes: int = Field(
        default=10 * 1024 * 1024,
        validation_alias=AliasChoices(
            "MAIL_ATTACHMENT_BUDGET_BYTES", "mail_attachment_budget_bytes"
        ),
    )
    redis_url: str = Field(
        default="redis://redis:6379/0",
        validation_alias=AliasChoices("REDIS_URL", "redis_url"),
    )
    # Recipient is considered "offline" when presence:u:<id> holds no entry with
    # a recent heartbeat (see app/presence.py for the shape) AND
    # event.occurredAt is older than this many seconds (avoids spamming users
    # who legitimately just signed off between the message landing and the
    # consumer reading it).
    offline_threshold_seconds: int = Field(
        default=60,
        validation_alias=AliasChoices("OFFLINE_THRESHOLD_SECONDS", "offline_threshold_seconds"),
    )
    # Deep-link prefix used in email CTAs. Same var every other service reads
    # for its own web origin (CORS allowlist, WebAuthn expected_origin, OAuth
    # redirects) — see auth-svc/app/config.py — so it is already set in prod.
    web_origin: str = Field(
        default="http://localhost:5173",
        validation_alias=AliasChoices("WEB_ORIGIN", "web_origin"),
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

    # Deployment environment — see auth-svc/app/config.py. When "production"/"prod",
    # hard-fail at startup on leftover dev sentinels (dev internal token, non-TLS or
    # dev-credentialed DB, unset SMTP password on a real host).
    tb_env: str = Field(
        default="development",
        validation_alias=AliasChoices("TB_ENV", "tb_env"),
    )

    @model_validator(mode="after")
    def _enforce_prod_safety(self) -> "Settings":
        if self.tb_env.strip().lower() not in {"production", "prod"}:
            return self
        problems: list[str] = []
        if not self.auth_internal_token or self.auth_internal_token == "dev-internal-token":
            problems.append("AUTH_INTERNAL_TOKEN must be set to a real value in production")
        if not self.messaging_internal_token or self.messaging_internal_token == "dev-internal-token":
            problems.append("MESSAGING_INTERNAL_TOKEN must be set to a real value in production")
        if (
            not self.integrations_internal_token
            or self.integrations_internal_token == "dev-internal-token"
        ):
            problems.append("INTEGRATIONS_INTERNAL_TOKEN must be set to a real value in production")
        if "sslmode=verify-full" not in self.email_db_url:
            problems.append("EMAIL_DATABASE_URL must use sslmode=verify-full in production")
        if "taskboard_dev_pw" in self.email_db_url or "postgres:postgres@" in self.email_db_url:
            problems.append("EMAIL_DATABASE_URL still uses dev credentials")
        if self.smtp_host and self.smtp_host != "mailpit" and self.smtp_password in ("", "CHANGE_ME_smtp"):
            problems.append("SMTP_PASSWORD must be set when using a real SMTP host")
        if self.web_origin.strip().rstrip("/") in ("", "http://localhost:5173"):
            problems.append("WEB_ORIGIN must be set to the real deployment URL in production")
        if problems:
            raise ValueError(
                "refusing to start in production with insecure configuration:\n  - "
                + "\n  - ".join(problems)
            )
        return self

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
