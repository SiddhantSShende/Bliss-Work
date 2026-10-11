"""The rollup SQL must expose only the values rollup_day supplies."""
from __future__ import annotations

import pytest

rollup = pytest.importorskip(
    "app.jobs.rollup",
    reason="telemetry-svc dependencies are not installed locally; CI installs requirements.txt.",
)


def test_rollup_statements_have_no_bind_parameters_in_comments():
    assert set(rollup._SESSION_ROLLUP._bindparams) == {"day"}
    # "mirror" is the one extra value rollup_day supplies: the derived file-security
    # actions (ingest.SECURITY_MIRROR_ACTIONS), excluded so a file act counts once.
    assert set(rollup._EVENT_ROLLUP._bindparams) == {"day", "mirror"}