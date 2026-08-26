"""CAPTCHA rendering pipeline — turns a plaintext value into distorted PNG
bytes. Split out of captcha_service.py (which owns generation/storage/
validation) because rendering is a genuinely separate concern and was about
to make that module too large.

── Why this is harder to read for OCR than the previous version ─────────────
The prior renderer drew one style (a straight character row, uniform-ish
noise) every time — visually consistent output is exactly what a
model/script can learn to strip. This version instead runs a genuinely
randomized PIPELINE: one of several background/interference STYLES is
chosen per call, and within it every geometric parameter (line count,
angle, curve amplitude/frequency, dot density, grid spacing, split-background
position, per-character rotation/scale/color/position, and whether a global
warp is applied) is independently re-randomized. No two calls compose the
same way, which is the actual point — a fixed background with just a
different color palette would not be.

── What's cosmetic vs. security-relevant ────────────────────────────────────
Every `random.*` call in this module is COSMETIC: which style, where a line
goes, how a character is rotated/scaled/colored. None of it decides which
6 characters were chosen — that is `captcha_service._generate_value`, using
`secrets.choice` (CSPRNG-backed), which never touches this module at all: it
plans the value first, and only THEN calls `render()` with the finished
string. A predictable `random` seed here would make the picture predictable,
never the answer.

── Legibility trade-offs, stated plainly ────────────────────────────────────
Two things are deliberately narrowed from what a "maximum distortion" version
would do, because this is a 6-character CASE-SENSITIVE alphabet and a human
has to be able to tell letters apart, not just detect that *a* character is
there:
  * Per-character scale is kept close to 1.0 (0.92-1.10) — a wider range
    made same-shape case pairs (C/c, S/s, U/u, V/v, W/w, X/x, Z/z) genuinely
    ambiguous when a lowercase letter was drawn larger than the uppercase one
    a moment later.
  * The global warp amplitude is kept small (1.5-3.5px) — combined with
    per-character rotation, a larger amplitude compounded into character
    shapes a human could no longer confidently separate.
Both were tuned by generating and visually reviewing dozens of samples across
every style, not chosen a priori.
"""
from __future__ import annotations

import math
import random
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

_WIDTH = 190
_HEIGHT = 90
_FONT_SIZE_RANGE = (32, 42)
_MARGIN = 12

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
    _draw_characters(img, value)
    # Drawn AFTER the characters so these lines visually cross them, not just
    # sit behind them — the point is broken/occluded strokes, not a clean
    # character shape with decoration around it.
    _foreground_interference(ImageDraw.Draw(img))
    if style in ("WAVE", "DISTORTION", "MIXED") or random.random() < 0.3:
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
        draw.point(xy, fill=tuple(random.randint(150, 210) for _ in range(3)))


def _straight_lines(draw: ImageDraw.ImageDraw, count_range: tuple[int, int] = (3, 7)) -> None:
    for _ in range(random.randint(*count_range)):
        xy = [
            (random.randint(0, _WIDTH), random.randint(0, _HEIGHT)),
            (random.randint(0, _WIDTH), random.randint(0, _HEIGHT)),
        ]
        draw.line(xy, fill=tuple(random.randint(120, 190) for _ in range(3)), width=random.randint(1, 2))


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
            points, fill=tuple(random.randint(120, 190) for _ in range(3)), width=random.randint(1, 2), joint="curve"
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
        draw.line(points, fill=tuple(random.randint(120, 190) for _ in range(3)), width=1, joint="curve")


def _arcs(draw: ImageDraw.ImageDraw, count_range: tuple[int, int] = (1, 3)) -> None:
    for _ in range(random.randint(*count_range)):
        x0, y0 = random.randint(-40, _WIDTH - 40), random.randint(-40, _HEIGHT - 20)
        w, h = random.randint(60, 140), random.randint(40, 100)
        start = random.randint(0, 360)
        draw.arc(
            [x0, y0, x0 + w, y0 + h],
            start=start,
            end=start + random.randint(60, 180),
            fill=tuple(random.randint(120, 190) for _ in range(3)),
            width=random.randint(1, 2),
        )


# Which technique(s) each named style reaches for. MIXED deliberately has no
# fixed entry — it samples 2-3 techniques from the full set at random instead,
# so it isn't just "one more style" but a genuinely different composition
# every time.
_STYLE_TECHNIQUES: dict[str, list] = {
    "NOISE": [lambda d: _noise_dots(d, (100, 180))],
    "LINES": [lambda d: _straight_lines(d, (4, 8))],
    "CURVES": [lambda d: _curved_lines(d, (2, 4)), lambda d: _arcs(d, (1, 2))],
    "GRID": [lambda d: _grid(d)],
    "DOTS": [lambda d: _dotted_pattern(d)],
    "WAVE": [lambda d: _wave_lines(d, (2, 3))],
    "DISTORTION": [lambda d: _noise_dots(d, (40, 90)), lambda d: _straight_lines(d, (2, 4))],
}
_ALL_TECHNIQUES = [_noise_dots, _straight_lines, _curved_lines, _grid, _dotted_pattern, _wave_lines, _arcs]


def _background_interference(draw: ImageDraw.ImageDraw, style: str) -> None:
    if style == "MIXED":
        for fn in random.sample(_ALL_TECHNIQUES, k=random.randint(2, 3)):
            fn(draw)
    else:
        for fn in _STYLE_TECHNIQUES[style]:
            fn(draw)
    # A light dusting of dots regardless of style, so even LINES/GRID/DOTS
    # aren't otherwise-clean backgrounds behind their signature technique.
    _noise_dots(draw, (20, 50))


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


def _draw_characters(img: Image.Image, value: str) -> None:
    n = len(value)
    cell_w = (_WIDTH - 2 * _MARGIN) // n
    glyph_box = cell_w + 26  # headroom so rotation/scale don't clip
    for i, ch in enumerate(value):
        font = ImageFont.load_default(size=random.randint(*_FONT_SIZE_RANGE))
        glyph = Image.new("RGBA", (glyph_box, _HEIGHT), (0, 0, 0, 0))
        gdraw = ImageDraw.Draw(glyph)
        gdraw.text(
            (glyph_box * 0.22, _HEIGHT * random.uniform(0.15, 0.32)),
            ch,
            font=font,
            fill=_readable_dark_color() + (255,),
        )
        glyph = glyph.rotate(random.uniform(-18, 18), resample=Image.BICUBIC, expand=0)
        # Narrow range — see the module docstring on same-shape case pairs
        # (C/c, S/s, U/u, V/v, W/w, X/x, Z/z).
        scale = random.uniform(0.92, 1.10)
        if abs(scale - 1.0) > 0.02:
            new_size = (max(1, int(glyph_box * scale)), max(1, int(_HEIGHT * scale)))
            glyph = glyph.resize(new_size, resample=Image.BICUBIC)
        x = _MARGIN + i * cell_w - (glyph.width - cell_w) // 2 + random.randint(-3, 3)
        y = (_HEIGHT - glyph.height) // 2 + random.randint(-8, 8)
        img.paste(glyph, (x, y), glyph)


# ── Foreground interference (drawn ON TOP of the characters) ────────────────
def _foreground_interference(draw: ImageDraw.ImageDraw) -> None:
    for _ in range(random.randint(2, 4)):
        kind = random.choice(("line", "arc", "wave"))
        color = tuple(random.randint(70, 140) for _ in range(3))
        if kind == "line":
            xy = [
                (random.randint(0, _WIDTH), random.randint(0, _HEIGHT)),
                (random.randint(0, _WIDTH), random.randint(0, _HEIGHT)),
            ]
            draw.line(xy, fill=color, width=random.randint(1, 2))
        elif kind == "arc":
            x0, y0 = random.randint(-30, _WIDTH - 60), random.randint(-20, _HEIGHT - 40)
            w, h = random.randint(50, 120), random.randint(30, 80)
            start = random.randint(0, 360)
            draw.arc([x0, y0, x0 + w, y0 + h], start=start, end=start + random.randint(80, 200), fill=color, width=1)
        else:
            amp, freq, phase = random.uniform(4, 10), random.uniform(2, 5), random.uniform(0, math.tau)
            y0 = random.randint(15, _HEIGHT - 15)
            points = [(x, y0 + amp * math.sin(freq * (x / _WIDTH) * math.tau + phase)) for x in range(0, _WIDTH, 3)]
            draw.line(points, fill=color, width=1, joint="curve")


# ── Global warp ───────────────────────────────────────────────────────────────
def _warp(img: Image.Image) -> Image.Image:
    """A gentle horizontal sine-wave ripple across the whole composited image
    — a per-row horizontal pixel shift. Pure PIL (no numpy): the canvas is
    only ~17K pixels, so a plain Python loop is fast enough at request time."""
    amplitude = random.uniform(1.5, 3.5)
    period = random.uniform(20, 40)
    phase = random.uniform(0, math.tau)
    out = Image.new("RGB", img.size, img.getpixel((0, 0)))
    src, dst = img.load(), out.load()
    w, h = img.size
    for y in range(h):
        dx = int(amplitude * math.sin(2 * math.pi * y / period + phase))
        for x in range(w):
            sx = x - dx
            if 0 <= sx < w:
                dst[x, y] = src[sx, y]
    return out
