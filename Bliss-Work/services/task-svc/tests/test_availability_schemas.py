"""Availability roster DTO contract (pure-logic; no DB).

The hide/unhide endpoints take a raw user id straight into a SQL binding against
a `uuid` column, so a non-UUID string would surface as a Postgres cast error
(500) instead of a clean rejection. These pin the edge validation and the shape
the web client's zod schema mirrors.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas import AvailabilityCount, AvailabilityDTO, HideUserRequest

_UUID = "11111111-2222-3333-4444-555555555555"


def test_hide_user_request_accepts_a_uuid() -> None:
    assert HideUserRequest(userId=_UUID).userId == _UUID


@pytest.mark.parametrize("bad", ["", "not-a-uuid", "1234", "'; DROP TABLE tasks; --"])
def test_hide_user_request_rejects_non_uuid(bad: str) -> None:
    with pytest.raises(ValidationError):
        HideUserRequest(userId=bad)


def test_availability_dto_round_trips() -> None:
    dto = AvailabilityDTO(
        counts=[AvailabilityCount(userId=_UUID, acknowledged=2, pending=1)],
        hiddenUserIds=[_UUID],
        canManage=True,
    )
    dumped = dto.model_dump()
    assert dumped["counts"] == [{"userId": _UUID, "acknowledged": 2, "pending": 1}]
    assert dumped["hiddenUserIds"] == [_UUID]
    assert dumped["canManage"] is True


def test_availability_dto_defaults_to_an_empty_org() -> None:
    """An org where nobody has open work serializes as empty lists, not nulls —
    the client treats a user absent from `counts` as available."""
    dto = AvailabilityDTO(counts=[], hiddenUserIds=[], canManage=False)
    assert dto.model_dump() == {"counts": [], "hiddenUserIds": [], "canManage": False}
