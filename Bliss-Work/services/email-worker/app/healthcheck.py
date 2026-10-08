"""Liveness check for both Kafka consumers in the email-worker process."""
from __future__ import annotations

import time
from pathlib import Path

HEARTBEAT_DIR = Path("/tmp/email-worker-health")
HEARTBEAT_COMPONENTS = ("invite", "relay")
# A relay poll can include a bounded SMTP retry chain lasting about 100 seconds.
HEARTBEAT_MAX_AGE_SECONDS = 180


def reset_heartbeats(directory: Path = HEARTBEAT_DIR) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for component in HEARTBEAT_COMPONENTS:
        try:
            (directory / f"{component}.heartbeat").unlink()
        except FileNotFoundError:
            pass


def record_heartbeat(component: str, directory: Path = HEARTBEAT_DIR) -> None:
    if component not in HEARTBEAT_COMPONENTS:
        raise ValueError(f"unknown email-worker component: {component}")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{component}.heartbeat").touch()


def is_healthy(
    directory: Path = HEARTBEAT_DIR,
    now: float | None = None,
    process_cmdline: bytes | None = None,
) -> bool:
    if process_cmdline is None:
        try:
            process_cmdline = Path("/proc/1/cmdline").read_bytes()
        except OSError:
            return False
    if b"-m\x00app\x00" not in process_cmdline:
        return False

    current_time = time.time() if now is None else now
    for component in HEARTBEAT_COMPONENTS:
        try:
            age = current_time - (directory / f"{component}.heartbeat").stat().st_mtime
        except OSError:
            return False
        if age < 0 or age > HEARTBEAT_MAX_AGE_SECONDS:
            return False
    return True


def main() -> None:
    if not is_healthy():
        raise SystemExit(1)


if __name__ == "__main__":
    main()
