"""Unit tests for ``kafka_security``.

This module decides whether every Kafka client in the service authenticates and
encrypts, so its contract is load-bearing in a specific way: the dangerous
failure is not an exception, it is a client that quietly connects in plaintext
while the deployment believes it is using SASL. These tests pin the boundary
between "configured" and "refuse to start".

Pure-logic: no Kafka, no network, no heavy imports — ``kafka_security`` depends
only on ``os`` and ``ssl``, unlike the modules that consume it.
"""
from __future__ import annotations

import pytest

from kafka_security import (
    KafkaSecurityError,
    kafka_security_kwargs,
    validate_kafka_security,
)

# Every variable this module reads. Cleared before each case so a value leaking
# in from the developer's shell cannot make a test pass for the wrong reason.
_VARS = (
    "KAFKA_SECURITY_PROTOCOL",
    "KAFKA_SASL_MECHANISM",
    "KAFKA_SASL_USERNAME",
    "KAFKA_SASL_PASSWORD",
    "KAFKA_SSL_CA_LOCATION",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _VARS:
        monkeypatch.delenv(name, raising=False)


def test_unset_env_changes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """An unconfigured deployment must build its clients exactly as before.

    Credentials are set here and must be IGNORED: a leftover password from a
    previous deployment must not make a plaintext broker look authenticated.
    """
    monkeypatch.setenv("KAFKA_SASL_USERNAME", "leftover")
    monkeypatch.setenv("KAFKA_SASL_PASSWORD", "leftover")

    assert kafka_security_kwargs() == {}
    assert validate_kafka_security() == "PLAINTEXT"


@pytest.mark.parametrize("protocol", ["SASL_SSL", "SASL_PLAINTEXT"])
def test_sasl_without_credentials_refuses_to_start(
    monkeypatch: pytest.MonkeyPatch, protocol: str
) -> None:
    """The failure this module exists to prevent.

    Silently falling back to plaintext here would mean a deployment that
    believes it is authenticated and is not.
    """
    monkeypatch.setenv("KAFKA_SECURITY_PROTOCOL", protocol)
    with pytest.raises(KafkaSecurityError):
        kafka_security_kwargs()


def test_username_without_password_is_also_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
    monkeypatch.setenv("KAFKA_SASL_USERNAME", "u")
    with pytest.raises(KafkaSecurityError):
        kafka_security_kwargs()


@pytest.mark.parametrize(
    "mechanism,expected",
    [
        ("", "PLAIN"),  # default
        ("PLAIN", "PLAIN"),
        ("SCRAM-SHA-256", "SCRAM-SHA-256"),
        ("SCRAM-SHA-512", "SCRAM-SHA-512"),
    ],
)
def test_sasl_ssl_builds_credentials_and_tls(
    monkeypatch: pytest.MonkeyPatch, mechanism: str, expected: str
) -> None:
    monkeypatch.setenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
    if mechanism:
        monkeypatch.setenv("KAFKA_SASL_MECHANISM", mechanism)
    monkeypatch.setenv("KAFKA_SASL_USERNAME", "user")
    monkeypatch.setenv("KAFKA_SASL_PASSWORD", "pass")

    kwargs = kafka_security_kwargs()
    assert kwargs["security_protocol"] == "SASL_SSL"
    assert kwargs["sasl_mechanism"] == expected
    assert kwargs["sasl_plain_username"] == "user"
    assert kwargs["sasl_plain_password"] == "pass"
    # Without this the password crosses the network in the clear.
    assert kwargs["ssl_context"] is not None


def test_sasl_plaintext_authenticates_without_tls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Legitimate inside a network with its own transport security.

    It must be expressible, and it must not silently acquire a TLS context —
    an operator who chose it should get what they asked for.
    """
    monkeypatch.setenv("KAFKA_SECURITY_PROTOCOL", "SASL_PLAINTEXT")
    monkeypatch.setenv("KAFKA_SASL_USERNAME", "u")
    monkeypatch.setenv("KAFKA_SASL_PASSWORD", "p")

    kwargs = kafka_security_kwargs()
    assert kwargs["security_protocol"] == "SASL_PLAINTEXT"
    assert "sasl_plain_username" in kwargs
    assert "ssl_context" not in kwargs


@pytest.mark.parametrize(
    "var,value,must_mention",
    [
        ("KAFKA_SECURITY_PROTOCOL", "SASL-SSL", "SASL_SSL"),  # hyphen, not underscore
        ("KAFKA_SASL_MECHANISM", "SCRAM-SHA512", "SCRAM-SHA-512"),  # missing hyphen
    ],
)
def test_typos_are_rejected_and_named(
    monkeypatch: pytest.MonkeyPatch, var: str, value: str, must_mention: str
) -> None:
    """A typo must stop the process with a message that says what was wanted.

    Otherwise it arrives as "cannot reach broker" hours into a migration.
    """
    monkeypatch.setenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
    monkeypatch.setenv("KAFKA_SASL_USERNAME", "u")
    monkeypatch.setenv("KAFKA_SASL_PASSWORD", "p")
    monkeypatch.setenv(var, value)

    with pytest.raises(KafkaSecurityError) as excinfo:
        kafka_security_kwargs()
    assert must_mention in str(excinfo.value)


def test_values_are_case_and_whitespace_insensitive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """These arrive from a .env file or a Helm value, where padding is invisible."""
    monkeypatch.setenv("KAFKA_SECURITY_PROTOCOL", "  sasl_ssl ")
    monkeypatch.setenv("KAFKA_SASL_MECHANISM", " scram-sha-512 ")
    monkeypatch.setenv("KAFKA_SASL_USERNAME", "u")
    monkeypatch.setenv("KAFKA_SASL_PASSWORD", "p")

    kwargs = kafka_security_kwargs()
    assert kwargs["security_protocol"] == "SASL_SSL"
    assert kwargs["sasl_mechanism"] == "SCRAM-SHA-512"


def test_unreadable_ca_bundle_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Naming a CA means the system roots will not do, so falling back is wrong."""
    monkeypatch.setenv("KAFKA_SECURITY_PROTOCOL", "SSL")
    monkeypatch.setenv("KAFKA_SSL_CA_LOCATION", "/nonexistent/ca.pem")
    with pytest.raises(KafkaSecurityError):
        kafka_security_kwargs()
