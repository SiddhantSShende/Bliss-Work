from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from app.healthcheck import HEARTBEAT_COMPONENTS, is_healthy, record_heartbeat, reset_heartbeats


class HealthcheckTests(unittest.TestCase):
    def test_requires_both_fresh_consumer_heartbeats_and_worker_process(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            now = 1_800_000_000.0
            reset_heartbeats(directory)
            self.assertFalse(is_healthy(directory, now, b"python\x00-m\x00app\x00"))

            for component in HEARTBEAT_COMPONENTS:
                record_heartbeat(component, directory)
                os.utime(directory / f"{component}.heartbeat", (now, now))

            self.assertTrue(is_healthy(directory, now, b"python\x00-m\x00app\x00"))
            self.assertFalse(is_healthy(directory, now, b"python\x00-m\x00app.healthcheck\x00"))

            os.utime(directory / "relay.heartbeat", (now - 181, now - 181))
            self.assertFalse(is_healthy(directory, now, b"python\x00-m\x00app\x00"))


if __name__ == "__main__":
    unittest.main()
