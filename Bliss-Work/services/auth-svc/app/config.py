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
    # 5 minutes, not 15: verify_bearer (security/auth_dep.py) is purely
    # stateless with no revocation check, so logout cannot invalidate an
    # already-issued access token — only the refresh-token family. Shortening
    # the TTL bounds that residual window instead of adding a cross-service
    # revocation store (every JWT-verifying service — 5 Python/Go services —
    # would need one). Logout revokes the refresh-token family; an access
    # token issued just before logout may remain valid until it expires. See
    # docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 8.
    jwt_access_ttl_seconds: int = 300
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

    # ── MFA (TOTP) ────────────────────────────────────────────────────────────
    # Lifetime of the server-only "MFA pending" token minted after a correct
    # password when a second factor is still owed. Short: it exists only to
    # ferry the caller from POST /auth/login to the challenge-verify endpoint
    # in the same page load. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7.
    mfa_pending_ttl_minutes: int = 5
    # When an org toggles require_mfa_for_admins on, non-enrolled admins get
    # this many days' warning (banner, not a lockout) before login starts
    # blocking at the password step until they enroll.
    mfa_grace_period_days: int = 14

    # How long a requested org deletion stays cancellable before the purge job
    # will act on it. Long enough that a mistake is caught by a human coming
    # back on Monday, and long enough that at least one nightly backup was taken
    # while the data still existed — the purge is scheduled after the backup for
    # exactly that reason. Lowering this below one day removes both properties.
    org_delete_grace_days: int = 7

    # ── CAPTCHA (login + account creation) ───────────────────────────────────
    # Off switch for dev/CI/automated tooling (scripts/security-authz.ts, the
    # e2e seed step) that cannot solve an image challenge — production sets
    # this true. When false, /auth/captcha still works but login/create_org
    # skip the check entirely rather than silently accepting any value.
    captcha_enabled: bool = True
    captcha_length: int = 6
    captcha_ttl_seconds: int = 300
    # Wrong guesses allowed against ONE captcha_id before it is invalidated
    # outright (forcing a fresh fetch) — independent of, and in addition to,
    # the per-IP rate limits on /auth/captcha, /auth/login and /auth/orgs.
    captcha_max_attempts: int = 5
    # Per-IP budget for GET /auth/captcha itself (requests/minute) — wired into
    # rate_limit.py's existing _SENSITIVE_LIMITS rather than a second limiter,
    # since fetching a challenge is otherwise free and would itself become a
    # DoS/enumeration vector without a budget.
    captcha_rate_limit_per_minute: int = 20
    # Client platforms whose /auth/login skips the CAPTCHA (comma-separated,
    # lower-case; empty = nobody is exempt). A product decision: macOS and iOS
    # sign-ins are not challenged. The platform is DECLARED by the client
    # (LoginRequest.clientPlatform) and cannot be verified, so this is a policy
    # switch rather than a control a hostile client has to honour — setting it
    # empty puts the CAPTCHA back on every platform without a code change.
    # Never applies to /auth/orgs.
    captcha_exempt_platforms: str = "macos,ios"

    # Redis for distributed rate limiting (honest across pods). Empty = in-process
    # fallback (per-pod, fails open). slowapi_storage_uri overrides redis_url for
    # the slowapi limiter specifically; usually set both to the same redis:// URL.
    redis_url: str = ""
    slowapi_storage_uri: str = ""

    # Server-side-only credential for the dynamic UI-translation endpoints
    # (routes/i18n.py) — Cloud Translation Basic (v2), API-key auth. Never sent
    # to, or readable by, any client. Empty disables translation: /i18n/languages
    # returns no languages and the app stays on its bundled English catalog,
    # which is the only locale it ever ships client-side.
    google_translate_api_key: str = ""
    # Preferred over the key when set (see i18n_auth.py): a service-account JSON
    # path, or GOOGLE_TRANSLATE_USE_ADC=true for Application Default Credentials
    # with no file (attached service account / workload identity / gcloud ADC).
    google_application_credentials: str = ""
    google_translate_use_adc: bool = False
    # Which locales the switcher offers, comma-separated, in display order —
    # intersected with what Google actually supports. Adding a language is an env
    # change, not a code change. Empty = every language Google supports.
    # English is always available (bundled) and need not be listed.
    i18n_locales: str = "es,fr,de,hi,pt,ja,zh,ko"

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

    # How many reverse-proxy hops sit in front of this service. Every per-IP
    # control counts this many entries in from the RIGHT of X-Forwarded-For, so
    # it must equal the number of proxies that APPEND to that header before us.
    # 1 = the Caddy edge, which is the only thing that can reach these services.
    # See app/net.py — setting this too high starts trusting client-supplied
    # entries, which is how a per-IP limiter becomes bypassable.
    trusted_proxy_hops: int = 1

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
        if urlsplit(self.auth_database_url).username == "taskboard":
            problems.append(
                "AUTH_DATABASE_URL must not use the taskboard superuser role "
                "— use the least-privileged auth_user role (superuser bypasses Row-Level Security)"
            )
        if "sslmode=verify-full" not in self.auth_database_url:
            problems.append("AUTH_DATABASE_URL must use sslmode=verify-full in production")
        if not self.cookie_secure:
            problems.append("COOKIE_SECURE must be true behind TLS in production")
        if not os.getenv("AUTH_INTERNAL_TOKEN"):
            problems.append("AUTH_INTERNAL_TOKEN must be set in production")
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

    # ── Multi-site placement and routing ─────────────────────────────────────
    #
    # Org data is partitioned by site and never replicated: an organisation has
    # one home site, chosen at signup, and stays there. These settings are what
    # this deployment knows about the wider mesh. See docs/CROSS-REGION.md.

    # THIS deployment's site id. It is stamped on every org placed here and on
    # every invite minted here, so it must match the site name used by the
    # region bridge and by every peer's `site_endpoints`.
    site_id: str = "site-a"

    # site → PUBLIC base URL, comma-separated: "site-a=https://a...,site-b=https://b..."
    #
    # Explicit configuration rather than anything derived from an event, because
    # these addresses are where a user's BROWSER is sent. A redirect target
    # taken from a peer's message would be an open redirect with a routing
    # decision's name on it.
    site_endpoints: str = ""

    # Placement candidates, nearest-first, for requests with no geographic hint.
    # Empty means "this site only", which is the correct single-site behaviour.
    placement_candidates: str = ""

    # This site's HARD storage ceiling. Placement refuses to assign anywhere once
    # the emptiest site reaches its own ceiling — that is a provisioning event,
    # not a routing decision, and it pages rather than silently overfilling a
    # disk. 100,000 GB is the worked example from the design.
    site_storage_ceiling_gb: int = 100_000

    # How often this site publishes its storage position to its peers, and how
    # long a peer's last report stays usable. A site that has gone quiet for
    # longer than the second number is treated as UNKNOWN by placement rather
    # than as its last cheerful value — a stale "40% full" is how new orgs get
    # routed into a site that died an hour ago.
    site_capacity_report_seconds: int = 60
    site_capacity_max_age_seconds: int = 900

    # Optional outbound webhook for capacity alerts (Slack/PagerDuty). Empty
    # means log-only, which is not silent: every alert is written at ERROR with
    # a structured payload, and that log line is the record. The webhook is the
    # convenience on top of it — see routing/notify.py.
    ops_alert_webhook_url: str = ""

    @property
    def site_endpoint_map(self) -> dict[str, str]:
        """Parsed `site_endpoints`. Malformed entries are dropped rather than
        fatal: a missing endpoint degrades one site's redirects to a retryable
        503, while refusing to boot takes out the site that is still healthy."""
        out: dict[str, str] = {}
        for part in self.site_endpoints.split(","):
            name, sep, url = part.partition("=")
            if sep and name.strip() and url.strip():
                out[name.strip()] = url.strip()
        return out

    @property
    def captcha_exempt_platform_set(self) -> frozenset[str]:
        return frozenset(
            s.strip().lower() for s in self.captcha_exempt_platforms.split(",") if s.strip()
        )

    @property
    def placement_candidate_list(self) -> list[str]:
        return [s.strip() for s in self.placement_candidates.split(",") if s.strip()]

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
