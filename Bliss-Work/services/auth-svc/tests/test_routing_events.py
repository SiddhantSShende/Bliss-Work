"""The routing event contract: what crosses the bridge, and how it is applied.

The bridge delivers at-least-once and can redeliver or reorder across a
partition boundary. These tests pin the two properties that make that safe:
every event round-trips, and `occurredAt` is a VERSION so a replay converges
instead of fighting.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.routing.events import (
    KEY_INVITE,
    KEY_ORG,
    TOPIC_ROUTING,
    CapacityReport,
    DirectoryUpsert,
    invite_key,
    parse,
    routing_revoked,
    routing_upserted,
    site_capacity_reported,
)

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)


def test_the_routing_topic_is_the_one_the_bridge_carries():
    # If these ever disagree the directory simply never replicates, and every
    # cross-site request answers "retry" forever — with nothing in any log to
    # say why. Kept in step with services/region-bridge defaultTopics.
    assert TOPIC_ROUTING == "routing.events.v1"


def test_an_org_placement_round_trips():
    event = routing_upserted(KEY_ORG, "org-1", "site-b")
    decoded = parse(event)
    assert isinstance(decoded, DirectoryUpsert)
    assert (decoded.key_type, decoded.key_value, decoded.home_site) == (KEY_ORG, "org-1", "site-b")
    assert decoded.expires_at is None  # orgs never expire
    assert decoded.revoked is False


def test_an_invite_placement_carries_its_expiry():
    expires = NOW + timedelta(hours=72)
    decoded = parse(routing_upserted(KEY_INVITE, "abc", "site-a", expires))
    assert isinstance(decoded, DirectoryUpsert)
    assert decoded.expires_at == expires


def test_a_revoke_names_no_site():
    # A revoke says only "this key no longer applies"; the stored row keeps
    # whichever home it had. Inventing one here would let a revoke silently move
    # an invite to a different site.
    decoded = parse(routing_revoked("abc", "expired"))
    assert isinstance(decoded, DirectoryUpsert)
    assert decoded.revoked is True
    assert decoded.home_site == ""
    assert decoded.key_type == KEY_INVITE


def test_a_capacity_report_round_trips():
    decoded = parse(site_capacity_reported("site-a", 42, 100))
    assert isinstance(decoded, CapacityReport)
    assert (decoded.site, decoded.used_bytes, decoded.ceiling_bytes) == ("site-a", 42, 100)


def test_routing_events_carry_no_org_id():
    # Every other event in the platform is org-scoped; these deliberately are
    # not. The directory answers "where does this key live?" BEFORE any org
    # context exists — that is what lets it serve an invite redemption that has
    # only a token hash — and an orgId field would be a lie on those rows.
    for event in (
        routing_upserted(KEY_ORG, "org-1", "site-b"),
        routing_revoked("abc", "expired"),
        site_capacity_reported("site-a", 1, 2),
    ):
        assert "orgId" not in event
        assert event["eventId"] and event["occurredAt"] and event["type"]


def test_an_unknown_event_type_is_ignored_rather_than_fatal():
    # The topic is bridged to every site, and a newer site may publish something
    # an older one has never heard of. Ignoring it keeps the older site
    # converging on everything else.
    assert parse({"type": "routing.something.new", "occurredAt": "2026-01-01T00:00:00Z"}) is None


def test_malformed_events_are_dropped_not_raised():
    for bad in (
        {},                                                        # no type
        {"type": "routing.upserted"},                              # no timestamp
        {"type": "routing.upserted", "occurredAt": "nonsense"},    # unparseable
        {"type": "routing.upserted", "occurredAt": "2026-01-01T00:00:00Z"},        # no key
        {"type": "routing.upserted", "occurredAt": "2026-01-01T00:00:00Z",
         "keyType": "user", "keyValue": "x", "homeSite": "s"},     # unknown key type
        {"type": "routing.upserted", "occurredAt": "2026-01-01T00:00:00Z",
         "keyType": "org", "keyValue": "x"},                       # no home site
        {"type": "site.capacity.reported", "occurredAt": "2026-01-01T00:00:00Z",
         "site": "a", "usedBytes": "lots", "ceilingBytes": 1},     # not a number
    ):
        assert parse(bad) is None, bad


def test_a_naive_timestamp_is_read_as_utc():
    # Two sites disagreeing about a timezone would make the version comparison
    # wrong by hours, which shows up as a newer event losing to an older one.
    decoded = parse(
        {"type": "routing.upserted", "occurredAt": "2026-01-01T12:00:00",
         "keyType": "org", "keyValue": "o", "homeSite": "s"}
    )
    assert isinstance(decoded, DirectoryUpsert)
    assert decoded.occurred_at == NOW


def test_the_invite_key_encoding_is_shared_by_both_sides():
    # The writer hashes and hex-encodes; the reader must do exactly the same.
    # Disagreeing would not raise anywhere — it would simply never find a row,
    # and every cross-site redemption would answer "retry" until expiry.
    raw = bytes(range(32))
    assert invite_key(raw) == raw.hex()
    assert len(invite_key(raw)) == 64
