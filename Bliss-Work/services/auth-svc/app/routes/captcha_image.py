"""CAPTCHA rendering pipeline — turns a plaintext value into distorted PNG
bytes. Split out of captcha_service.py (which owns generation/storage/
validation) because rendering is a genuinely separate concern and was about
to make that module too large.

── What makes it hard for a machine, and what must stay easy for a person ───
The image is a randomized PIPELINE, not one fixed look: one of several
background/interference STYLES is chosen per call, and within it the line
count and angles, curve amplitude, dot density, grid spacing, background
split, per-character rotation / baseline offset / spacing / colour, and
whether a global ripple is applied are all independently re-randomized. A
script that learned one fixed composition would not transfer to the next
image. That variation is the anti-OCR property and it is kept.

What is NOT randomized any more is anything a human reads the answer from:
  * One legible font (DejaVu Sans Bold, bundled in app/assets/fonts) at one
    size per image. The earlier thin default font made 'I'/'l', 'rn'/'m' and
    thin strokes under a crossing line hard to call.
  * One shared baseline, and NO per-character HEIGHT change. The answer is
    case-sensitive, so "is this a c or a C" is answered by size next to its
    neighbours; a random height scale and a +/-8px vertical jitter (the old
    behaviour) erased exactly that cue. Descenders (g p q y j) hang below the
    baseline where they are unmistakable.
  * Characters are laid out by their real ink width with a guaranteed gap, so
    they never touch or overlap even after rotation (the old fixed cell was
    narrower than the widest glyphs, so W+w and m+n collided).
  * Rotation is +/-8 degrees (was +/-18) and the global ripple is 1-2px.
  * Interference is drawn BEHIND the glyphs, so no stroke is ever erased, and
    the background clutter is lighter and sparser than before.
  * Because the letters are cleanly separated, "cut the image at the empty
    columns" would otherwise split it into characters — measured, a crude
    solver (threshold, cut at gaps, template-match) read 97.7% of an earlier
    version with no connector. So two curves run the whole width of the word
    behind the letters: a dark 3px one hugging the baseline (it reads as an
    underline, and is hidden behind the bottom of every round letter) and a thin
    one in the text band. They join the word into one blob of ink and never
    cross a stroke. A first version ran the thick curve through the middle of
    the letters and turned a 'P' into something like an 'e'.
  * Each letter is also widened or narrowed, slanted and rippled on its own
    (smoothly, sub-pixel — whole-pixel row shifts left stair-steps that made
    'd' and 'p' look damaged). Height is never varied: it is the case cue.
  * The alphabet is a curated list (captcha_alphabet.py) with the look-alike
    characters removed; this module renders whatever it is given.

── What's cosmetic vs. security-relevant ────────────────────────────────────
Every `random.*` call in this module is COSMETIC: which style, where a line
goes, how a character is rotated or coloured. None of it decides which
characters were chosen — that is `captcha_service._generate_value`, using
`secrets.choice` (CSPRNG-backed), which never touches this module at all: it
plans the value first, and only THEN calls `render()` with the finished
string. A predictable `random` seed here would make the picture predictable,
never the answer.
"""
from __future__ import annotations

import math
import random
from functools import lru_cache
from io import BytesIO
from typing import NamedTuple
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 300x90 (about 3.3:1). Clients draw it at this aspect ratio — see
# packages/app/src/features/Captcha.tsx and apps/mobile/.../CaptchaField.tsx.
_WIDTH = 300
_HEIGHT = 90
_MARGIN = 14

# Bundled, unmodified (licence next to it) so the rendering is identical on a
# developer machine, in CI and in the slim container image, none of which can
# be assumed to have system fonts.
_FONT_PATH = Path(__file__).resolve().parent.parent / "assets" / "fonts" / "DejaVuSans-Bold.ttf"
_FONT_SIZE = 44
_MIN_FONT_SIZE = 34  # the layout shrinks the type, never the spacing, to fit wide strings
_GAP_RANGE = (9, 14)  # px of clear space between neighbouring glyphs' ink
_MAX_ROTATION = 8.0  # degrees either way
_BASELINE_Y = 62
_BASELINE_JITTER = 2  # px, per character
_GLYPH_PAD = 14  # headroom around a glyph's ink so rotation cannot clip it
# Per-glyph variation that changes a letter's OUTLINE without changing its
# HEIGHT. Height is what separates 'a' from 'A' (the answer is case-sensitive),
# so it is never randomized; width and slant are, which is what stops one set
# of clean templates from matching every image.
_WIDTH_SCALE = (0.9, 1.1)
_SHEAR = (-0.18, 0.18)
_GLYPH_RIPPLE = (1.0, 2.5)  # px of sideways wobble per letter

# One of these is picked per render — see the module docstring for why a
# style SYSTEM, not a single fixed look, is the actual anti-OCR property.
_STYLES = ("NOISE", "LINES", "CURVES", "GRID", "DOTS", "WAVE", "DISTORTION", "MIXED")


def _pick_style() -> str:
    """Cosmetic choice only (see the module docstring) — split out as its own
    function so a test can assert the selection actually varies, without
    having to reverse-engineer which style a rendered PNG used."""
    return random.choice(_STYLES)


def render(value: str) -> bytes:
    """PNG bytes for `value`, rendered in a randomly chosen style with
    independently randomized parameters. Never logs or returns `value` itself
    — the caller (captcha_service.generate_challenge) is the only place the
    plaintext exists, and only for as long as it takes to hash it."""
    style = _pick_style()
    img = _background(style)
    draw = ImageDraw.Draw(img)
    _background_interference(draw, style)
    layout = _fit_layout(value)
    x0 = (_WIDTH - layout.total) / 2 + random.uniform(-4, 4)
    _connector_curves(ImageDraw.Draw(img), x0, x0 + layout.total)
    _draw_characters(img, value, layout, x0)
    img = _warp(img)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ── Background ────────────────────────────────────────────────────────────────
def _light_color() -> tuple[int, int, int]:
    return tuple(random.randint(215, 248) for _ in range(3))  # type: ignore[return-value]


def _background(style: str) -> Image.Image:
    img = Image.new("RGB", (_WIDTH, _HEIGHT), _light_color())
    # A split (two-tone) background on roughly a third of renders, always for
    # MIXED — one more axis that varies independently of the chosen style.
    if style == "MIXED" or random.random() < 0.35:
        draw = ImageDraw.Draw(img)
        color2 = _light_color()
        if random.random() < 0.5:
            split = random.randint(_WIDTH // 3, _WIDTH * 2 // 3)
            draw.rectangle([split, 0, _WIDTH, _HEIGHT], fill=color2)
        else:
            split = random.randint(_HEIGHT // 3, _HEIGHT * 2 // 3)
            draw.rectangle([0, split, _WIDTH, _HEIGHT], fill=color2)
    return img


# ── Background-layer interference (drawn before the characters) ─────────────
def _noise_dots(draw: ImageDraw.ImageDraw, density_range: tuple[int, int] = (60, 140)) -> None:
    for _ in range(random.randint(*density_range)):
        xy = (random.randint(0, _WIDTH - 1), random.randint(0, _HEIGHT - 1))
        draw.point(xy, fill=tuple(random.randint(165, 210) for _ in range(3)))


def _straight_lines(draw: ImageDraw.ImageDraw, count_range: tuple[int, int] = (3, 7)) -> None:
    for _ in range(random.randint(*count_range)):
        xy = [
            (random.randint(0, _WIDTH), random.randint(0, _HEIGHT)),
            (random.randint(0, _WIDTH), random.randint(0, _HEIGHT)),
        ]
        draw.line(xy, fill=tuple(random.randint(135, 195) for _ in range(3)), width=random.randint(1, 2))


def _curved_lines(draw: ImageDraw.ImageDraw, count_range: tuple[int, int] = (2, 5)) -> None:
    for _ in range(random.randint(*count_range)):
        x1, y1 = random.randint(0, _WIDTH // 4), random.randint(0, _HEIGHT)
        x2, y2 = random.randint(_WIDTH * 3 // 4, _WIDTH), random.randint(0, _HEIGHT)
        amp, freq, phase = random.uniform(5, 18), random.uniform(1, 3), random.uniform(0, math.tau)
        steps = 24
        points = []
        for i in range(steps + 1):
            t = i / steps
            x = x1 + (x2 - x1) * t
            y = y1 + (y2 - y1) * t + amp * math.sin(freq * t * math.tau + phase)
            points.append((x, y))
        draw.line(
            points, fill=tuple(random.randint(135, 195) for _ in range(3)), width=random.randint(1, 2), joint="curve"
        )


def _grid(draw: ImageDraw.ImageDraw, spacing_range: tuple[int, int] = (18, 30)) -> None:
    spacing = random.randint(*spacing_range)
    color = tuple(random.randint(190, 225) for _ in range(3))
    for x in range(random.randint(0, spacing), _WIDTH, spacing):
        draw.line([(x, 0), (x, _HEIGHT)], fill=color, width=1)
    for y in range(random.randint(0, spacing), _HEIGHT, spacing):
        draw.line([(0, y), (_WIDTH, y)], fill=color, width=1)


def _dotted_pattern(draw: ImageDraw.ImageDraw, spacing_range: tuple[int, int] = (8, 14)) -> None:
    spacing = random.randint(*spacing_range)
    color = tuple(random.randint(170, 210) for _ in range(3))
    for x in range(0, _WIDTH, spacing):
        for y in range(0, _HEIGHT, spacing):
            if random.random() < 0.5:
                draw.ellipse([x - 1, y - 1, x + 1, y + 1], fill=color)


def _wave_lines(draw: ImageDraw.ImageDraw, count_range: tuple[int, int] = (2, 4)) -> None:
    for _ in range(random.randint(*count_range)):
        amp, freq, phase = random.uniform(6, 16), random.uniform(1.5, 4), random.uniform(0, math.tau)
        y0 = random.randint(10, _HEIGHT - 10)
        points = [(x, y0 + amp * math.sin(freq * (x / _WIDTH) * math.tau + phase)) for x in range(0, _WIDTH, 4)]
        draw.line(points, fill=tuple(random.randint(135, 195) for _ in range(3)), width=1, joint="curve")


def _arcs(draw: ImageDraw.ImageDraw, count_range: tuple[int, int] = (1, 3)) -> None:
    for _ in range(random.randint(*count_range)):
        x0, y0 = random.randint(-40, _WIDTH - 40), random.randint(-40, _HEIGHT - 20)
        w, h = random.randint(60, 140), random.randint(40, 100)
        start = random.randint(0, 360)
        draw.arc(
            [x0, y0, x0 + w, y0 + h],
            start=start,
            end=start + random.randint(60, 180),
            fill=tuple(random.randint(135, 195) for _ in range(3)),
            width=random.randint(1, 2),
        )


# Which technique(s) each named style reaches for. MIXED deliberately has no
# fixed entry — it samples 2-3 techniques from the full set at random instead,
# so it isn't just "one more style" but a genuinely different composition
# every time.
_STYLE_TECHNIQUES: dict[str, list] = {
    "NOISE": [lambda d: _noise_dots(d, (80, 140))],
    "LINES": [lambda d: _straight_lines(d, (3, 5))],
    "CURVES": [lambda d: _curved_lines(d, (2, 3)), lambda d: _arcs(d, (1, 1))],
    "GRID": [lambda d: _grid(d)],
    "DOTS": [lambda d: _dotted_pattern(d)],
    "WAVE": [lambda d: _wave_lines(d, (2, 3))],
    "DISTORTION": [lambda d: _noise_dots(d, (30, 70)), lambda d: _straight_lines(d, (2, 3))],
}
_ALL_TECHNIQUES = [_noise_dots, _straight_lines, _curved_lines, _grid, _dotted_pattern, _wave_lines, _arcs]


def _background_interference(draw: ImageDraw.ImageDraw, style: str) -> None:
    if style == "MIXED":
        for fn in random.sample(_ALL_TECHNIQUES, k=2):
            fn(draw)
    else:
        for fn in _STYLE_TECHNIQUES[style]:
            fn(draw)
    # A light dusting of dots regardless of style, so even LINES/GRID/DOTS
    # aren't otherwise-clean backgrounds behind their signature technique.
    _noise_dots(draw, (15, 35))


# ── Characters ────────────────────────────────────────────────────────────────
def _readable_dark_color() -> tuple[int, int, int]:
    """Independently randomized per character. Mostly a dark grey/near-black
    at a random value (never so light it's illegible); occasionally a slight
    hue tint on one channel ("slightly colored" per the brief) — never a
    light/low-contrast color."""
    if random.random() < 0.25:
        base = [random.randint(15, 70) for _ in range(3)]
        base[random.randint(0, 2)] = random.randint(70, 130)
        return tuple(base)  # type: ignore[return-value]
    v = random.randint(15, 75)
    return (v, v, v)


class _Layout(NamedTuple):
    sizes: list[int]  # font size per character
    scales: list[float]  # horizontal scale per character
    gaps: list[int]  # clear space after each character but the last
    boxes: list[tuple[int, int, int, int]]  # unscaled ink box per character, baseline origin
    total: int  # width of the whole word: scaled ink plus gaps


def _fit_layout(value: str) -> _Layout:
    """Where each character goes.

    Characters are placed by their real (scaled) ink width plus a random gap
    that is never below `_GAP_RANGE[0]`, so a wide 'M' and a narrow 'f' both get
    the same clear space. If the string is wider than the canvas the TYPE
    shrinks (down to `_MIN_FONT_SIZE`); the gaps only ever fall back to their
    minimum."""
    gaps = [random.randint(*_GAP_RANGE) for _ in value[1:]]
    scales = [random.uniform(*_WIDTH_SCALE) for _ in value]
    jitter = [random.randint(-1, 1) for _ in value]  # +/-1px of size: not enough to blur the case cue
    base = _FONT_SIZE
    while True:
        sizes = [base + j for j in jitter]
        boxes = [_font(sz).getbbox(ch, anchor="ls") for ch, sz in zip(value, sizes, strict=True)]
        ink = sum((b[2] - b[0]) * sx for b, sx in zip(boxes, scales, strict=True))
        total = round(ink + sum(gaps))
        if total <= _WIDTH - 2 * _MARGIN:
            return _Layout(sizes, scales, gaps, boxes, total)
        if base <= _MIN_FONT_SIZE:
            # Smallest type and still too wide (a run of M/m/H/N): spend the
            # random slack in the gaps. Six of the widest letters with minimum
            # gaps measure well inside the space available, so this fits.
            gaps = [_GAP_RANGE[0]] * len(gaps)
            return _Layout(sizes, scales, gaps, boxes, round(ink + sum(gaps)))
        base -= 2


def _draw_characters(img: Image.Image, value: str, layout: _Layout, x: float) -> None:
    for i, ch in enumerate(value):
        left, _top, right, _bottom = layout.boxes[i]
        sx = layout.scales[i]
        ink_w = right - left
        layer_w = int(ink_w * _WIDTH_SCALE[1]) + 2 * _GLYPH_PAD
        glyph = Image.new("RGBA", (layer_w, _HEIGHT), (0, 0, 0, 0))
        # Every glyph is drawn on the SAME baseline (anchor "ls"), whatever its
        # height — that is what lets a reader compare a lower-case letter's size
        # with its neighbours' and what lets g/p/q/y/j hang below the line.
        ImageDraw.Draw(glyph).text(
            ((layer_w - ink_w) / 2 - left, _BASELINE_Y),
            ch,
            font=_font(layout.sizes[i]),
            anchor="ls",
            fill=_readable_dark_color() + (255,),
        )
        # Width scale about the glyph's centre plus a slant about the baseline.
        # PIL maps each OUTPUT pixel to an input pixel: x_in = (x-cx)/sx + cx + shear*(y-baseline).
        cx, shear = layer_w / 2, random.uniform(*_SHEAR)
        glyph = glyph.transform(
            glyph.size,
            Image.AFFINE,
            (1 / sx, shear, cx - cx / sx - shear * _BASELINE_Y, 0, 1, 0),
            resample=Image.BICUBIC,
        )
        # Each letter gets its OWN ripple, so no two letters are bent alike and a
        # template matched to one will not match the next.
        glyph = _ripple(glyph, random.uniform(*_GLYPH_RIPPLE), random.uniform(24, 40))
        glyph = glyph.rotate(random.uniform(-_MAX_ROTATION, _MAX_ROTATION), resample=Image.BICUBIC)
        dy = random.randint(-_BASELINE_JITTER, _BASELINE_JITTER)
        scaled_w = ink_w * sx
        img.paste(glyph, (round(x + scaled_w / 2 - layer_w / 2), dy), glyph)
        x += scaled_w + (layout.gaps[i] if i < len(layout.gaps) else 0)


@lru_cache(maxsize=None)
def _font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(_FONT_PATH), size)


# ── Connector curves (drawn BEHIND the characters) ──────────────────────────
def _connector_curves(draw: ImageDraw.ImageDraw, left: float, right: float) -> None:
    """Two curves running the full width of the word, drawn before the glyphs so
    a stroke is never cut. They make the whole word one connected blob of ink:
    "cut at the empty columns" then finds one piece, not six.

    * A dark 3px curve that HUGS THE BASELINE. It survives both a brightness
      threshold and a 3x3 morphological opening, so removing it takes an opening
      wide enough to erode the letters' own thin strokes. Down there it is hidden
      behind the bottom stroke of every round letter and reads as an underline
      under the open-bottomed ones; the same curve through the middle of the
      letters turned a 'P' into something like an 'e'.
    * A thin curve (1-2px, darker or lighter) anywhere in the text band.

    Both are 1-3px against ~6px strokes, which keeps them easy to read past."""
    span = max(right - left, 1.0)
    thick_y = _BASELINE_Y - random.randint(2, 5)
    thin_y = random.randint(_BASELINE_Y - 28, _BASELINE_Y - 8)
    curves = (
        (3, random.randint(60, 85), thick_y, random.uniform(1.5, 3.5)),
        (random.choice((1, 2)), random.randint(60, 105), thin_y, random.uniform(3, 8)),
    )
    for width, shade, y0, amp in curves:
        freq, phase = random.uniform(0.8, 1.8), random.uniform(0, math.tau)
        points = [
            (x, y0 + amp * math.sin(freq * ((x - left) / span) * math.tau + phase))
            for x in range(int(left) - 6, int(right) + 7, 2)
        ]
        draw.line(points, fill=(shade, shade, shade), width=width, joint="curve")


# ── Ripple (per glyph, and over the whole image) ────────────────────────────
def _ripple(img: Image.Image, amplitude: float, period: float) -> Image.Image:
    """A horizontal sine-wave ripple: each pixel row is shifted sideways by a
    row-dependent, SUB-PIXEL amount (bilinear). Whole-pixel shifts leave stair
    steps along every curve, which is exactly the kind of damage that makes a
    'd' look like something else. `img` must be RGBA: what the shift uncovers at
    the edges is transparent, never a stripe of the wrong colour."""
    phase = random.uniform(0, math.tau)
    w, h = img.size
    mesh = []
    for y in range(h):
        dx = amplitude * math.sin(2 * math.pi * y / period + phase)
        # output band (0, y, w, y+1) is sampled from the source band moved by -dx
        mesh.append(((0, y, w, y + 1), (-dx, y, -dx, y + 1, w - dx, y + 1, w - dx, y)))
    return img.transform(img.size, Image.MESH, mesh, resample=Image.BILINEAR)


def _warp(img: Image.Image) -> Image.Image:
    """A gentle ripple across the whole composited image."""
    fill = img.getpixel((0, 0))
    rippled = _ripple(img.convert("RGBA"), random.uniform(1.0, 2.0), random.uniform(28, 48))
    return Image.alpha_composite(Image.new("RGBA", img.size, fill + (255,)), rippled).convert("RGB")
