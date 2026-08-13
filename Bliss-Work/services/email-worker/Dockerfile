# syntax=docker/dockerfile:1

# ── Build stage: install deps into a venv ─────────────────────────────────────
FROM python:3.13-slim@sha256:2b7445fb71ca9cb15e9aab053fe8cb3162796f8e1d92ada12a49c766a811bc1e AS build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

RUN python -m venv "$VIRTUAL_ENV"

WORKDIR /app
COPY requirements.txt ./
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
COPY app ./app
# Bundle the SQL migrations so _apply_migrations() can create the worker's own
# emaildb tables on startup (resolves to /app/migrations).
COPY migrations ./migrations

# Own the app dir, then drop privileges.
RUN chown -R appuser:appuser /app

USER appuser

# No HEALTHCHECK: email-worker is a pure Kafka consumer with no HTTP server.

CMD ["python", "-m", "app"]
