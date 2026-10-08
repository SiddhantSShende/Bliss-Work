"""Measurement run for plan §3.3: memory, CPU, duration, output size, concurrency.

    python3 tests/measure.py CONTAINER BASE_URL FIXTURE_DIR [--concurrency]

CONTAINER must be a running converter started with generous limits (the point is
to observe real peaks, not to hit a cap). Memory is the container cgroup's
`memory.peak`, reset before each job; CPU is the `usage_usec` delta.
"""
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tests.support import post  # noqa: E402

CONTAINER, BASE, FX = sys.argv[1], sys.argv[2], Path(sys.argv[3])
DOCKER = ["sudo", "-n", "docker"]


def cg(cmd: str) -> str:
    return subprocess.run(DOCKER + ["exec", "-u", "root", CONTAINER, "sh", "-c", cmd],
                          capture_output=True, text=True).stdout.strip()


def cpu_usec() -> int:
    return int(cg("grep usage_usec /sys/fs/cgroup/cpu.stat").split()[1])


def mb(n: float) -> str:
    return f"{n / 1048576:.0f}"


def fresh() -> None:
    """Restart the container so memory.peak is THIS job's peak.

    (Writing to memory.peak resets only the writing file descriptor's watermark,
    so a reset from a short-lived `exec` does not change what the next reader
    sees. A restart does.)
    """
    subprocess.run(DOCKER + ["restart", "-t", "0", CONTAINER], capture_output=True)
    for _ in range(40):
        try:
            if post("docx", b"", base=BASE, timeout=2)[0]:
                return
        except OSError:
            time.sleep(0.25)


def one(name: str) -> dict:
    kind = name.rsplit(".", 1)[1]
    data = (FX / name).read_bytes()
    fresh()
    c0, t0 = cpu_usec(), time.monotonic()
    status, h, body = post(kind, data, base=BASE, timeout=1200)
    wall = time.monotonic() - t0
    c1 = cpu_usec()
    peak = int(cg("cat /sys/fs/cgroup/memory.peak") or 0)
    code = ""
    if status != 200:
        try:
            code = json.loads(body)["code"]
        except Exception:  # noqa: BLE001
            code = "?"
    return {"file": name, "in_mb": mb(len(data)), "status": status, "code": code, "wall_s": round(wall, 1),
            "cpu_s": round((c1 - c0) / 1e6, 1), "peak_mb": mb(peak), "out_mb": mb(len(body)) if status == 200 else "-",
            "ratio": round(len(body) / len(data), 2) if status == 200 else "-"}


def table(rows: list[dict]) -> None:
    cols = ["file", "in_mb", "status", "code", "wall_s", "cpu_s", "peak_mb", "out_mb", "ratio"]
    print(" | ".join(f"{c:>14}" for c in cols))
    for r in rows:
        print(" | ".join(f"{str(r[c]):>14}" for c in cols), flush=True)


def concurrency(name: str) -> None:
    kind = name.rsplit(".", 1)[1]
    data = (FX / name).read_bytes()
    print(f"\nconcurrency, {name} ({mb(len(data))} MB in):")
    for n in (1, 2, 4):
        fresh()
        c0 = cpu_usec()
        walls, statuses = [], []

        def go():
            t = time.monotonic()
            s, _, _ = post(kind, data, base=BASE, timeout=1200)
            walls.append(time.monotonic() - t)
            statuses.append(s)

        ts = [threading.Thread(target=go) for _ in range(n)]
        t0 = time.monotonic()
        [t.start() for t in ts]
        [t.join() for t in ts]
        total = time.monotonic() - t0
        walls.sort()
        print(f"  n={n}: statuses={sorted(statuses)} p50={walls[len(walls) // 2]:.1f}s max={walls[-1]:.1f}s "
              f"total={total:.1f}s cpu={(cpu_usec() - c0) / 1e6:.1f}s peak={mb(int(cg('cat /sys/fs/cgroup/memory.peak')))}MB")


if __name__ == "__main__":
    names = sorted(p.name for p in FX.iterdir() if p.suffix[1:] in ("doc", "docx", "xls", "xlsx", "ppt", "pptx"))
    if "--concurrency" in sys.argv:
        concurrency("doc200p.docx")
        concurrency("deck_img_s.pptx")
    else:
        rows = []
        print(" | ".join(f"{c:>14}" for c in ["file", "in_mb", "status", "code", "wall_s", "cpu_s", "peak_mb", "out_mb", "ratio"]))
        for n in names:
            r = one(n)
            print(" | ".join(f"{str(r[c]):>14}" for c in ["file", "in_mb", "status", "code", "wall_s", "cpu_s", "peak_mb", "out_mb", "ratio"]), flush=True)
