"""_merge_top — folding today's live app/site usage onto the rolled-up totals.

Regression coverage for the gap this closes: app_usage_daily/site_usage_daily
are written once nightly for the PREVIOUS day only (jobs/rollup.py), so without
this merge, "Top Applications"/"Top Sites" stayed empty for whatever a member
used TODAY until the next day's rollup ran — even though active/idle time
already accounted for today via _today_live's equivalent top-up.
"""
from __future__ import annotations

import pytest

analytics = pytest.importorskip(
    "app.routes.analytics",
    reason="telemetry-svc deps not installed locally; CI installs requirements.txt.",
)
schemas = pytest.importorskip("app.schemas")

merge_top = analytics._merge_top
NamedCount = schemas.NamedCount


def test_merge_top_adds_live_onto_matching_rolled_up_key():
    rolled = [NamedCount(key="Chrome", label="Chrome", valueMs=60_000, count=3)]
    live = {"chrome": ("Chrome", 30_000, 2)}
    out = merge_top(rolled, live)
    assert len(out) == 1
    assert out[0].valueMs == 90_000
    assert out[0].count == 5


def test_merge_top_appends_a_key_the_rollup_has_not_seen_yet():
    rolled = [NamedCount(key="Chrome", label="Chrome", valueMs=60_000, count=3)]
    live = {"vscode": ("Visual Studio Code", 45_000, 1)}
    out = merge_top(rolled, live)
    assert {r.key for r in out} == {"Chrome", "Visual Studio Code"}


def test_merge_top_matches_case_insensitively_on_the_rollup_dedup_key():
    # app_usage_daily/site_usage_daily key on lower(target_id); a live sample
    # reported in different casing than an earlier rollup row must still merge
    # onto it rather than create a visible duplicate.
    rolled = [NamedCount(key="chrome", label="chrome", valueMs=60_000, count=3)]
    live = {"chrome": ("Chrome", 30_000, 2)}
    out = merge_top(rolled, live)
    assert len(out) == 1
    assert out[0].valueMs == 90_000


def test_merge_top_sorts_descending_and_caps_at_ten():
    rolled = [NamedCount(key=f"app{i}", label=f"app{i}", valueMs=i * 1000, count=1) for i in range(12)]
    out = merge_top(rolled, {})
    assert len(out) == 10
    assert [r.valueMs for r in out] == sorted((r.valueMs for r in out), reverse=True)
    assert out[0].key == "app11"
