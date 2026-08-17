"""Kafka connection security, read from the environment.

Why this exists
---------------
Every Kafka client in this repository was built from ``KAFKA_BROKERS`` and
nothing else, which works exactly as long as the broker is the unauthenticated
one that ships in docker-compose. Every managed Kafka — Confluent Cloud, MSK,
Aiven, Redpanda Cloud — requires SASL over TLS, so moving off the bundled broker
was a CODE change at every producer and consumer, discovered during the cutover
rather than before it. This is that change, made ahead of time so the migration
is a matter of setting variables.

The Go services carry the same contract in ``internal/kafkaauth``; the variable
names are identical on purpose, so one set of deployment values configures the
whole platform.

Fail loudly, not open
---------------------
A half-configured client that quietly fell back to plaintext would connect to
nothing in production and, worse, might connect to a plaintext listener
somewhere else. A protocol that names SASL with no credentials therefore raises
at startup rather than degrading.

Not supported
-------------
AWS MSK's IAM authentication, which needs a separate signer and the AWS
credential chain. SCRAM-SHA-512 is available on MSK and is what this targets.
"""

from __future__ import annotations

import os
import ssl
from typing import Any

PLAINTEXT = "PLAINTEXT"
SSL_ONLY = "SSL"
SASL_PLAINTEXT = "SASL_PLAINTEXT"
SASL_SSL = "SASL_SSL"

_PROTOCOLS = (PLAINTEXT, SSL_ONLY, SASL_PLAINTEXT, SASL_SSL)
# aiokafka spells these exactly as the Kafka ecosystem does, so an operator can
# copy the value out of their provider's console unchanged.
_MECHANISMS = ("PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512")


class KafkaSecurityError(RuntimeError):
    """Raised for a Kafka security configuration that cannot be honoured."""


def _protocol() -> str:
    proto = os.getenv("KAFKA_SECURITY_PROTOCOL", "").strip().upper() or PLAINTEXT
    if proto not in _PROTOCOLS:
        raise KafkaSecurityError(
            f"KAFKA_SECURITY_PROTOCOL={proto!r}; want one of {', '.join(_PROTOCOLS)}"
        )
    return proto


def _ssl_context() -> ssl.SSLContext:
    """Validate against the system roots unless a CA bundle is named."""
    ca = os.getenv("KAFKA_SSL_CA_LOCATION", "").strip()
    try:
        return ssl.create_default_context(cafile=ca or None)
    except OSError as exc:  # unreadable or malformed bundle
        raise KafkaSecurityError(f"KAFKA_SSL_CA_LOCATION {ca}: {exc}") from exc


def _sasl_kwargs() -> dict[str, Any]:
    user = os.getenv("KAFKA_SASL_USERNAME", "")
    password = os.getenv("KAFKA_SASL_PASSWORD", "")
    if not user or not password:
        raise KafkaSecurityError(
            "KAFKA_SECURITY_PROTOCOL requests SASL but KAFKA_SASL_USERNAME/"
            "KAFKA_SASL_PASSWORD are not both set"
        )
    # PLAIN is what most hosted brokers hand you in their quick-start, so it is
    # the least surprising default.
    mechanism = os.getenv("KAFKA_SASL_MECHANISM", "").strip().upper() or "PLAIN"
    if mechanism not in _MECHANISMS:
        raise KafkaSecurityError(
            f"KAFKA_SASL_MECHANISM={mechanism!r}; want one of {', '.join(_MECHANISMS)}"
        )
    return {
        "sasl_mechanism": mechanism,
        "sasl_plain_username": user,
        "sasl_plain_password": password,
    }


def kafka_security_kwargs() -> dict[str, Any]:
    """Keyword arguments to splat into AIOKafkaProducer / AIOKafkaConsumer.

    Returns an EMPTY dict for a plaintext broker, so an unconfigured deployment
    constructs its clients exactly as it did before this function existed.
    """
    proto = _protocol()
    if proto == PLAINTEXT:
        # Credentials are deliberately not read here. A leftover password from a
        # previous deployment must not make a plaintext broker look
        # authenticated.
        return {}

    kwargs: dict[str, Any] = {"security_protocol": proto}
    if proto in (SSL_ONLY, SASL_SSL):
        kwargs["ssl_context"] = _ssl_context()
    if proto in (SASL_SSL, SASL_PLAINTEXT):
        # SASL_PLAINTEXT authenticates without encrypting — legitimate inside a
        # network with its own transport security, a mistake anywhere else.
        kwargs.update(_sasl_kwargs())
    return kwargs


def validate_kafka_security() -> str:
    """Check the configuration at startup and return the protocol in use.

    Call this before building any client, so a deployment mistake stops the
    process instead of surfacing later as an unexplained connection failure.
    """
    kafka_security_kwargs()
    return _protocol()
