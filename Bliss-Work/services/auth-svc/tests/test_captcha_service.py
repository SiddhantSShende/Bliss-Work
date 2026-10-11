"""CAPTCHA generation + validation — pure logic, no DB (state lives in Redis/
in-process, never Postgres). See app/routes/captcha_service.py.
"""
from __future__ import annotations

import io

import httpx
import pytest
from fastapi import FastAPI
from PIL import Image, ImageDraw, ImageFilter

from app.routes import captcha as captcha_routes
from app.routes import captcha_alphabet as alphabet
from app.routes import captcha_image, captcha_service as cs


# ── Generation ────────────────────────────────────────────────────────────────
def test_generated_value_is_exactly_the_configured_length() -> None:
    value = cs._generate_value(cs.settings.captcha_length)
    assert len(value) == cs.settings.captcha_length == 6


# ── The alphabet (captcha_alphabet.py is the single source) ──────────────────
def test_the_alphabet_is_exactly_the_approved_set() -> None:
    assert alphabet.UPPERCASE == "ABDEFGHMNPQRTUY"
    assert alphabet.LOWERCASE == "abdefghmnpqrtuy"
    assert alphabet.DIGITS == "346789"
    assert alphabet.ALPHABET == alphabet.UPPERCASE + alphabet.LOWERCASE + alphabet.DIGITS
    assert len(set(alphabet.ALPHABET)) == len(alphabet.ALPHABET)  # no duplicates


def test_the_alphabet_has_both_cases_and_digits() -> None:
    assert alphabet.UPPERCASE and alphabet.UPPERCASE.isupper()
    assert alphabet.LOWERCASE and alphabet.LOWERCASE.islower()
    assert alphabet.DIGITS.isdigit()


def test_no_excluded_character_is_in_the_alphabet() -> None:
    # The characters the product asked to be unambiguous, spelled out so a
    # careless edit to captcha_alphabet.py cannot quietly put one back.
    for ch in "0Oo" "1IilL" "2Zz" "5Ss" "Ww" "Xx":
        assert ch not in alphabet.ALPHABET
    assert not set(alphabet.ALPHABET) & alphabet.EXCLUDED


def test_every_removal_made_after_rendering_review_is_recorded() -> None:
    for ch in "CcVvKkJj":  # same outline / lost detail — see captcha_alphabet.py
        assert ch in alphabet.EXCLUDED
        assert ch not in alphabet.ALPHABET


def test_generated_value_is_exactly_the_configured_length_and_in_the_alphabet() -> None:
    allowed = set(alphabet.ALPHABET)
    for _ in range(300):
        value = cs._generate_value(6)
        assert len(value) == 6
        assert set(value) <= allowed


def test_excluded_characters_can_never_be_generated() -> None:
    # 36 characters, 6 per value: 5,000 values is 30,000 draws, so a character
    # with even a 1-in-1000 chance of appearing would be seen ~30 times.
    seen: set[str] = set()
    for _ in range(5000):
        seen |= set(cs._generate_value(6))
    assert not seen & alphabet.EXCLUDED
    assert seen == set(alphabet.ALPHABET)  # ...and every allowed one does appear


def test_both_upper_and_lower_case_are_generated() -> None:
    values = "".join(cs._generate_value(6) for _ in range(300))
    assert any(c.isupper() for c in values)
    assert any(c.islower() for c in values)
    assert any(c.isdigit() for c in values)


async def test_the_challenge_path_uses_the_same_alphabet(monkeypatch: pytest.MonkeyPatch) -> None:
    """generate_challenge is what the endpoint calls; whatever it hands to the
    renderer must come from the approved alphabet."""
    rendered: list[str] = []
    monkeypatch.setattr(captcha_image, "render", lambda value: rendered.append(value) or b"png")
    for _ in range(50):
        await cs.generate_challenge()
    assert len(rendered) == 50
    assert all(set(v) <= set(alphabet.ALPHABET) and len(v) == cs.settings.captcha_length for v in rendered)


def test_generated_values_are_unpredictable() -> None:
    """Not a formal entropy proof, just a sanity floor: 500 draws of a 6-char
    string (36^6 possibilities) should not collide, and should not degenerate
    to a small repeating set."""
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


def _dark_ink_box(png: bytes) -> tuple[int, int, int, int] | None:
    """Bounding box of the glyph pixels only (the text is dark; background,
    noise and interference are all lighter)."""
    return Image.open(io.BytesIO(png)).convert("L").point(lambda v: 255 if v < 100 else 0).getbbox()


def test_the_font_is_bundled_and_loads() -> None:
    assert captcha_image._FONT_PATH.is_file()
    assert captcha_image._font(captcha_image._FONT_SIZE).getlength("A") > 0


def test_every_character_in_the_alphabet_renders() -> None:
    for ch in alphabet.ALPHABET:
        im = Image.open(io.BytesIO(captcha_image.render(ch)))
        assert im.size == (captcha_image._WIDTH, captcha_image._HEIGHT)
        assert _dark_ink_box(captcha_image.render(ch)) is not None, ch


@pytest.mark.parametrize("value", ["MmMmMm", "mMmMmM", "HmNMhm", "ijjijj", "AbDeHq"])
def test_characters_never_clip_off_the_image_and_keep_a_readable_size(value: str) -> None:
    """The widest letters in the alphabet still fit with the spacing intact
    (the type shrinks, not the gaps), and nothing is drawn off the edge."""
    for _ in range(15):
        layout = captcha_image._fit_layout(value)
        assert layout.total <= captcha_image._WIDTH - 2 * captcha_image._MARGIN
        assert min(layout.sizes) >= captcha_image._MIN_FONT_SIZE - 1
        assert all(g >= captcha_image._GAP_RANGE[0] for g in layout.gaps)
        box = _dark_ink_box(captcha_image.render(value))
        assert box is not None
        assert box[0] >= 2 and box[2] <= captcha_image._WIDTH - 2
        assert box[1] >= 2 and box[3] <= captcha_image._HEIGHT - 2


def _blank(colour: int = 255) -> Image.Image:
    return Image.new("RGB", (captcha_image._WIDTH, captcha_image._HEIGHT), (colour,) * 3)


def _letters_only(value: str) -> Image.Image:
    """The glyphs alone, with all their per-letter distortion, on white — no
    connectors or background, so letter-to-letter spacing can be judged."""
    img = Image.new("RGBA", (captcha_image._WIDTH, captcha_image._HEIGHT), (255, 255, 255, 255))
    layout = captcha_image._fit_layout(value)
    captcha_image._draw_characters(img, value, layout, (captcha_image._WIDTH - layout.total) / 2)
    return img


def _column_groups(img: Image.Image) -> int:
    """How many separate horizontal runs of glyph ink the image has."""
    ink = img.convert("L").point(lambda v: 255 if v < 110 else 0)
    w, h = ink.size
    px = ink.load()
    runs, prev = 0, False
    for x in range(w):
        col = any(px[x, y] for y in range(h))
        runs += col and not prev
        prev = col
    return runs


def test_neighbouring_characters_do_not_touch() -> None:
    """The old fixed 27px cell let W+w and m+n collide into one blob. Draw real
    strings — runs of the widest letters and of the descending ones, each letter
    widened, slanted, rippled and rotated — and require that no two characters
    merge into one run of ink.

    Statistical on purpose: a letter with a gap inside it (a 'T' beside a slanted
    neighbour) can occasionally read as two runs, and a rare worst case closes a
    9px gap, so the bar is under 1% merged rather than none."""
    values = ["MmMmMm", "HNMmHN", "yyyppp", "qgqgqg", "fttfrf", "AAAAAA", "AbDeHq", "u7Y4hT"]
    merged = sum(_column_groups(_letters_only(v)) < len(v) for v in values for _ in range(25))
    assert merged <= 2, f"{merged} of {25 * len(values)} renders had touching characters"


def test_connector_curves_join_the_whole_word_into_one_piece_of_ink() -> None:
    """Letters are cleanly separated for readers, which would let a script cut
    the image at the empty columns. The curves must leave NO empty column
    between the ends of the word."""
    for _ in range(25):
        img = _blank()
        captcha_image._connector_curves(ImageDraw.Draw(img), 60, 240)
        ink = img.convert("L").point(lambda v: 255 if v < 140 else 0)
        px = ink.load()
        for x in range(60, 241):
            assert any(px[x, y] for y in range(img.size[1])), f"empty column at x={x}"


def test_one_connector_survives_a_threshold_and_a_3px_opening() -> None:
    """The dark 3px curve is what keeps "threshold, then strip thin lines" from
    cleaning the image: it stays after both."""
    for _ in range(25):
        img = _blank()
        captcha_image._connector_curves(ImageDraw.Draw(img), 60, 240)
        ink = img.convert("L").point(lambda v: 255 if v < 100 else 0)
        opened = ink.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
        assert opened.getbbox() is not None


def test_connectors_are_drawn_before_the_letters_so_no_stroke_is_cut(monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []
    real_conn, real_chars = captcha_image._connector_curves, captcha_image._draw_characters
    monkeypatch.setattr(captcha_image, "_connector_curves", lambda *a, **k: order.append("connectors") or real_conn(*a, **k))
    monkeypatch.setattr(captcha_image, "_draw_characters", lambda *a, **k: order.append("letters") or real_chars(*a, **k))
    captcha_image.render("AbDeHq")
    assert order == ["connectors", "letters"]


@pytest.mark.parametrize("lower,upper", [("e", "E"), ("u", "U"), ("n", "N"), ("a", "A"), ("h", "H")])
def test_lower_case_stays_clearly_smaller_than_upper_case_after_every_distortion(lower: str, upper: str) -> None:
    """The answer is case-sensitive and, for the letters that look alike, size is
    the cue. Width scale, slant, ripple and rotation vary the OUTLINE but must
    never blur the height difference."""

    def median_height(ch: str) -> float:
        heights = []
        for _ in range(21):
            img = Image.new("RGBA", (captcha_image._WIDTH, captcha_image._HEIGHT), (255, 255, 255, 255))
            layout = captcha_image._fit_layout(ch)
            captcha_image._draw_characters(img, ch, layout, 120)
            box = img.convert("L").point(lambda v: 255 if v < 110 else 0).getbbox()
            heights.append(box[3] - box[1])
        return sorted(heights)[len(heights) // 2]

    if lower in "hn":  # same-height letters (ascender / cap): the cue there is the SHAPE, not size
        return
    assert median_height(lower) <= 0.88 * median_height(upper)


def test_a_letter_is_bent_smoothly_not_in_whole_pixel_steps() -> None:
    """Whole-pixel row shifts left stair-steps along every curve. The ripple is
    sub-pixel: a hard vertical edge becomes soft, never a staircase of identical
    columns."""
    img = Image.new("RGBA", (60, 60), (0, 0, 0, 0))
    ImageDraw.Draw(img).rectangle([25, 0, 34, 59], fill=(0, 0, 0, 255))
    out = captcha_image._ripple(img, amplitude=2.0, period=30)
    assert out.size == img.size and out.mode == "RGBA"
    partial = [a for (*_rgb, a) in (out.getpixel((x, y)) for y in range(60) for x in range(60)) if 0 < a < 255]
    assert partial, "an edge shifted by a fraction of a pixel must be anti-aliased"


def test_the_ripple_never_paints_a_stripe_of_the_wrong_colour_at_the_edge() -> None:
    img = _blank(200)
    for _ in range(10):
        out = captcha_image._warp(img)
        assert set(out.getdata()) == {(200, 200, 200)}


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


async def test_a_challenge_expires_after_its_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    captcha_id = await _mint("AbDeHq", ttl=300)
    assert await cs._store.get(captcha_id) is not None
    now = cs.time.monotonic()
    monkeypatch.setattr(cs.time, "monotonic", lambda: now + 301)
    assert await cs._store.get(captcha_id) is None
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(captcha_id, "AbDeHq")  # the right answer, too late


async def test_the_ttl_is_applied_to_a_new_challenge() -> None:
    captcha_id, _png, ttl = await cs.generate_challenge()
    assert ttl == cs.settings.captcha_ttl_seconds
    assert await cs._store.get(captcha_id) is not None


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


@pytest.mark.parametrize("answer", ["abdehq", "ABDEHQ", "aBdEhQ", "AbDeHq".swapcase()])
async def test_validation_is_case_sensitive_in_both_directions(answer: str) -> None:
    """Mixed case is part of the challenge: neither an all-lower nor an
    all-upper nor a flipped answer may pass, however many letters match."""
    captcha_id = await _mint("AbDeHq")
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(captcha_id, answer)


async def test_the_exact_mixed_case_answer_passes() -> None:
    captcha_id = await _mint("AbDeHq")
    await cs.verify_and_consume(captcha_id, "AbDeHq")


@pytest.mark.parametrize("typed", [" AbDeHq", "AbDeHq ", "  AbDeHq\n"])
async def test_surrounding_whitespace_is_ignored_but_case_is_not(typed: str) -> None:
    """A phone keyboard often appends a space. That is forgiven; the characters
    are still compared exactly."""
    captcha_id = await _mint("AbDeHq")
    await cs.verify_and_consume(captcha_id, typed)


async def test_whitespace_inside_the_answer_still_fails() -> None:
    captcha_id = await _mint("AbDeHq")
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(captcha_id, "AbD eHq")


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


async def test_the_last_allowed_attempt_can_still_succeed() -> None:
    captcha_id = await _mint("AbDeHq")
    for _ in range(cs.settings.captcha_max_attempts - 1):
        with pytest.raises(cs.HTTPException):
            await cs.verify_and_consume(captcha_id, "wrong")
    await cs.verify_and_consume(captcha_id, "AbDeHq")  # attempt number max_attempts


async def test_the_attempt_after_the_limit_is_refused_even_with_the_right_answer() -> None:
    captcha_id = await _mint("AbDeHq")
    for _ in range(cs.settings.captcha_max_attempts):
        with pytest.raises(cs.HTTPException):
            await cs.verify_and_consume(captcha_id, "wrong")
    assert await cs._store.get(captcha_id) is None
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(captcha_id, "AbDeHq")


# ── Refresh ───────────────────────────────────────────────────────────────────
async def test_refresh_invalidates_the_previous_challenge() -> None:
    old = await _mint("AbDeHq")
    new, _png, _ttl = await cs.generate_challenge(replaces=old)

    assert new != old
    assert await cs._store.get(old) is None
    with pytest.raises(cs.HTTPException):
        await cs.verify_and_consume(old, "AbDeHq")  # the old answer no longer works
    assert await cs._store.get(new) is not None  # ...and the new one is live


async def test_refresh_without_a_previous_id_or_with_an_unknown_one_still_works() -> None:
    for replaces in (None, "", "no-such-challenge"):
        captcha_id, png, _ttl = await cs.generate_challenge(replaces=replaces)
        assert png[:4] == b"\x89PNG"
        assert await cs._store.get(captcha_id) is not None


async def test_refreshing_one_challenge_leaves_other_visitors_alone() -> None:
    mine, theirs = await _mint("AbDeHq"), await _mint("TuYrNa")
    await cs.generate_challenge(replaces=mine)
    assert await cs._store.get(theirs) is not None
    await cs.verify_and_consume(theirs, "TuYrNa")


async def test_the_endpoint_wires_replaces_through_and_is_never_cached() -> None:
    app = FastAPI()
    app.include_router(captcha_routes.router)
    old = await _mint("AbDeHq")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://auth") as c:
        r = await c.get("/auth/captcha", params={"replaces": old})
        assert r.status_code == 200
        assert r.headers["cache-control"] == "no-store"
        body = r.json()
        assert body["captchaId"] != old and body["captchaImage"].startswith("data:image/png;base64,")
        # an over-long id is refused rather than looked up
        assert (await c.get("/auth/captcha", params={"replaces": "x" * 65})).status_code == 422
    assert await cs._store.get(old) is None


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
