"""Labelled UNREAL | ENGINE BEFORE | ENGINE AFTER sheets of one calibration round (PRD-647).

  python3 -I tools/unreal-reference/gi/round_sheet.py <spec.json>

`pnpm unreal-look:calibrate` writes the spec. It lists sheets, each a list of rows, each a list of tiles
{label, sub, file}. Every tile carries its engine and layer in large text and the commit, adapter and run
below it, so a reader always knows which engine drew a frame and at which layer.
"""

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 640, 360
BAR = 74


def font(size):
    for path in ("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def sheet(spec):
    rows = spec["rows"]
    columns = max(len(row) for row in rows)
    image = Image.new("RGB", (W * columns, (H + BAR) * len(rows)), (0, 0, 0))
    draw = ImageDraw.Draw(image)
    big, small = font(25), font(17)
    for r, row in enumerate(rows):
        for c, tile in enumerate(row):
            if not os.path.exists(tile["file"]):
                raise SystemExit(f"TN_GI_SHEET_MISSING: {tile['file']}")
            x, y = c * W, r * (H + BAR)
            image.paste(Image.open(tile["file"]).convert("RGB").resize((W, H)), (x, y + BAR))
            draw.text((x + 10, y + 6), tile["label"], font=big, fill=(255, 255, 0))
            draw.text((x + 10, y + 42), tile["sub"], font=small, fill=(255, 255, 255))
    os.makedirs(os.path.dirname(os.path.abspath(spec["out"])), exist_ok=True)
    image.save(spec["out"])
    print(f"wrote {spec['out']} {image.size[0]}x{image.size[1]}")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: round_sheet.py <spec.json>")
    with open(sys.argv[1]) as handle:
        spec = json.load(handle)
    for item in spec["sheets"]:
        sheet(item)


if __name__ == "__main__":
    main()
