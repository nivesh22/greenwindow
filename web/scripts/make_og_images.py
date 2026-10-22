"""Draw the 1200x630 share images (og:image) for the public pages into web/public/og/.

One-off, not part of the build: rerun after changing a headline and commit the PNGs.
    .venv/Scripts/python web/scripts/make_og_images.py   (Windows)   or   .venv/bin/python web/scripts/make_og_images.py
Uses Pillow and the DejaVu font bundled with matplotlib, both already in the pipeline environment
(docs/decisions.md, 2026-10-22).
"""

from __future__ import annotations

from pathlib import Path

import matplotlib
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / "public" / "og"
FONTS = Path(matplotlib.get_data_path()) / "fonts" / "ttf"
W, H = 1200, 630
BRAND = (13, 122, 78)  # #0d7a4e, the favicon green
MINT = (143, 240, 189)  # #8ff0bd
INK = (24, 38, 32)
INK_2 = (74, 92, 84)
CANVAS = (248, 251, 249)

# Keys match the prerendered file names (src/lib/seo.ts ogImageUrl).
PAGES: dict[str, str] = {
    "home": "When is Great Britain's grid cleanest in the next 48 hours?",
    "scheduler": "Plan a flexible job for the cleanest hours on the grid",
    "leaderboard": "How accurate are GB carbon intensity forecasts?",
    "backtest": "Backtest: every model scored on 90 past forecasts",
    "about": "How GreenWindow works, and what it cannot tell you",
    "privacy": "Privacy policy",
    "terms": "Terms of service",
}
TAGLINE = "Great Britain grid carbon intensity · 48-hour forecast"


def font(bold: bool, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")), size)


def wrap(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines: list[str] = []
    for word in text.split():
        trial = f"{lines[-1]} {word}" if lines else word
        if lines and draw.textlength(trial, font=f) <= width:
            lines[-1] = trial
        else:
            lines.append(word)
    return lines


def bezier(p0, p1, p2, p3, n: int = 24) -> list[tuple[float, float]]:
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append(
            (
                u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
            )
        )
    return pts


def logo(draw: ImageDraw.ImageDraw, x: int, y: int, size: int) -> None:
    """The favicon mark: green tile, white wave, mint bar (viewBox 0 0 32 32)."""
    s = size / 32
    draw.rounded_rectangle((x, y, x + size, y + size), radius=8 * s, fill=BRAND)
    # M5 10.5 c5 0 6 11 11 11 s6 -11 11 -11
    a = bezier((5, 10.5), (10, 10.5), (11, 21.5), (16, 21.5))
    b = bezier((16, 21.5), (21, 21.5), (22, 10.5), (27, 10.5))
    pts = [(x + px * s, y + py * s) for px, py in a + b[1:]]
    draw.line(pts, fill="white", width=round(2.6 * s), joint="curve")
    for px, py in (pts[0], pts[-1]):
        r = 1.3 * s
        draw.ellipse((px - r, py - r, px + r, py + r), fill="white")
    draw.rounded_rectangle((x + 11.5 * s, y + 24.5 * s, x + 20.5 * s, y + 27.1 * s), radius=1.3 * s, fill=MINT)


def make(name: str, headline: str) -> None:
    img = Image.new("RGB", (W, H), CANVAS)
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, W, 14), fill=BRAND)
    logo(d, 72, 72, 72)
    d.text((168, 84), "GreenWindow", font=font(True, 44), fill=INK)
    size = 64 if len(headline) < 40 else 56
    f = font(True, size)
    lines = wrap(d, headline, f, W - 144)[:3]
    y = 210
    for line in lines:
        d.text((72, y), line, font=f, fill=INK)
        y += round(size * 1.22)
    d.text((72, H - 104), TAGLINE, font=font(False, 30), fill=INK_2)
    d.text((72, H - 60), "greenwindow.uk", font=font(True, 28), fill=BRAND)
    img.save(OUT / f"{name}.png", optimize=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, headline in PAGES.items():
        make(name, headline)
    print(f"wrote {len(PAGES)} images to {OUT}")


if __name__ == "__main__":
    main()
