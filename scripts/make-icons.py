"""Render the extension icons (icons/icon{16,32,48,128}.png) with Pillow.

Usage: python3 scripts/make-icons.py
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

S = 1024
OUT = Path(__file__).resolve().parent.parent / "icons"


def gradient(size, top, bottom):
    img = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        d.line([(0, y), (size, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    return img


def render():
    bg = gradient(S, (99, 102, 241), (124, 58, 237))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.23), fill=255)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(icon)
    w = int(S * 0.085)
    c, r = S / 2, S * 0.30
    white = (255, 255, 255, 255)
    # Circular "go back" arrow: an arc with a gap at the top-left, plus arrow head.
    d.arc([c - r, c - r, c + r, c + r], start=-140, end=200, fill=white, width=w)
    a = math.radians(200)
    tip = (c + r * math.cos(a), c + r * math.sin(a))
    head = S * 0.13
    d.polygon([
        (tip[0] - head * 0.9, tip[1] - head * 0.15),
        (tip[0] + head * 0.55, tip[1] - head * 0.35),
        (tip[0] - head * 0.05, tip[1] + head * 0.95),
    ], fill=white)
    # Clock hands.
    d.line([(c, c - r * 0.55), (c, c)], fill=white, width=int(w * 0.85))
    d.line([(c, c), (c + r * 0.42, c + r * 0.3)], fill=white, width=int(w * 0.85))
    d.ellipse([c - w * 0.6, c - w * 0.6, c + w * 0.6, c + w * 0.6], fill=white)
    return icon


def main():
    OUT.mkdir(exist_ok=True)
    big = render()
    for size in (16, 32, 48, 128):
        big.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
    big.resize((512, 512), Image.LANCZOS).save(OUT / "icon512.png")


if __name__ == "__main__":
    main()
