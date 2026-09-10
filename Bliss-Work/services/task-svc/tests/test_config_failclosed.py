"""Fail-closed production config guard (``Settings._enforce_prod_safety``).

See auth-svc/tests/test_config_failclosed.py — same contract, task-svc fields.
``internal_token`` (this service's OWN /internal/* secret) is populated from
TASK_INTERNAL_TOKEN, and ``messaging_internal_token`` (used to call
messaging-svc) from MESSAGING_INTERNAL_TOKEN — two distinct per-callee secrets
since docs/AUTH_AUTHZ_REMEDIATION_PLAN.md Phase 2, so both are set via
monkeypatch rather than a kwarg. Pure-logic; skips cleanly if pydantic isn't
installed locally.
"""
from __future__ import annotations

import pytest

config = pytest.importorskip(
    "app.config",
    reason="task-svc deps (pydantic) not installed locally; CI installs requirements.txt.",
)
Settings = config.Settings
ValidationError = pytest.importorskip("pydantic").ValidationError

GOOD = dict(
    tb_env="production",
    data_master_passphrase="A" * 48,
    data_master_salt="B" * 24,
    data_blind_index_key="C" * 48,
    task_database_url=(
        "postgresql://task_user:realpw@postgres:5432/taskdb"
        "?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.crt"
    ),
)


def _set_both_internal_tokens(monkeypatch):
    monkeypatch.setenv("TASK_INTERNAL_TOKEN", "t" * 32)
    monkeypatch.setenv("MESSAGING_INTERNAL_TOKEN", "m" * 32)


def test_dev_mode_allows_defaults():
    Settings(tb_env="development")  # dev defaults accepted


def test_prod_good_config_passes(monkeypatch):
    _set_both_internal_tokens(monkeypatch)
    Settings(**GOOD)


@pytest.mark.parametrize(
    "override",
    [
        {"data_master_passphrase": "dev-master-passphrase-change-me"},
        {"data_master_salt": "dev-master-salt-change-me-16+bytes"},
        {"data_blind_index_key": "dev-blind-index-key-change-me-32+bytes"},
        {"task_database_url": "postgresql://taskboard:taskboard_dev_pw@postgres:5432/taskdb?sslmode=verify-full"},
        {"task_database_url": "postgresql://task_user:realpw@postgres:5432/taskdb"},  # no sslmode
        {"data_kek_provider": "kms", "data_kms_key_id": ""},
    ],
)
def test_prod_rejects_each_sentinel(monkeypatch, override):
    _set_both_internal_tokens(monkeypatch)
    with pytest.raises(ValidationError):
        Settings(**{**GOOD, **override})


def test_prod_requires_internal_token(monkeypatch):
    monkeypatch.setenv("MESSAGING_INTERNAL_TOKEN", "m" * 32)
    monkeypatch.delenv("TASK_INTERNAL_TOKEN", raising=False)
    with pytest.raises(ValidationError):
        Settings(**GOOD)


def test_prod_requires_messaging_internal_token(monkeypatch):
    monkeypatch.setenv("TASK_INTERNAL_TOKEN", "t" * 32)
    monkeypatch.delenv("MESSAGING_INTERNAL_TOKEN", raising=False)
    with pytest.raises(ValidationError):
        Settings(**GOOD)
