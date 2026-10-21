"""Per-element close-ups: the same crop of every arm, side by side, one row per scene element.

  python3 -I closeups.py <out.png> --layer L9 --sun sun60 [--poses a,b] [--only Sky,Box_Red] <dir>=<label> [<dir>=<label> ...]

The crop box of each element comes from Unreal's region ID frame for that pose
(captures/unreal/ID/ID_<pose>.png, colours in tools/unreal-reference/regions.json); the cameras
match, so one box cuts the same part of the scene from every arm. Elements smaller than
MIN_PIXELS in a pose are skipped. Every crop carries its arm label.
"""

import argparse
import json
import os
import sys

from PIL import Image, ImageDraw

# -I drops the script directory from sys.path; sheet.py sits beside this file.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheet import CAPTURES, COLOURS, ROOT, font  # noqa: E402

CROP = 360  # each crop is scaled to fit this square
MIN_PIXELS = 400
PAD = 0.15  # fraction of the box added on every side
HEAD = 52  # two label lines above each crop


def boxes(pose):
    ids = Image.open(os.path.join(CAPTURES, "unreal/ID", f"ID_{pose}.png")).convert("RGB")
    regions = json.load(open(os.path.join(ROOT, "tools/unreal-reference/regions.json")))["srgb8"]
    pixels = ids.load()
    found = {}
    for y in range(ids.height):
        for x in range(ids.width):
            for name, colour in regions.items():
                if pixels[x, y] == tuple(colour):
                    b = found.setdefault(name, [x, y, x, y, 0])
                    b[0], b[1], b[2], b[3], b[4] = min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y), b[4] + 1
                    break
    out = {}
    for name, (x0, y0, x1, y1, count) in found.items():
        if count < MIN_PIXELS:
            continue
        pw, ph = (x1 - x0) * PAD, (y1 - y0) * PAD
        out[name] = (
            max(0, x0 - pw) / ids.width,
            max(0, y0 - ph) / ids.height,
            min(ids.width, x1 + pw) / ids.width,
            min(ids.height, y1 + ph) / ids.height,
        )
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("--layer", default="L9")
    parser.add_argument("--sun", default="sun60")
    parser.add_argument("--poses", default="exterior,spheres,interior,backlit")
    parser.add_argument("--only", default="", help="comma list of element names, default every element")
    parser.add_argument("arms", nargs="+")
    args = parser.parse_args()
    only = set(filter(None, args.only.split(",")))
    arms = [arm.split("=", 1) for arm in args.arms]
    rows = []
    for pose in args.poses.split(","):
        for name, box in sorted(boxes(pose).items()):
            if only and name not in only:
                continue
            rows.append((pose, name, box))
    label_font = font(20)
    sheet = Image.new("RGB", (len(arms) * CROP, len(rows) * CROP), "black")
    for row, (pose, name, (u0, v0, u1, v1)) in enumerate(rows):
        for col, (folder, label) in enumerate(arms):
            path = os.path.join(CAPTURES, folder, args.layer, f"{args.layer}_{args.sun}_{pose}.png")
            frame = Image.open(path).convert("RGB")
            crop = frame.crop((u0 * frame.width, v0 * frame.height, u1 * frame.width, v1 * frame.height))
            crop.thumbnail((CROP, CROP - HEAD), Image.LANCZOS)
            if crop.width < CROP - HEAD and crop.height < CROP - HEAD:
                scale = min((CROP - HEAD) / crop.width, (CROP - HEAD) / crop.height)
                crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.LANCZOS)
            tile = Image.new("RGB", (CROP, CROP), "black")
            tile.paste(crop, ((CROP - crop.width) // 2, HEAD + (CROP - HEAD - crop.height) // 2))
            draw = ImageDraw.Draw(tile)
            draw.text((6, 2), label, font=label_font, fill=COLOURS[col % len(COLOURS)])
            draw.text((6, 26), f"{name} · {pose}", font=label_font, fill=(230, 230, 230))
            sheet.paste(tile, (col * CROP, row * CROP))
    sheet.save(args.out)
    print(args.out, f"{len(rows)} element rows")


if __name__ == "__main__":
    main()
