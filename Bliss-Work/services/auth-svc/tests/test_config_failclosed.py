"""Fail-closed production config guard (``Settings._enforce_prod_safety``).

When ``TB_ENV=production`` the service MUST refuse to boot if any dev sentinel
remains (crypto keys, dev DB password, non-TLS DB, insecure cookie, missing
internal token, half-configured KMS). In dev/test (no ``TB_ENV``) the defaults are
fine and nothing is enforced. These are pure-logic checks against the real
production ``Settings`` model; skip cleanly if pydantic isn't installed locally.
"""
from __future__ import annotations

import pytest

config = pytest.importorskip(
    "app.config",
    reason="auth-svc deps (pydantic) not installed locally; CI installs requirements.txt.",
)
Settings = config.Settings
ValidationError = pytest.importorskip("pydantic").ValidationError

# A fully-valid production config (overridable per-case).
GOOD = dict(
    tb_env="production",
    data_master_passphrase="A" * 48,
    data_master_salt="B" * 24,
    data_blind_index_key="C" * 48,
    auth_database_url=(
        "postgresql://auth_user:realpw@postgres:5432/authdb"
        "?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.crt"
    ),
    cookie_secure=True,
)


def test_dev_mode_allows_defaults(monkeypatch):
    monkeypatch.delenv("AUTH_INTERNAL_TOKEN", raising=False)
    # No TB_ENV => development => dev defaults are accepted, no raise.
    Settings(tb_env="development")


def test_prod_good_config_passes(monkeypatch):
    monkeypatch.setenv("AUTH_INTERNAL_TOKEN", "t" * 32)
    Settings(**GOOD)  # must not raise


@pytest.mark.parametrize(
    "override",
    [
        {"data_master_passphrase": "dev-master-passphrase-change-me"},
        {"data_master_salt": "dev-master-salt-change-me-16+bytes"},
        {"data_blind_index_key": "dev-blind-index-key-change-me-32+bytes"},
        {"auth_database_url": "postgresql://taskboard:taskboard_dev_pw@postgres:5432/authdb?sslmode=verify-full"},
        {"auth_database_url": "postgresql://auth_user:realpw@postgres:5432/authdb"},  # no sslmode
        {"cookie_secure": False},
        {"data_kek_provider": "kms", "data_kms_key_id": ""},  # kms without key id
    ],
)
def test_prod_rejects_each_sentinel(monkeypatch, override):
    monkeypatch.setenv("AUTH_INTERNAL_TOKEN", "t" * 32)
    with pytest.raises(ValidationError):
        Settings(**{**GOOD, **override})


def test_prod_requires_internal_token(monkeypatch):
    monkeypatch.delenv("AUTH_INTERNAL_TOKEN", raising=False)
    with pytest.raises(ValidationError):
        Settings(**GOOD)


def test_prod_kms_happy_path(monkeypatch):
    monkeypatch.setenv("AUTH_INTERNAL_TOKEN", "t" * 32)
    Settings(
        **{
            **GOOD,
            "data_kek_provider": "kms",
            "data_kms_backend": "vault-transit",
            "data_kms_key_id": "taskboard-dek",
            "vault_addr": "https://vault:8200",
            "vault_token": "s.xxxx",
        }
    )
