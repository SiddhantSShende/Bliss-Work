"""Request/response models. Mirrors the zod DTOs in packages/shared."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

PresenceState = Literal["online", "idle", "offline"]
Source = Literal["server", "web", "desktop", "extension"]


# ── Ingest ────────────────────────────────────────────────────────────────────
class BeaconEvent(BaseModel):
    """One client-reported activity event.

    Every field a client can set is bounded here. This endpoint is the only
    unauthenticated-by-content write path in the product — the JWT proves WHO is
    writing, but not that what they write is true — so nothing arrives unbounded
    and nothing arrives un-clamped.
    """

    action: str = Field(min_length=1, max_length=64)
    category: str = Field(default="navigation", max_length=32)
    occurredAt: str | None = Field(default=None, max_length=40)
    surface: str | None = Field(default=None, max_length=32)
    targetKind: str | None = Field(default=None, max_length=32)
    targetId: str | None = Field(default=None, max_length=128)
    durationMs: int | None = Field(default=None, ge=0, le=86_400_000)
    # Encrypted at rest. Bounded hard: this is the one free-form field, and an
    # unbounded one would let a client turn the telemetry store into free
    # storage — or into a place to park data that outlives its own retention.
    detail: dict[str, str] | None = None


class Beacon(BaseModel):
    """A batch flushed by one client instance.

    Batched rather than per-event because a beacon fires on every route change
    and every 60s heartbeat; one request per event would multiply request volume
    by an order of magnitude for no extra information.
    """

    sessionId: str | None = Field(default=None, max_length=64)
    source: Literal["web", "desktop"] = "web"
    activeMs: int = Field(default=0, ge=0, le=86_400_000)
    idleMs: int = Field(default=0, ge=0, le=86_400_000)
    # Set on the last flush of a session (pagehide / explicit sign-out) so the
    # session closes precisely instead of waiting for the sweeper.
    ended: bool = False
    events: list[BeaconEvent] = Field(default_factory=list, max_length=100)


class BeaconAck(BaseModel):
    sessionId: str
    accepted: int


class AgentEvent(BaseModel):
    """One span reported by a paired agent (desktop sampler / browser extension).

    `targetId` is the AGGREGATABLE half — an application's display name, or a
    registrable domain — and is stored in the clear because every rollup groups
    by it. Anything revealing (a URL path) belongs in `detail`, which is
    encrypted per-org and only ever read one row at a time.
    """

    action: str = Field(min_length=1, max_length=64)
    category: str = Field(default="app", max_length=32)
    occurredAt: str | None = Field(default=None, max_length=40)
    targetKind: str | None = Field(default=None, max_length=32)
    targetId: str | None = Field(default=None, max_length=253)  # max DNS name length
    durationMs: int | None = Field(default=None, ge=0, le=86_400_000)
    detail: dict[str, str] | None = None


class AgentBatch(BaseModel):
    events: list[AgentEvent] = Field(default_factory=list, max_length=200)


class AgentTokenCreated(BaseModel):
    """The ONLY response that ever carries the raw secret. Not recoverable."""

    id: str
    kind: str
    token: str


class AgentTokenDTO(BaseModel):
    id: str
    kind: str
    label: str = ""
    createdAt: str | None = None
    lastUsedAt: str | None = None
    expiresAt: str | None = None


# ── Read models ───────────────────────────────────────────────────────────────
class MemberActivityDTO(BaseModel):
    """One row of the admin roster: is this person here, and how much today."""

    userId: str
    state: PresenceState
    lastSeenAt: str | None = None
    lastLoginAt: str | None = None
    lastLogoutAt: str | None = None
    todayActiveMs: int = 0
    last7dActiveMs: int = 0
    sessionsToday: int = 0


class TimelineEntry(BaseModel):
    id: str
    occurredAt: str
    source: Source
    category: str
    action: str
    surface: str | None = None
    targetKind: str | None = None
    targetId: str | None = None
    durationMs: int | None = None
    detail: dict[str, str] | None = None


class TimelinePage(BaseModel):
    entries: list[TimelineEntry]
    nextCursor: str | None = None


class SessionDTO(BaseModel):
    id: str
    source: str
    deviceLabel: str
    startedAt: str
    lastSeenAt: str
    endedAt: str | None = None
    endReason: str | None = None
    activeMs: int = 0
    idleMs: int = 0
    ipPrefix: str | None = None


class SessionPage(BaseModel):
    sessions: list[SessionDTO]
    nextCursor: str | None = None


class DayBucket(BaseModel):
    day: str
    activeMs: int = 0
    idleMs: int = 0
    onlineMs: int = 0
    sessions: int = 0
    events: int = 0


class NamedCount(BaseModel):
    key: str
    label: str = ""
    valueMs: int = 0
    count: int = 0


class SummaryDTO(BaseModel):
    userId: str
    from_: str = Field(alias="from")
    to: str
    totalActiveMs: int = 0
    totalIdleMs: int = 0
    totalOnlineMs: int = 0
    sessions: int = 0
    events: int = 0
    days: list[DayBucket] = Field(default_factory=list)
    bySurface: list[NamedCount] = Field(default_factory=list)
    byAction: list[NamedCount] = Field(default_factory=list)
    topApps: list[NamedCount] = Field(default_factory=list)
    topSites: list[NamedCount] = Field(default_factory=list)
    # 7 x 24 grid of active ms, Monday-first, in the rollup timezone.
    hourly: list[list[int]] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class OrgSummaryDTO(BaseModel):
    from_: str = Field(alias="from")
    to: str
    members: list[SummaryDTO] = Field(default_factory=list)
    days: list[DayBucket] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class ExportRow(BaseModel):
    """One flat row for the .xlsx export. Names are resolved client-side from the
    directory — this service holds no names."""

    userId: str
    day: str
    activeMs: int = 0
    idleMs: int = 0
    onlineMs: int = 0
    sessions: int = 0
    events: int = 0
    firstSeenAt: str | None = None
    lastSeenAt: str | None = None
    topSurface: str | None = None
    topApp: str | None = None
    topSite: str | None = None
