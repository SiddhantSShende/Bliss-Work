"""Run one LibreOffice conversion inside an already-created job workspace.

Everything here is about containing a hostile document: a pinned import filter,
a fresh per-job profile, a process GROUP that is killed on timeout and again
afterwards, rlimits on the child, and checks on what comes out.
"""
import os
import shutil
import signal
import subprocess

from . import config
from .errors import ConvertError
from .sheets import build_artifact
from .spec import PDF, Spec
from .validate import check_magic, check_zip


def _command(spec: Spec, profile: str, in_path: str, out_dir: str) -> list[str]:
    limits = [
        "prlimit",
        f"--cpu={config.TIMEOUT_SECONDS + 10}",
        f"--nofile={config.RLIMIT_NOFILE}",
        f"--fsize={config.RLIMIT_FSIZE}",
    ]
    if config.RLIMIT_NPROC:
        limits.append(f"--nproc={config.RLIMIT_NPROC}")
    if config.RLIMIT_AS:
        limits.append(f"--as={config.RLIMIT_AS}")
    return limits + [
        "--",
        config.SOFFICE,
        "--headless", "--norestore", "--nolockcheck", "--nologo", "--nodefault",
        f"-env:UserInstallation=file://{profile}",
        f"--infilter={spec.infilter}",
        "--convert-to", spec.convert_to,
        "--outdir", out_dir,
        in_path,
    ]


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _run_soffice(cmd: list[str], job_dir: str) -> None:
    # A minimal environment: nothing from the converter's own is inherited.
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": job_dir, "LANG": "C.UTF-8"}
    proc = subprocess.Popen(
        cmd, cwd=job_dir, env=env, start_new_session=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        proc.wait(timeout=config.TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        proc.wait()
        raise ConvertError(ConvertError.TIMEOUT)
    finally:
        _kill_group(proc)  # reap soffice.bin stragglers even after a clean exit
    if proc.returncode != 0:
        # Includes the process being killed for exceeding a limit (OOM, CPU).
        raise ConvertError(ConvertError.LIMIT if proc.returncode < 0 else ConvertError.UNCONVERTIBLE)


def _sheet_files(out_dir: str) -> list[tuple[str, str]]:
    """[(display name, path)] for the per-sheet CSVs LibreOffice wrote.

    Files are named `in-<SheetName>.csv`. Workbook order is recovered from the
    order LibreOffice wrote them in (it writes sheets sequentially; mtime, then
    inode number, break ties).
    """
    files = [f for f in os.listdir(out_dir) if f.endswith(".csv")]
    def written(f: str) -> tuple[int, int, str]:
        st = os.stat(os.path.join(out_dir, f))
        return (st.st_mtime_ns, st.st_ino, f)  # tmpfs inodes only ever increase

    files.sort(key=written)
    out = []
    for f in files:
        stem = f[: -len(".csv")]
        name = stem[len("in-"):] if stem.startswith("in-") else stem
        out.append((name, os.path.join(out_dir, f)))
    return out


def convert(spec: Spec, job_dir: str, in_path: str) -> tuple[str, bytes]:
    """Return (artifact kind, bytes). Raises ConvertError."""
    check_magic(in_path, spec)
    if spec.is_zip:
        check_zip(in_path)

    profile = os.path.join(job_dir, "profile")
    out_dir = os.path.join(job_dir, "out")
    os.makedirs(out_dir, mode=0o700)
    shutil.copytree(config.PROFILE_TEMPLATE, profile)

    _run_soffice(_command(spec, profile, in_path, out_dir), job_dir)

    if spec.artifact == PDF:
        out_path = os.path.join(out_dir, "in.pdf")
        if not os.path.isfile(out_path):
            raise ConvertError(ConvertError.UNCONVERTIBLE)
        if os.path.getsize(out_path) > config.MAX_OUTPUT_BYTES:
            raise ConvertError(ConvertError.LIMIT)
        with open(out_path, "rb") as f:
            data = f.read()
        if not data.startswith(b"%PDF-"):
            raise ConvertError(ConvertError.UNCONVERTIBLE)
        return PDF, data

    data = build_artifact(_sheet_files(out_dir))
    if len(data) > config.MAX_OUTPUT_BYTES:
        raise ConvertError(ConvertError.LIMIT)
    return spec.artifact, data
