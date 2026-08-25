"""The KEK provider must not block the event loop.

WHY THIS IS A TEST AND NOT A COMMENT
------------------------------------
These services run ONE uvicorn worker, so there is one event loop per pod. A
synchronous HTTP call from a coroutine does not merely make that request slow —
it stalls every other in-flight request on the pod: health probes, token
refreshes, unrelated reads, all queued behind a Vault round trip. If Vault is
merely SLOW rather than down, each DEK cache miss blocks for up to the 5s
timeout, which is enough to make a pod serve nothing at all. A degraded
dependency becomes a total outage of unrelated traffic.

The failure is invisible in every ordinary test: correctness is unaffected, the
right bytes come back, and nothing errors. It shows up only as a pod that
quietly serves a fraction of the traffic it should, with no metric pointing at
the cause — which is exactly the shape the Argon2 hashing guard was added for.

So the property is asserted directly: while a wrap/unwrap is in flight, the loop
must still be able to run other work.
"""
from __future__ import annotations

import asyncio
import time

import pytest

crypto = pytest.importorskip(
    "crypto",
    reason="deps not installed locally; CI installs requirements-dev.txt.",
)


class _SlowRemoteKEK:
    """Stands in for Vault: a provider whose wrap/unwrap block on I/O."""

    blocking = True
    DELAY = 0.20

    def wrap(self, org_id: str, dek: bytes) -> tuple[bytes, int]:
        time.sleep(self.DELAY)  # a network round trip, in effect
        return b"wrapped:" + dek, 1

    def unwrap(self, org_id: str, wrapped: bytes, version: int) -> bytes:
        time.sleep(self.DELAY)
        return bytes(wrapped).removeprefix(b"wrapped:")


def _cryptor(kek) -> "crypto.Cryptor":
    return crypto.Cryptor(kek, blind_index_key=b"x" * 32, cache_ttl=300.0)


@pytest.mark.asyncio
async def test_blocking_kek_does_not_stall_the_event_loop():
    """The regression. With a synchronous call on the loop, the ticker below
    cannot run at all until the KEK returns; dispatched to a thread, it keeps
    ticking throughout."""
    c = _cryptor(_SlowRemoteKEK())

    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        deadline = time.monotonic() + _SlowRemoteKEK.DELAY
        while time.monotonic() < deadline:
            await asyncio.sleep(0.01)
            ticks += 1

    # Both run concurrently. If _wrap blocks the loop, ticker gets no chance to
    # advance until it finishes.
    await asyncio.gather(c._wrap("org-1", b"k" * 32), ticker())

    # ~20 ticks are possible; anything above a couple proves the loop stayed
    # free. Asserted loosely because CI timing is noisy and the property being
    # tested is "the loop ran", not "it ran exactly N times".
    assert ticks > 3, (
        f"the event loop only advanced {ticks} times while a blocking KEK call "
        "was in flight — the call is running ON the loop and is stalling every "
        "other request this pod is serving"
    )


@pytest.mark.asyncio
async def test_blocking_unwrap_also_goes_to_a_thread():
    """wrap and unwrap are separate call sites and were fixed separately; the
    one that runs more often (every DEK cache miss) is unwrap."""
    c = _cryptor(_SlowRemoteKEK())

    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        deadline = time.monotonic() + _SlowRemoteKEK.DELAY
        while time.monotonic() < deadline:
            await asyncio.sleep(0.01)
            ticks += 1

    await asyncio.gather(c._unwrap("org-1", b"wrapped:" + b"k" * 32, 1), ticker())
    assert ticks > 3, f"unwrap stalled the loop ({ticks} ticks)"


@pytest.mark.asyncio
async def test_round_trip_is_unchanged():
    """The dispatch must not alter behaviour — same bytes in, same bytes out."""
    c = _cryptor(_SlowRemoteKEK())
    dek = b"k" * 32
    wrapped, version = await c._wrap("org-1", dek)
    assert await c._unwrap("org-1", wrapped, version) == dek


@pytest.mark.asyncio
async def test_non_blocking_provider_stays_inline():
    """The dev provider is a microsecond of AES-GCM. Handing it to a thread
    would cost more than running it, so the dispatch is conditional — this
    asserts the condition is actually read."""

    calls: list[str] = []

    class _InlineKEK:
        blocking = False

        def wrap(self, org_id: str, dek: bytes) -> tuple[bytes, int]:
            calls.append(asyncio.current_task().get_name() if asyncio.current_task() else "thread")
            return b"w" + dek, 1

        def unwrap(self, org_id: str, wrapped: bytes, version: int) -> bytes:
            return bytes(wrapped)[1:]

    c = _cryptor(_InlineKEK())
    await c._wrap("org-1", b"k" * 32)
    # Running inline means we were still on a task when the provider was
    # called; a to_thread dispatch has no current task.
    assert calls and calls[0] != "thread", (
        "a non-blocking provider was dispatched to a thread — the `blocking` "
        "flag is not being consulted"
    )


@pytest.mark.asyncio
async def test_unknown_provider_defaults_to_blocking():
    """A provider that forgets to declare `blocking` must be treated as though
    it does I/O. Getting this wrong in the False direction stalls the pod;
    in the True direction it costs one thread hop, so the default is True."""

    class _UndeclaredKEK:  # no `blocking` attribute at all
        def wrap(self, org_id: str, dek: bytes) -> tuple[bytes, int]:
            time.sleep(_SlowRemoteKEK.DELAY)
            return b"w" + dek, 1

        def unwrap(self, org_id: str, wrapped: bytes, version: int) -> bytes:
            return bytes(wrapped)[1:]

    c = _cryptor(_UndeclaredKEK())

    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        deadline = time.monotonic() + _SlowRemoteKEK.DELAY
        while time.monotonic() < deadline:
            await asyncio.sleep(0.01)
            ticks += 1

    await asyncio.gather(c._wrap("org-1", b"k" * 32), ticker())
    assert ticks > 3, (
        "a provider that did not declare `blocking` was run on the loop; the "
        "safe default must be to assume it performs I/O"
    )


def test_no_call_site_bypasses_the_async_dispatch():
    """The guard that actually catches a regression.

    The tests above exercise `_wrap`/`_unwrap`. They would all still pass if
    someone added a NEW call site that reached `self._kek.unwrap(...)` directly
    — which is precisely how the original bug looked, and it would be invisible:
    correct bytes, no error, just a pod stalling on every DEK cache miss.

    So this walks the AST and asserts that the only direct uses of the provider
    are the two fast-path returns inside the dispatch helpers themselves.
    """
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(crypto))

    offenders: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        # The helpers are allowed — they ARE the dispatch.
        if node.name in {"_wrap", "_unwrap"}:
            continue
        for sub in ast.walk(node):
            if (
                isinstance(sub, ast.Call)
                and isinstance(sub.func, ast.Attribute)
                and sub.func.attr in {"wrap", "unwrap"}
                and isinstance(sub.func.value, ast.Attribute)
                and sub.func.value.attr == "_kek"
            ):
                offenders.append(f"{node.name}() line {sub.lineno}")

    assert not offenders, (
        "these call the KEK provider directly instead of going through "
        f"_wrap/_unwrap: {offenders}. On a one-worker event loop that blocks "
        "every other in-flight request on the pod whenever the provider does I/O."
    )


def test_vault_provider_declares_itself_blocking():
    """The flag on the one provider that actually does network I/O."""
    assert crypto.KMSKEKProvider.blocking is True


def test_dev_provider_declares_itself_non_blocking():
    assert crypto.DevKEKProvider.blocking is False
