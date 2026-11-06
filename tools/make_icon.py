#!/usr/bin/env python3
"""Turn a portrait photo into Tatko's 8-bit style app icon.

Usage:  /usr/bin/python3 tools/make_icon.py <portrait.png> <out_dir>

Pipeline: square crop on the face -> downsample to a 40x40 sprite ->
quantize to a small palette -> replace the studio-grey background with
an arcade colour and a CRT frame -> upscale with nearest-neighbour so
every sprite pixel stays a crisp square.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance

SPRITE = 40                     # sprite resolution (pixels per side)
CROP = (250, 95, 1135, 980)     # face-centred square in the source photo
# A 16-colour, home-computer style palette (skin ramp, greys, neons).
RETRO_PALETTE = [
    (0, 0, 0), (29, 43, 83), (126, 37, 83), (0, 135, 81),
    (171, 82, 54), (95, 87, 79), (194, 195, 199), (255, 241, 232),
    (255, 0, 77), (255, 163, 0), (255, 236, 39), (0, 228, 54),
    (41, 173, 255), (131, 118, 156), (255, 119, 168), (255, 204, 170),
    (130, 130, 130), (222, 140, 100), (90, 45, 30),
]
BG = (34, 18, 74)               # deep arcade purple
FRAME = (255, 214, 0)           # coin-op yellow
FRAME_DARK = (255, 64, 160)     # neon pink inner line


def sprite_from_photo(path):
    img = Image.open(path).convert("RGB").crop(CROP)
    # Gentle pre-sharpen so features survive the downsample.
    img = img.filter(ImageFilter.UnsharpMask(radius=6, percent=120, threshold=2))
    img = ImageEnhance.Contrast(img).enhance(1.35)
    img = ImageEnhance.Color(img).enhance(1.15)
    small = img.resize((SPRITE, SPRITE), Image.BOX)
    pal = Image.new("P", (1, 1))
    flat = [c for rgb in RETRO_PALETTE for c in rgb]
    pal.putpalette(flat + flat[:3] * (256 - len(RETRO_PALETTE)))
    # No smoothing afterwards: it erases the eyes and the smile.
    return small.quantize(palette=pal, dither=Image.NONE).convert("RGB")


def is_backdrop(rgb):
    r, g, b = rgb
    sat = max(rgb) - min(rgb)
    return sat < 14 and 95 <= (r + g + b) / 3 <= 165


def knock_out_background(sprite):
    """Flood-fill from the border through grey, unsaturated pixels."""
    w, h = sprite.size
    px = sprite.load()
    seen = set()
    stack = [(x, y) for x in range(w) for y in (0, h - 1)] + \
            [(x, y) for y in range(h) for x in (0, w - 1)]
    while stack:
        x, y = stack.pop()
        if (x, y) in seen or not (0 <= x < w and 0 <= y < h):
            continue
        if not is_backdrop(px[x, y]):
            continue
        seen.add((x, y))
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    for (x, y) in seen:
        px[x, y] = BG
    return sprite


def framed(sprite, size):
    """Scale sprite to `size` and draw a chunky arcade bezel."""
    unit = max(1, size // (SPRITE + 4))           # one sprite pixel on screen
    canvas = Image.new("RGB", (unit * (SPRITE + 4),) * 2, FRAME)
    d = ImageDraw.Draw(canvas)
    d.rectangle([unit, unit, unit * (SPRITE + 3) - 1, unit * (SPRITE + 3) - 1], fill=FRAME_DARK)
    canvas.paste(sprite.resize((unit * SPRITE,) * 2, Image.NEAREST), (unit * 2, unit * 2))
    return canvas.resize((size, size), Image.NEAREST)


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    sprite = knock_out_background(sprite_from_photo(src))
    sprite.resize((SPRITE * 16,) * 2, Image.NEAREST).save(out / "tatko-sprite.png")
    for s in (16, 32, 48, 64, 128, 180, 256, 512):
        # Small sizes: plain sprite reads better than a framed one.
        img = sprite.resize((s, s), Image.NEAREST) if s <= 32 else framed(sprite, s)
        img.save(out / f"icon-{s}.png")
    framed(sprite, 256).save(out / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("icons written to", out)


if __name__ == "__main__":
    main()
