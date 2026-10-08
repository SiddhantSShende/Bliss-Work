# syntax=docker/dockerfile:1

# ── Build stage: install deps into a venv ─────────────────────────────────────
FROM python:3.13-slim@sha256:2b7445fb71ca9cb15e9aab053fe8cb3162796f8e1d92ada12a49c766a811bc1e AS build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

RUN python -m venv "$VIRTUAL_ENV"

# ── BUILD CONTEXT IS THE REPOSITORY ROOT, not services/email-worker ─────────
# requirements.txt points at three sibling packages as local path requirements:
# services/shared/kafka_security (Kafka SASL/TLS config, also used by
# auth-svc, task-svc, integrations-svc and telemetry-svc),
# services/shared/tracing (OTel Kafka context-propagation + shutdown helpers,
# also used by all four), and services/shared/logging_setup (structlog ->
# stdout JSON bootstrap, also used by every other Python service). The build
# needs all three directories:
#
#     docker build -f services/email-worker/Dockerfile .
#
# .dockerignore at the repo root keeps that context to roughly source size.
WORKDIR /src
COPY services/email-worker/requirements.txt services/email-worker/requirements.txt
COPY services/shared/kafka_security services/shared/kafka_security
COPY services/shared/tracing services/shared/tracing
COPY services/shared/logging_setup services/shared/logging_setup
COPY services/shared/resilience services/shared/resilience
WORKDIR /src/services/email-worker
RUN pip install --upgrade pip && pip install -r requirements.txt

# ── Final stage: slim runtime with the prebuilt venv ──────────────────────────
FROM python:3.13-slim@sha256:2b7445fb71ca9cb15e9aab053fe8cb3162796f8e1d92ada12a49c766a811bc1e AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

# Non-root runtime user/group.
RUN useradd --system --create-home --uid 10001 --user-group appuser

COPY --from=build /opt/venv /opt/venv

WORKDIR /app
COPY services/email-worker/app ./app
# Bundle the SQL migrations so _apply_migrations() can create the worker's own
# emaildb tables on startup (resolves to /app/migrations).
COPY services/email-worker/migrations ./migrations

# Own the app dir, then drop privileges.
RUN chown -R appuser:appuser /app

USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["python", "-m", "app.healthcheck"]

CMD ["python", "-m", "app"]
