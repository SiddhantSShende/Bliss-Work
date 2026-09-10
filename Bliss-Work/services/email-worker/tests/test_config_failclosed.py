"""Fail-closed production config guard for email-worker.

See auth-svc/tests/test_config_failclosed.py. email-worker has no envelope
crypto (it resolves identity via auth-svc), so its prod sentinels are: dev
internal tokens (now three distinct per-callee secrets — auth-svc,
messaging-svc, integrations-svc — see
docs/AUTH_AUTHZ_REMEDIATION_PLAN.md Phase 2), non-TLS / dev-credentialed
EMAIL_DATABASE_URL, an unset SMTP password on a real host, and a leftover
localhost WEB_ORIGIN (every notification email's CTA link is built from it,
so a missed override silently ships dead links to real users). Pure-logic;
skips if pydantic isn't installed locally.
"""
from __future__ import annotations

import pytest

config = pytest.importorskip(
    "app.config",
    reason="email-worker deps (pydantic) not installed locally; CI installs requirements.txt.",
)
Settings = config.Settings
ValidationError = pytest.importorskip("pydantic").ValidationError

GOOD = dict(
    tb_env="production",
    auth_internal_token="a" * 32,
    messaging_internal_token="m" * 32,
    integrations_internal_token="i" * 32,
    email_db_url=(
        "postgres://email_user:realpw@postgres:5432/emaildb"
        "?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.crt"
    ),
    smtp_host="smtp.gmail.com",
    smtp_password="app-password",
    web_origin="https://app.blisswork.example",
)


def test_dev_mode_allows_defaults():
    Settings(tb_env="development")


def test_prod_good_config_passes():
    Settings(**GOOD)


@pytest.mark.parametrize(
    "override",
    [
        {"auth_internal_token": "dev-internal-token"},
        {"auth_internal_token": ""},
        {"messaging_internal_token": "dev-internal-token"},
        {"messaging_internal_token": ""},
        {"integrations_internal_token": "dev-internal-token"},
        {"integrations_internal_token": ""},
        {"email_db_url": "postgres://email_user:realpw@postgres:5432/emaildb"},  # no sslmode
        {"email_db_url": "postgres://postgres:postgres@postgres:5432/emaildb?sslmode=verify-full"},
        {"smtp_host": "smtp.gmail.com", "smtp_password": "CHANGE_ME_smtp"},
        {"smtp_host": "smtp.gmail.com", "smtp_password": ""},
        {"web_origin": "http://localhost:5173"},  # the dev default, left unset
        {"web_origin": "http://localhost:5173/"},  # trailing slash doesn't hide it
        {"web_origin": ""},
    ],
)
def test_prod_rejects_each_sentinel(override):
    with pytest.raises(ValidationError):
        Settings(**{**GOOD, **override})
