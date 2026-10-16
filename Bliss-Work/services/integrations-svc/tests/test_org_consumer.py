from __future__ import annotations

import json

from app import org_consumer


async def test_invalid_org_deleted_id_is_skipped_as_poison(monkeypatch):
    purged: list[str] = []

    async def fake_purge(org_id: str) -> None:
        purged.append(org_id)

    monkeypatch.setattr(org_consumer, "purge_org", fake_purge)
    await org_consumer.OrgLifecycleConsumer()._handle(
        json.dumps({"type": "org.deleted", "orgId": "not-a-uuid"}).encode()
    )
    assert purged == []


async def test_valid_org_deleted_id_is_normalized_before_purge(monkeypatch):
    purged: list[str] = []

    async def fake_purge(org_id: str) -> None:
        purged.append(org_id)

    monkeypatch.setattr(org_consumer, "purge_org", fake_purge)
    await org_consumer.OrgLifecycleConsumer()._handle(
        json.dumps(
            {"type": "org.deleted", "orgId": "11111111111111111111111111111111"}
        ).encode()
    )
    assert purged == ["11111111-1111-1111-1111-111111111111"]


def test_org_purge_table_set_includes_all_send_attempt_rows():
    assert "message_send_attempts" in org_consumer._TABLES
