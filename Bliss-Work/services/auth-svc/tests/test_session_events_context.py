"""`meta` on an audit row is the ONLY place Phase 9's ip/user-agent/request-id/
session-id context lives (see docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 9) —
audit_log gained no new bare columns, so this dict IS the schema, and
`context_meta` is the one place that builds it.

The design decision under test: omit a field the caller didn't have (a
request-less internal call, or a request missing a header) rather than write
a null placeholder. That matters beyond tidiness — `verify_audit_chain`
recomputes the entry hash from `meta_json` verbatim, so "the key is absent"
and "the key is present with value null" are different bytes forever, and
whichever one a given code path produces is permanent for every row it wrote.
"""
from __future__ import annotations

from app.routes.session_events import context_meta


def test_no_context_produces_an_empty_dict() -> None:
    assert context_meta() == {}


def test_all_none_produces_an_empty_dict_not_nulls() -> None:
    assert context_meta(session_id=None, ip=None, user_agent=None, request_id=None) == {}


def test_full_context_includes_every_field() -> None:
    meta = context_meta(
        session_id="fam-1", ip="203.0.113.9", user_agent="Mozilla/5.0", request_id="req-1"
    )
    assert meta == {
        "sessionId": "fam-1",
        "ip": "203.0.113.9",
        "userAgent": "Mozilla/5.0",
        "requestId": "req-1",
    }


def test_partial_context_omits_only_the_missing_fields() -> None:
    meta = context_meta(ip="203.0.113.9", user_agent=None, request_id="req-1")
    assert meta == {"ip": "203.0.113.9", "requestId": "req-1"}


def test_extra_fields_merge_alongside_context() -> None:
    """org_switched adds `from`; login_failed adds `identityId` — both ride
    through **extra rather than a bespoke dict built at each call site."""
    meta = context_meta(ip="203.0.113.9", **{"from": "org-a"})
    assert meta == {"ip": "203.0.113.9", "from": "org-a"}
