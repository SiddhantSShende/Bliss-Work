"""Tunables, all env-overridable.

THE NUMBERS BELOW ARE SAFETY CEILINGS, NOT PRODUCT LIMITS. None of them hides an
Open button: a document that trips one simply ends in the Download fallback.
They were derived from a measurement run (2026-10-07, Debian trixie / LibreOffice
25.2, container with 2 CPUs, tests/measure.py; the table is in README.md):

  per job:   ~170-200 MB peak for ordinary files; the worst tested (a 96 MB .xls,
             65k rows x 250 cols) peaked ~400 MB. Wall time 2 s for a one-page
             file, 15 s for a 200-page DOCX, 33 s for a 50 MB XLSX (the slowest).
  2 at once: 330-380 MB peak, same latency. 4 at once: ~650 MB, but latency
             doubles (CPU-bound on 2 CPUs), so 2 is the useful concurrency.
  output:    PDFs came out at 0.3-0.4x the input for image/sheet-heavy files; the
             capped sheet artifact is ~3 MB however large the workbook.

  → container memory 1280M = two worst-case jobs (~800 MB) plus the tmpfs they
    live in (it counts against the same limit); CONCURRENCY 2; TIMEOUT 90 s is
    ~2.7x the slowest job measured. Re-measure before raising any of them.
"""
import os


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


MB = 1024 * 1024

# Input / output ceilings. Input is the existing 100 MiB upload cap, so no NEW
# product limit is introduced; a 203 MB deck was refused at this ceiling before
# LibreOffice started, a 96 MB .xls converted in 15 s.
MAX_INPUT_BYTES = _int("CONVERT_MAX_INPUT_BYTES", 100 * MB)
MAX_OUTPUT_BYTES = _int("CONVERT_MAX_OUTPUT_BYTES", 100 * MB)

# Wall-clock budget for one LibreOffice run; the process GROUP is killed after it.
TIMEOUT_SECONDS = _int("CONVERT_TIMEOUT_SECONDS", 90)

# Concurrent LibreOffice jobs. A full converter answers 503 `busy` immediately.
CONCURRENCY = _int("CONVERT_CONCURRENCY", 2)

# ZIP pre-check (OOXML): read from the central directory, nothing is inflated.
ZIP_MAX_UNCOMPRESSED = _int("CONVERT_ZIP_MAX_UNCOMPRESSED", 1024 * MB)
ZIP_MAX_RATIO = _int("CONVERT_ZIP_MAX_RATIO", 200)
ZIP_MAX_ENTRIES = _int("CONVERT_ZIP_MAX_ENTRIES", 20000)

# Spreadsheet artifact caps (display safety, not Open-hiding).
SHEET_MAX_SHEETS = _int("CONVERT_SHEET_MAX_SHEETS", 64)
SHEET_MAX_ROWS = _int("CONVERT_SHEET_MAX_ROWS", 5000)
SHEET_MAX_COLS = _int("CONVERT_SHEET_MAX_COLS", 200)
SHEET_MAX_BYTES = _int("CONVERT_SHEET_MAX_BYTES", 8 * MB)

# rlimits on the LibreOffice child (defense in depth beside the container's
# own cgroup limits). 0 disables one. RLIMIT_AS is off by default: LibreOffice
# maps a lot of address space and it breaks at limits the cgroup handles better.
RLIMIT_FSIZE = _int("CONVERT_RLIMIT_FSIZE", 512 * MB)
# RLIMIT_NPROC is OFF by default, deliberately. It counts processes per REAL UID
# across the whole host, not per container, and every BlissWork service runs as
# uid 10001: the other services' threads were eating the budget and LibreOffice
# died with "Cannot fork". Process count is bounded per container by the
# compose `pids_limit` instead.
RLIMIT_NPROC = _int("CONVERT_RLIMIT_NPROC", 0)
RLIMIT_NOFILE = _int("CONVERT_RLIMIT_NOFILE", 2048)
RLIMIT_AS = _int("CONVERT_RLIMIT_AS", 0)

JOBS_ROOT = os.environ.get("CONVERT_JOBS_ROOT", "/tmp/jobs")
PROFILE_TEMPLATE = os.environ.get("CONVERT_PROFILE_TEMPLATE", "/opt/profile-template")
SOFFICE = os.environ.get("CONVERT_SOFFICE", "soffice")
PORT = _int("PORT", 9000)
