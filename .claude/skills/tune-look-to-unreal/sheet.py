"""Labelled comparison sheet for the Unreal reference cells.

  python3 -I sheet.py <out.png> --layer L9 --sun sun60 <dir>=<label> [<dir>=<label> ...]

Each <dir> is a folder under tools/unreal-reference/captures/ (threenative, unreal, before,
after, ...). One row per pose, one column per arm; every frame carries its label, so a reader
always sees which engine drew it. Also writes each labelled frame next to <out.png>.
"""

import argparse
import json
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
CAPTURES = os.path.join(ROOT, "tools/unreal-reference/captures")
COLOURS = [(255, 255, 0), (0, 255, 128), (120, 200, 255), (255, 140, 200)]
W, H = 640, 360


def font(size):
    for path in ("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("--layer", default="L9")
    parser.add_argument("--sun", default="sun60")
    parser.add_argument("arms", nargs="+")
    args = parser.parse_args()
    arms = [arm.split("=", 1) for arm in args.arms]
    poses = [p["name"] for p in json.load(open(os.path.join(ROOT, "tools/unreal-reference/poses.json")))["poses"]]
    label_font = font(30)
    sheet = Image.new("RGB", (len(arms) * W, len(poses) * H), "black")
    out_dir = os.path.dirname(os.path.abspath(args.out))
    for row, pose in enumerate(poses):
        for col, (folder, label) in enumerate(arms):
            path = os.path.join(CAPTURES, folder, args.layer, f"{args.layer}_{args.sun}_{pose}.png")
            if not os.path.exists(path):
                raise SystemExit(f"TN_UNREAL_LOOK_MISSING_CELL: {path}")
            frame = Image.open(path).convert("RGB").resize((W, H))
            draw = ImageDraw.Draw(frame)
            draw.rectangle([0, 0, W, 48], fill=(0, 0, 0))
            draw.text((10, 6), f"{label}  {pose}", font=label_font, fill=COLOURS[col % len(COLOURS)])
            frame.save(os.path.join(out_dir, f"{folder}-{args.layer}-{args.sun}-{pose}.png"))
            sheet.paste(frame, (col * W, row * H))
    sheet.save(args.out)
    print(args.out)


if __name__ == "__main__":
    main()
