"""The rollup SQL must expose only the values rollup_day supplies."""
from __future__ import annotations

import pytest

rollup = pytest.importorskip(
    "app.jobs.rollup",
    reason="telemetry-svc dependencies are not installed locally; CI installs requirements.txt.",
)


def test_rollup_statements_have_no_bind_parameters_in_comments():
    assert set(rollup._SESSION_ROLLUP._bindparams) == {"day"}
    assert set(rollup._EVENT_ROLLUP._bindparams) == {"day"}