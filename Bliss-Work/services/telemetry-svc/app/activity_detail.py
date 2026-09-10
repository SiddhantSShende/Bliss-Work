"""The unified activity detail contract. Mirrors packages/shared/src/types/activity.ts.

Not a new activity model — see that file's docstring for the full reasoning.
`ActivityRow.detail` (ingest.py) and `BeaconEvent.detail` (schemas.py) are
already a free-form, encrypted, per-org `dict[str, str]` that the timeline
handler decrypts and returns unchanged. No schema change; every key stays
optional, and a row written before this contract existed simply has none
of them.
"""
from __future__ import annotations
