# ── Build stage: install dependencies into a venv ─────────────────────────────
FROM python:3.13-slim@sha256:2b7445fb71ca9cb15e9aab053fe8cb3162796f8e1d92ada12a49c766a811bc1e AS build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# ── BUILD CONTEXT IS THE REPOSITORY ROOT, not services/auth-svc ─────────────
# requirements.txt points at sibling packages as local path requirements:
# services/shared/kafka_security (Kafka SASL/TLS config, also used by
# task-svc, integrations-svc, telemetry-svc and email-worker),
# services/shared/crypto (at-rest column encryption, also used by task-svc,
# integrations-svc and telemetry-svc), services/shared/tracing (OTel Kafka
# context-propagation + shutdown helpers, also used by all four),
# services/shared/internal_auth (constant-time internal-service-secret
# comparison, also used by task-svc and integrations-svc),
# services/shared/prune_events (batched-delete retention runner, also used by
# task-svc and integrations-svc), services/shared/logging_setup (structlog ->
# stdout JSON bootstrap, also used by every other Python service), and
# services/shared/outbox_dlq (outbox dead-letter quarantine, also used by
# task-svc and integrations-svc). The build needs all of these directories:
#
#     docker build -f services/auth-svc/Dockerfile .
#
# .dockerignore at the repo root keeps that context to roughly source size.
WORKDIR /src

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY services/auth-svc/requirements.txt services/auth-svc/requirements.txt
COPY services/shared/kafka_security services/shared/kafka_security
COPY services/shared/crypto services/shared/crypto
COPY services/shared/tracing services/shared/tracing
COPY services/shared/internal_auth services/shared/internal_auth
COPY services/shared/prune_events services/shared/prune_events
COPY services/shared/logging_setup services/shared/logging_setup
COPY services/shared/outbox_dlq services/shared/outbox_dlq
COPY services/shared/client_ip services/shared/client_ip
COPY services/shared/resilience services/shared/resilience
COPY services/shared/kafka_lazy_producer services/shared/kafka_lazy_producer
WORKDIR /src/services/auth-svc
RUN pip install --upgrade pip && pip install -r requirements.txt

# ── Final stage: slim runtime with a Python interpreter (healthcheck needs it) ─
FROM python:3.13-slim@sha256:2b7445fb71ca9cb15e9aab053fe8cb3162796f8e1d92ada12a49c766a811bc1e AS final

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# Non-root runtime user/group; own the app dir.
RUN useradd --system --create-home --uid 10001 --user-group appuser

WORKDIR /app

COPY --from=build /opt/venv /opt/venv
COPY services/auth-svc/app ./app
COPY services/auth-svc/migrations ./migrations

RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 8001

# Liveness/readiness probe — uses the in-image Python interpreter (no extra deps).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8001/readyz').status==200 else 1)"]

# ── Trusting the reverse proxy ───────────────────────────────────────────────
# FORWARDED_ALLOW_IPS tells uvicorn which immediate peers may set X-Forwarded-*.
# Its default is 127.0.0.1, and our edge (Caddy) is a SEPARATE CONTAINER on the
# bridge network — so by default uvicorn never rewrote `request.client`, and
# every request in the world looked like it came from Caddy's address.
#
# Private ranges are the right value here because these services publish NO
# ports: the only thing that can open a connection to them is something already
# inside the compose network / cluster. It is NOT `*`, which would let any
# direct caller forge the header if the service were ever exposed.
#
# The application-layer controls no longer depend on this — app/net.py parses
# X-Forwarded-For itself with an explicit hop count — but it keeps
# `request.client.host` honest for logs, telemetry and anything added later.
ENV FORWARDED_ALLOW_IPS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8001 --proxy-headers --forwarded-allow-ips \"$FORWARDED_ALLOW_IPS\""]
