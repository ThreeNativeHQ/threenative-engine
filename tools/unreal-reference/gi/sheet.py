"""Labelled WASM ENGINE / UNREAL sheet for a GI calibration scene (PRD-638, PRD-647).

  python3 -I tools/unreal-reference/gi/sheet.py <out.png> --scene cornell --layer L7 [--arm <dir>=<label> ...]

One row per pose. Columns: each extra --arm (a folder under captures/ holding <scene>/<layer>/<pose>.png,
for example a BEFORE capture), then the ThreeNative capture, then Unreal at the variant the layer is
judged against. Every frame carries its engine name, so a reader always knows which engine drew it.
"""

import argparse
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
CAPTURES = os.path.join(HERE, "..", "captures")
# The Unreal variant each ThreeNative layer is judged against (capture-gi-threenative.ts, GI_LAYERS).
VARIANT = {"ID": "ID", "L1": "L1", "L7": "L7-Epic", "L9": "L9-Epic"}
W, H = 640, 360


def font(size):
    for path in ("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("--scene", required=True)
    parser.add_argument("--layer", required=True, choices=sorted(VARIANT))
    parser.add_argument("--arm", action="append", default=[])
    args = parser.parse_args()
    poses = [p["name"] for p in json.load(open(os.path.join(HERE, args.scene, "scene.json")))["poses"]]
    arms = [a.split("=", 1) for a in args.arm]
    arms += [["threenative", f"WASM ENGINE {args.layer}"], ["unreal", f"UNREAL 5.8.3 {VARIANT[args.layer]}"]]
    sheet = Image.new("RGB", (W * len(arms), H * len(poses)), (0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    big = font(30)
    for row, pose in enumerate(poses):
        for col, (folder, label) in enumerate(arms):
            layer = VARIANT[args.layer] if folder == "unreal" else args.layer
            path = os.path.join(CAPTURES, folder, args.scene, layer, f"{pose}.png")
            if not os.path.exists(path):
                raise SystemExit(f"TN_GI_SHEET_MISSING: {path}")
            sheet.paste(Image.open(path).convert("RGB").resize((W, H)), (col * W, row * H))
            text = f"{label}  {args.scene}/{pose}"
            x, y = col * W + 12, row * H + 10
            draw.rectangle(draw.textbbox((x, y), text, font=big), fill=(0, 0, 0))
            draw.text((x, y), text, font=big, fill=(255, 255, 0))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    sheet.save(args.out)
    print(f"wrote {args.out} {sheet.size[0]}x{sheet.size[1]}")


if __name__ == "__main__":
    main()
