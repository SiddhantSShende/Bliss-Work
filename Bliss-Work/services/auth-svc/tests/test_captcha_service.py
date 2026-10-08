"""CAPTCHA generation + validation — pure logic, no DB (state lives in Redis/
in-process, never Postgres). See app/routes/captcha_service.py.
"""
from __future__ import annotations

import string

import pytest

from app.routes import captcha_image, captcha_service as cs


# ── Generation ────────────────────────────────────────────────────────────────
def test_generated_value_is_exactly_the_configured_length() -> None:
    value = cs._generate_value(cs.settings.captcha_length)
    assert len(value) == cs.settings.captcha_length == 6


def test_generated_value_is_alphanumeric_only() -> None:
    allowed = set(string.ascii_letters + string.digits)
    for _ in range(200):
        value = cs._generate_value(6)
        assert len(value) == 6
        assert set(value) <= allowed
        assert value.isalnum()


def test_generated_value_excludes_visually_ambiguous_characters() -> None:
    """0/O, 1/l/I are excluded — see captcha_service._ALPHABET's docstring.
    Heavier per-character distortion makes an already-ambiguous pair harder
    still to call correctly, so they're dropped rather than rendered."""
    ambiguous = set("0O1lI")
    for _ in range(300):
        value = cs._generate_value(6)
        assert not (set(value) & ambiguous)


def test_generated_values_are_unpredictable() -> None:
    """Not a formal entropy proof, just a sanity floor: 500 draws of a 6-char
    alphanumeric string (57^6 possibilities, after excluding ambiguous chars)
    should not collide, and should not degenerate to a small repeating set."""
    values = {cs._generate_value(6) for _ in range(500)}
    assert len(values) == 500  # no collisions
    # Every position should see more than a handful of distinct characters
    # across 500 draws — catches a broken generator that e.g. always picks
    # the same character at some position.
    for i in range(6):
        distinct_at_position = {v[i] for v in values}
        assert len(distinct_at_position) > 10


def test_render_image_produces_a_nonempty_png() -> None:
    png = captcha_image.render("A7kPxQ")
    assert png[:8] == b"\x89PNG\r\n\x1a\n"  # PNG magic bytes
    assert len(png) > 100


def test_render_image_varies_across_calls() -> None:
    """The whole point of the style system: two renders of the SAME value
    must not produce byte-identical images — background, interference and
    per-character placement all vary independently on every call."""
    renders = {captcha_image.render("A7kPxQ") for _ in range(20)}
    assert len(renders) == 20


def test_render_image_selects_from_multiple_styles() -> None:
    """Not always the same visual style — sample enough draws that seeing
    only one or two styles would indicate the "random" choice isn't."""
    seen = {captcha_image._pick_style() for _ in range(60)}
    assert len(seen) >= 4


# ── Validation ────────────────────────────────────────────────────────────────
async def _mint(value: str, ttl: int | None = None) -> str:
    captcha_id = cs.service.new_uuid()
    await cs._store.put(
        captcha_id, cs.service.sha256_bytes(value), ttl if ttl is not None else cs.settings.captcha_ttl_seconds
    )
    return captcha_id


async def test_correct_value_succeeds() -> None:
    captcha_id = await _mint("AbCdEf12")
    await cs.verify_and_consume(captcha_id, "AbCdEf12")  # does not raise


async def test_incorrect_value_fails() -> None:
    captcha_id = await _mint("AbCdEf12")
    with pytest.raises(cs.HTTPException) as exc_info:
        await cs.verify_and_consume(captcha_id, "wrongwrong")
    assert exc_info.value.status_code == 400


async def test_wrong_captcha_id_fails() -> None:
    await _mint("AbCdEf12")
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume("some-other-id-entirely", "AbCdEf12")


async def test_expired_captcha_fails() -> None:
    captcha_id = await _mint("AbCdEf12", ttl=-1)  # already in the past
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(captcha_id, "AbCdEf12")


async def test_already_used_captcha_fails() -> None:
    captcha_id = await _mint("AbCdEf12")
    await cs.verify_and_consume(captcha_id, "AbCdEf12")
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(captcha_id, "AbCdEf12")


@pytest.mark.parametrize("captcha_id,captcha_value", [(None, "AbCdEf12"), ("some-id", None), (None, None)])
async def test_missing_fields_fail(captcha_id, captcha_value) -> None:
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(captcha_id, captcha_value)


async def test_case_mismatch_fails() -> None:
    captcha_id = await _mint("AbCdEf12")
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(captcha_id, "abcdef12")


async def test_all_failures_return_the_same_generic_message() -> None:
    """No variant reveals WHY it failed — missing, wrong id, expired, wrong
    value, and exhausted-attempts must all look identical to the caller."""
    messages = set()

    captcha_id = await _mint("AbCdEf12")
    with pytest.raises(cs.HTTPException) as e1:
        await cs.verify_and_consume(captcha_id, "nope")
    messages.add(e1.value.detail)

    with pytest.raises(cs.HTTPException) as e2:
        await cs.verify_and_consume("unknown-id", "AbCdEf12")
    messages.add(e2.value.detail)

    with pytest.raises(cs.HTTPException) as e3:
        await cs.verify_and_consume(None, None)
    messages.add(e3.value.detail)

    assert len(messages) == 1


# ── Security: single-use, attempt limiting, disabled mode ────────────────────
async def test_successful_validation_immediately_invalidates_the_captcha() -> None:
    captcha_id = await _mint("AbCdEf12")
    assert await cs._store.get(captcha_id) is not None
    await cs.verify_and_consume(captcha_id, "AbCdEf12")
    assert await cs._store.get(captcha_id) is None


async def test_concurrent_correct_validation_only_consumes_once() -> None:
    import asyncio

    captcha_id = await _mint("AbCdEf12")
    results = await asyncio.gather(
        cs._store.validate_and_consume(
            captcha_id,
            cs.service.sha256_bytes("AbCdEf12"),
            cs.settings.captcha_max_attempts,
        ),
        cs._store.validate_and_consume(
            captcha_id,
            cs.service.sha256_bytes("AbCdEf12"),
            cs.settings.captcha_max_attempts,
        ),
    )
    assert sorted(results) == [False, True]


async def test_attempt_counting_is_atomic_and_exhausts_captcha() -> None:
    import asyncio

    captcha_id = await _mint("AbCdEf12")
    attempts = cs.settings.captcha_max_attempts
    results = await asyncio.gather(
        *(
            cs._store.validate_and_consume(
                captcha_id,
                cs.service.sha256_bytes("wrong"),
                attempts,
            )
            for _ in range(attempts + 4)
        )
    )
    assert not any(results)
    assert await cs._store.get(captcha_id) is None


async def test_repeated_wrong_guesses_exhaust_and_lock_out_even_the_correct_value() -> None:
    captcha_id = await _mint("AbCdEf12")
    for _ in range(cs.settings.captcha_max_attempts):
        with pytest.raises(cs.HTTPException):
            await cs.verify_and_consume(captcha_id, "wrong")
    # The captcha is now dead — even the ORIGINALLY correct value must fail.
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(captcha_id, "AbCdEf12")


async def test_disabled_mode_is_a_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cs.settings, "captcha_enabled", False)
    await cs.verify_and_consume(None, None)  # does not raise
    await cs.verify_and_consume("garbage", "garbage")  # does not raise either


async def test_plaintext_value_is_never_logged(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patches the module's logger to fail the test if the plaintext value (or
    its captcha_id) ever appears in any log call's args/kwargs, across a full
    generate -> wrong-guess -> correct-guess -> reuse cycle."""

    calls: list[tuple[tuple, dict]] = []

    class _RecordingLog:
        def info(self, *a, **kw):
            calls.append((a, kw))

        def warning(self, *a, **kw):
            calls.append((a, kw))

        def error(self, *a, **kw):
            calls.append((a, kw))

    monkeypatch.setattr(cs, "log", _RecordingLog())

    captcha_id, _png, _ttl = await cs.generate_challenge()
    value = cs._generate_value(8)
    await cs._store.put(captcha_id, cs.service.sha256_bytes(value), cs.settings.captcha_ttl_seconds)
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(captcha_id, "definitely-wrong")
    await cs.verify_and_consume(captcha_id, value)
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(captcha_id, value)

    flat = repr(calls)
    assert value not in flat


# ── Platform exemption (see is_exempt_platform) ───────────────────────────────
@pytest.mark.parametrize("platform", ["macos", "ios", "MacOS", "  ios  "])
def test_macos_and_ios_are_exempt(platform: str) -> None:
    assert cs.is_exempt_platform(platform) is True


@pytest.mark.parametrize(
    "platform", ["windows", "linux", "android", "unknown", "", "   ", "mac", "darwin", "iphone", None]
)
def test_everything_else_is_not_exempt(platform: str | None) -> None:
    assert cs.is_exempt_platform(platform) is False


async def test_exempt_platform_skips_the_check_without_touching_the_store() -> None:
    await cs.verify_and_consume(None, None, "macos")  # does not raise
    await cs.verify_and_consume(None, None, "ios")  # does not raise


@pytest.mark.parametrize("platform", ["windows", "linux", "android", "unknown", None])
async def test_non_exempt_platform_is_still_challenged(platform: str | None) -> None:
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(None, None, platform)


async def test_omitting_the_platform_keeps_the_original_behaviour() -> None:
    """create_org's call shape — two arguments — must stay fully enforced."""
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(None, None)


def test_exempt_list_is_configurable_and_empty_means_nobody(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cs.settings, "captcha_exempt_platforms", "ios")
    assert cs.is_exempt_platform("ios") is True
    assert cs.is_exempt_platform("macos") is False
    monkeypatch.setattr(cs.settings, "captcha_exempt_platforms", "")
    assert cs.is_exempt_platform("ios") is False
