# syntax=docker/dockerfile:1

# ── Build stage: install deps into a venv ─────────────────────────────────────
FROM python:3.14-slim@sha256:b877e50bd90de10af8d82c57a022fc2e0dc731c5320d762a27986facfc3355c1 AS build

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
FROM python:3.14-slim@sha256:b877e50bd90de10af8d82c57a022fc2e0dc731c5320d762a27986facfc3355c1 AS runtime

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
