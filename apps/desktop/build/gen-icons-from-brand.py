#!/usr/bin/env python3
"""Generate every desktop icon from the REAL brand mark (assets/logo.png).

WHY THIS EXISTS
───────────────
build/icon.svg was a hand-written 48x48 approximation of the BlissWork mark —
square-cornered "B", oversized rectangular bubble — and every desktop icon
(icon.png, icon.ico, icon.icns, the AppX tiles) was rendered from it. It is
visibly NOT the brand logo in assets/logo.png, which has a rounded "B" and a
smaller bubble with a tail.

So the shipped app carried an approximation of its own logo. This script makes
assets/logo.png the single source for every raster the desktop app ships.

    python3 apps/desktop/build/gen-icons-from-brand.py

RESOLUTION NOTE
───────────────
assets/logo.png is 257x237. That is ample for Windows (.ico tops out at 256)
and fine for the AppX tiles, but it must be UPSCALED for the 1024x1024 slot
macOS wants. Upscaling is done with LANCZOS and is honest about the ceiling:
if a vector or larger master ever exists, point SOURCE at it and rerun — the
rest of this script does not change.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "assets" / "logo.png"
BUILD = ROOT / "apps" / "desktop" / "build"
APPX = BUILD / "appx"

#: Fraction of the canvas left as transparent margin around the mark.
#:
#: Platform icon grids expect a little breathing room, but the previous asset
#: had ~19% padding baked in, which made the mark read small next to apps that
#: fill their canvas. 6% is tight enough to look deliberate at 16px.
MARGIN = 0.06

#: Windows .ico ladder. 16/24/32 are where the bubble tail and the three dots
#: turn to mush, which is exactly the sizes users see most (taskbar, alt-tab).
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

#: AppX tiles. Names are fixed by the Store manifest.
APPX_TILES = {
    "Square44x44Logo.png": (44, 44),
    "Square150x150Logo.png": (150, 150),
    "Wide310x150Logo.png": (310, 150),
    "LargeTile.png": (310, 310),
    "SmallTile.png": (71, 71),
    "StoreLogo.png": (50, 50),
    "SplashScreen.png": (620, 300),
}


#: Fully background: at or above this in every channel.
_WHITE = 240
#: Fringe floor. Between this and _WHITE a pixel is an ANTIALIASED edge — part
#: background, part mark — and gets partial alpha rather than being kept opaque.
#: Without this the mark ships with a white halo, which is invisible on the
#: white source and obvious on a dark taskbar.
_FRINGE = 195


def drop_background(img: Image.Image) -> Image.Image:
    """Make the white BACKGROUND transparent without punching out the bubble.

    assets/logo.png ships on an opaque white background (only two alpha values
    in the whole file). An app icon needs transparency, or it renders as a white
    tile on a dark taskbar.

    The naive fix — "make every white pixel transparent" — destroys the mark,
    because the speech bubble and the three dots' surround are also white. So
    this flood-fills inward from the BORDER only. The bubble is fully enclosed
    by the "B", so the fill can never reach it.
    """
    img = img.copy()
    w, h = img.size
    px = img.load()

    # Seed from every border pixel, then breadth-first inward.
    stack = [(x, y) for x in range(w) for y in (0, h - 1)]
    stack += [(x, y) for y in range(h) for x in (0, w - 1)]
    seen = set()
    while stack:
        x, y = stack.pop()
        if (x, y) in seen or not (0 <= x < w and 0 <= y < h):
            continue
        seen.add((x, y))

        r, g, b, a = px[x, y]
        if a == 0:
            continue
        level = min(r, g, b)
        if level >= _WHITE:
            px[x, y] = (r, g, b, 0)  # pure background
        elif level >= _FRINGE:
            # Antialiased edge: the whiter it is, the more background it was.
            coverage = (_WHITE - level) / (_WHITE - _FRINGE)
            px[x, y] = (r, g, b, int(a * coverage))
        else:
            continue  # solid mark — stop the fill here
        stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return img


def trimmed(img: Image.Image) -> Image.Image:
    """Crop away the transparent border so padding is ours to control."""
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def _scaled(img: Image.Image, box_w: int, box_h: int) -> Image.Image:
    """Fit into the box preserving aspect ratio, scaling UP as well as down.

    `Image.thumbnail` only ever shrinks, so using it here silently left the mark
    at its 257px source size on a 1024px canvas — a tiny logo adrift in empty
    space. `resize` with an explicit factor is what actually fills the canvas.
    """
    factor = min(box_w / img.width, box_h / img.height)
    return img.resize(
        (max(1, round(img.width * factor)), max(1, round(img.height * factor))),
        Image.LANCZOS,
    )


def square(img: Image.Image, size: int, margin: float = MARGIN) -> Image.Image:
    """Center the mark on a transparent square canvas, never distorting it —
    a stretched logo is worse than a small one."""
    inner = max(1, int(size * (1 - 2 * margin)))
    scaled = _scaled(img, inner, inner)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2), scaled)
    return canvas


def fit(img: Image.Image, w: int, h: int, margin: float = MARGIN) -> Image.Image:
    """Center on a non-square canvas (the wide tile / splash screen)."""
    scaled = _scaled(img, max(1, int(w * (1 - 2 * margin))), max(1, int(h * (1 - 2 * margin))))
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(scaled, ((w - scaled.width) // 2, (h - scaled.height) // 2), scaled)
    return canvas


def main() -> int:
    if not SOURCE.exists():
        print(f"✗ brand source not found: {SOURCE}", file=sys.stderr)
        return 1

    src = trimmed(drop_background(Image.open(SOURCE).convert("RGBA")))
    print(f"source {SOURCE.name}: {src.width}x{src.height} (background dropped, trimmed)")
    if max(src.width, src.height) < 512:
        print(
            f"! note: source is {max(src.width, src.height)}px, so the 1024 macOS slot is\n"
            "  upscaled. Windows (<=256) and the AppX tiles are at or above native.",
        )

    APPX.mkdir(parents=True, exist_ok=True)

    master = square(src, 1024)
    master.save(BUILD / "icon.png")
    print(f"✓ icon.png            1024x1024")

    master.save(
        BUILD / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
    )
    print(f"✓ icon.ico            {', '.join(str(s) for s in ICO_SIZES)}")

    for name, (w, h) in APPX_TILES.items():
        (fit(src, w, h) if w != h else square(src, w)).save(APPX / name)
    print(f"✓ appx/               {len(APPX_TILES)} tiles")

    print("\nicon.icns is NOT written here — see gen-desktop-icons.sh, which needs")
    print("png2icns/iconutil. Run that after this script to refresh macOS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
