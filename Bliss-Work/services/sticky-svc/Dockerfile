# ── Build stage: install dependencies into a venv ────────────────────────────
FROM python:3.13-slim@sha256:2b7445fb71ca9cb15e9aab053fe8cb3162796f8e1d92ada12a49c766a811bc1e AS build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# ── BUILD CONTEXT IS THE REPOSITORY ROOT, not services/sticky-svc ───────────
# requirements.txt points at sibling packages as local path requirements:
# services/shared/kafka_security (Kafka SASL/TLS config), services/shared/tracing
# (OTel Kafka context-propagation + shutdown helpers),
# services/shared/internal_auth (constant-time internal-secret comparison, used
# by GET /internal/pins/undelivered), services/shared/logging_setup
# (structlog -> stdout JSON) and services/shared/org_purge_tables (the
# org.deleted purge loop). The build needs every one of these directories:
#
#     docker build -f services/sticky-svc/Dockerfile .
#
# .dockerignore at the repo root keeps that context to roughly source size.
#
# Note there is no services/shared/crypto here, unlike task-svc: this service
# stores task IDs and lifecycle only, never a title or description, so it has
# no at-rest column encryption to do.
WORKDIR /src

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY services/sticky-svc/requirements.txt services/sticky-svc/requirements.txt
COPY services/shared/kafka_security services/shared/kafka_security
COPY services/shared/tracing services/shared/tracing
COPY services/shared/internal_auth services/shared/internal_auth
COPY services/shared/logging_setup services/shared/logging_setup
COPY services/shared/org_purge_tables services/shared/org_purge_tables
COPY services/shared/client_ip services/shared/client_ip
COPY services/shared/resilience services/shared/resilience
WORKDIR /src/services/sticky-svc
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
COPY services/sticky-svc/app ./app
COPY services/sticky-svc/migrations ./migrations

RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 8008

# Liveness/readiness probe — uses the in-image Python interpreter (no extra deps).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8008/readyz').status==200 else 1)"]

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

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8008 --proxy-headers --forwarded-allow-ips \"$FORWARDED_ALLOW_IPS\""]
