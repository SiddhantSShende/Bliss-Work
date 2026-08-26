"""The OTLP ingest bridge: OpenTelemetry Collector -> the SAME activity model
every other producer already writes through.

Architecture this route exists for:

    Activity Sensors -> OTLP -> OTel Collector -> THIS ROUTE -> activity_events

The collector (infra/observability/otel-collector.yaml, `logs/activity`
pipeline) receives OTLP log records from activity producers, filters them
away from the ordinary service-logs pipeline, batches them, and exports them
here as an `ExportLogsServiceRequest` JSON body. This route's ONLY job is to
unwrap that OTLP envelope back into the exact same `ActivityRow` shape
routes/agent.py already builds from an `AgentEvent`, and hand it to the exact
same `insert_events`/`sessionize_inserted` pair — so there is one activity
schema and one write path, and the collector has changed nothing about either.

── Why this is not a second activity schema ─────────────────────────────────
`ActivityRow`, `insert_events`, `sessionize_inserted`, `activity_events`,
`activity_sessions` — all unchanged, all imported directly from ingest.py /
sessionizer.py. otlp_logs.py (loaded by this route) only turns OTLP JSON into
plain Python values; it has no opinion about what an activity row is. Turning
those values into an ActivityRow happens ONLY here, in `_to_activity_row`,
which is a deliberately close mirror of routes/agent.py's own row-building
loop — same category clamp, same clock clamp, same detail handling.

── Auth: identical to routes/agent.py, just carried differently ─────────────
The collector's `headers_setter` extension re-attaches the ORIGINAL caller's
`X-Ingest-Token` to the export request (see the collector config's own
comment on why this is NOT paired with a persistent send queue). This route
therefore authenticates EXACTLY like `/telemetry/ingest/agent` — same
token-hash lookup against `ingest_tokens`, same org/user resolution from the
token's own row, same uniform 401. Web-beacon (JWT) events arriving via OTLP
are a natural extension of this same pattern but are not wired yet — the
collector config today only forwards X-Ingest-Token, and this route matches
that scope rather than half-implementing a second auth path nothing exports to.

── Failure behavior ──────────────────────────────────────────────────────────
A malformed OTLP envelope, or a batch where every record fails to parse,
returns 202 with `accepted: 0` rather than 400 — matching the collector
exporter's own retry semantics: a 4xx tells otlphttp/activity the export was
REJECTED and worth retrying, which would spin forever on a genuinely
malformed batch. A 202 says "received, some or none of it usable" and lets
the collector move on, the same posture insert_events already takes toward
individual bad rows within an otherwise-good batch.
"""
from __future__ import annotations

import gzip
import hashlib
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException, Request, Response, status

from ..db import session, set_bypass_rls
from ..ingest import ActivityRow, clamp_occurred_at, insert_events
from ..logging_setup import log
from ..otlp_logs import ParsedLogRecord, parse_export_logs_request
from ..rate_limit import limiter
from ..sessionizer import sessionize_inserted
from sqlalchemy import text

router = APIRouter(prefix="/telemetry", tags=["otlp"])

# Mirrors routes/agent.py's _AGENT_CATEGORIES exactly — an OTLP-delivered
# event is held to the same claim boundary as one delivered over REST. 'web'
# source events are not accepted here yet (see module docstring), so
# navigation/engagement are not in this set the way they are in
# routes/ingest.py's _CLIENT_CATEGORIES.
_AGENT_CATEGORIES = {"app", "site", "system"}

# The resource attribute the collector's filter processors split the OTLP
# logs stream on (see otel-collector.yaml's filter/activity_only /
# filter/infra_logs_only). Read here only for a sanity check + metric, never
# to decide whether to accept a record — the collector has ALREADY done that
# filtering; a record reaching this route regardless is still processed.
_SIGNAL_ATTR = "blisswork.signal"
# Which sensor produced the record — the piece of resource-level context that
# answers requirement 5 (web / desktop / extension, distinguishable). Mirrors
# the `source` a paired agent's token.kind already determines for the REST
# path; here it travels as an attribute because OTLP resources ARE how OTLP
# expresses "what produced this telemetry" (service.name and friends), so
# this reuses that mechanism rather than inventing a body field for it.
_SOURCE_ATTR = "blisswork.source"
_VALID_SOURCES = {"web", "desktop", "extension"}


def _hash(raw: str) -> bytes:
    return hashlib.sha256(raw.encode("utf-8")).digest()


@router.post("/otlp/logs", status_code=status.HTTP_202_ACCEPTED)
@limiter.limit("60/minute")
async def ingest_otlp_logs(
    request: Request,
    response: Response,  # required by slowapi (headers_enabled) to inject rate-limit headers
    x_ingest_token: str | None = Header(default=None, alias="X-Ingest-Token"),
) -> dict[str, int]:
    """Accept one `ExportLogsServiceRequest` (OTLP/HTTP JSON) from the
    collector's otlphttp/activity exporter.

    Reads the RAW body rather than declaring a `body: dict` parameter:
    the otlphttp exporter gzip-compresses by default (confirmed against a
    live collector while validating this route — an undeclared `body: dict`
    handed Starlette's JSON parser raw gzip bytes and every export 400'd), and
    Starlette does not auto-decompress a request body the way a reverse proxy
    might. `Content-Encoding: gzip` is the only encoding handled — anything
    else is read as plain JSON, which covers `encoding: json` with
    `compression: none` too, should a deployment choose that instead.

    Parsed into a plain dict, not a typed Pydantic model of the full OTLP
    envelope: the envelope has many fields this route does not use (spanId,
    traceId, flags, schemaUrl, scope version...) and validating all of them
    would couple this route to OTLP's full schema for no benefit — the
    fields that matter are picked out by otlp_logs.py, and anything else is
    silently ignored, the same tolerance AgentEvent already extends to a
    detail bag with unrecognised keys.
    """
    if not x_ingest_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing agent token")

    raw = await request.body()
    if request.headers.get("content-encoding", "").lower() == "gzip":
        try:
            raw = gzip.decompress(raw)
        except OSError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid gzip body") from exc
    try:
        body = json.loads(raw) if raw else {}
    except (TypeError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid JSON body") from exc
    if not isinstance(body, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "body must be an ExportLogsServiceRequest object")

    now = datetime.now(timezone.utc)
    records = parse_export_logs_request(body)

    async with session() as db:
        # Pre-org-context: identical reasoning to routes/agent.py — the token
        # is looked up by hash before the org is known. Checked BEFORE the
        # empty-records short-circuit below: an invalid token must 401
        # regardless of what the body contains, the same as routes/agent.py
        # authenticates an empty batch rather than waving it through.
        await set_bypass_rls(db)
        token_row = (
            await db.execute(
                text(
                    "SELECT id, org_id, user_id, kind FROM ingest_tokens "
                    "WHERE token_hash = :h AND revoked_at IS NULL AND expires_at > now()"
                ),
                {"h": _hash(x_ingest_token)},
            )
        ).first()
        if token_row is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid agent token")

        if not records:
            return {"accepted": 0}

        org_id, user_id = str(token_row.org_id), str(token_row.user_id)
        token_source = "desktop" if token_row.kind == "desktop" else "extension"

        rows = [
            row for record in records
            if (row := _to_activity_row(record, org_id, user_id, token_source, now)) is not None
        ]
        inserted = await insert_events(db, rows)
        await sessionize_inserted(db, inserted)
        await db.execute(
            text("UPDATE ingest_tokens SET last_used_at = now() WHERE id = :id"),
            {"id": str(token_row.id)},
        )
        await db.commit()

    if len(inserted) != len(records):
        log.info(
            "otlp_logs_partial_accept",
            received=len(records), accepted=len(inserted), user_id=user_id,
        )
    return {"accepted": len(inserted)}


def _to_activity_row(
    record: ParsedLogRecord, org_id: str, user_id: str, token_source: str, now: datetime,
) -> ActivityRow | None:
    """One OTLP log record -> one ActivityRow, mirroring routes/agent.py's
    per-event construction.

    `token_source` — desktop/extension from the ingest token, the SAME
    provenance the REST path trusts — is the source of truth for `source`,
    not the record's own `blisswork.source` resource attribute. A resource
    attribute is client-asserted data traveling through infrastructure the
    client does not control the trust boundary of; the pairing token is what
    actually proves who is allowed to write this row, exactly as
    routes/agent.py's own comment on why org/user come from the token and
    never the payload. `blisswork.source` is read only to confirm the record
    is one this route should handle at all (see the source-mismatch guard
    below) — it enriches nothing security-relevant.
    """
    source_attr = record.resource_attributes.get(_SOURCE_ATTR)
    if source_attr is not None and source_attr not in _VALID_SOURCES:
        return None  # a producer asserting something outside the known set

    body = record.body
    action = body.get("action")
    if not isinstance(action, str) or not action:
        return None

    category = body.get("category")
    if not isinstance(category, str) or category not in _AGENT_CATEGORIES:
        category = "app"

    detail = body.get("detail")
    detail = {str(k): str(v) for k, v in detail.items()} if isinstance(detail, dict) else {}

    duration_ms = body.get("durationMs")
    duration_ms = int(duration_ms) if isinstance(duration_ms, (int, float)) else None

    return ActivityRow(
        org_id=org_id,
        user_id=user_id,
        occurred_at=clamp_occurred_at(record.occurred_at, now),
        source=token_source,
        category=category,
        action=action,
        target_kind=_str_or_none(body.get("targetKind")),
        target_id=_str_or_none(body.get("targetId")),
        duration_ms=duration_ms,
        detail=detail,
        client_event_id=_str_or_none(body.get("clientEventId")),
    )


def _str_or_none(value: object) -> str | None:
    return value if isinstance(value, str) and value else None
