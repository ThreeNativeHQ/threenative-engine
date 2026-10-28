"""Labelled WASM ENGINE / UNREAL sheet for a GI or a shadow calibration scene (PRD-638, PRD-647, PRD-649).

  python3 -I tools/unreal-reference/gi/sheet.py <out.png> --scene cornell --layer L7 [--arm <dir>=<label> ...]
      [--tn <dir>] [--tn-label <text>] [--poses a,b] [--crop x0,y0,x1,y1]

`--scene shadow:<name>` takes a scene of the shadow family: its frames sit under captures/<engine>/shadow/<name>/<layer>/
(captures/ is tools/unreal-reference/captures, or the folder TN_CAPTURES names),
the Unreal variant is named like the layer, and each cell reads "WASM ENGINE · <layer> · <pose>".

One row per pose. Columns: each extra --arm (a folder under captures/ holding <scene>/<layer>/<pose>.png,
for example a BEFORE capture), then the ThreeNative capture, then Unreal at the variant the layer is
judged against. Every frame carries its engine name, so a reader always knows which engine drew it.
`--tn` names the folder of the ThreeNative column (default `threenative`) and `--tn-label` its label. `--poses` limits the
rows. `--crop` cuts the same fractional box (0 to 1) out of every frame and scales it to the cell, for the issue region.
"""

import argparse
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
CAPTURES = os.environ.get("TN_CAPTURES") or os.path.join(HERE, "..", "captures")
# The Unreal variant each ThreeNative layer is judged against (capture-gi-threenative.ts, GI_LAYERS).
VARIANT = {"ID": "ID", "L1": "L1", "L7": "L7-Epic", "L9": "L9-Epic"}
SHADOW = "shadow:"
SHADOW_LAYERS = ("ID", "L5", "L6", "L7", "L8", "L9")
W, H = 640, 360


def scene_paths(scene):
    """The scene.json and the folder under captures/<engine>/ of a `gi` scene or a `shadow:<name>` scene."""
    if scene.startswith(SHADOW):
        name = scene[len(SHADOW):]
        return os.path.join(HERE, "..", "shadow", name, "scene.json"), os.path.join("shadow", name)
    return os.path.join(HERE, scene, "scene.json"), scene


def font(size):
    for path in ("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("--scene", required=True)
    parser.add_argument("--layer", required=True, choices=sorted(set(VARIANT) | set(SHADOW_LAYERS)))
    parser.add_argument("--arm", action="append", default=[])
    parser.add_argument("--tn", default="threenative")
    parser.add_argument("--tn-label", default=None)
    parser.add_argument("--poses", default=None)
    parser.add_argument("--crop", default=None)
    args = parser.parse_args()
    shadow = args.scene.startswith(SHADOW)
    scene_json, folder_of_scene = scene_paths(args.scene)
    poses = [p["name"] for p in json.load(open(scene_json))["poses"]]
    if args.poses:
        poses = [p for p in poses if p in args.poses.split(",")]
    crop = [float(v) for v in args.crop.split(",")] if args.crop else None
    arms = [a.split("=", 1) for a in args.arm]
    unreal_variant = args.layer if shadow else VARIANT[args.layer]
    dot = " · " if shadow else " "
    arms += [[args.tn, args.tn_label or f"WASM ENGINE{dot}{args.layer}"], ["unreal", f"UNREAL 5.8.3{dot}{unreal_variant}"]]
    sheet = Image.new("RGB", (W * len(arms), H * len(poses)), (0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    big = font(30)
    for row, pose in enumerate(poses):
        for col, (folder, label) in enumerate(arms):
            layer = unreal_variant if folder == "unreal" else args.layer
            path = os.path.join(CAPTURES, folder, folder_of_scene, layer, f"{pose}.png")
            if not os.path.exists(path):
                raise SystemExit(f"TN_GI_SHEET_MISSING: {path}")
            frame = Image.open(path).convert("RGB")
            if crop:
                w, h = frame.size
                frame = frame.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
            sheet.paste(frame.resize((W, H), Image.LANCZOS), (col * W, row * H))
            text = f"{label} · {pose}" if shadow else f"{label}"
            x, y = col * W + 12, row * H + 10
            # The label keeps its whole text: the font shrinks until the text fits the tile.
            size = 30
            label_font = big
            while draw.textlength(text, font=label_font) > W - 24 and size > 12:
                size -= 1
                label_font = font(size)
            draw.rectangle(draw.textbbox((x, y), text, font=label_font), fill=(0, 0, 0))
            draw.text((x, y), text, font=label_font, fill=(255, 255, 0))
            small = font(22)
            caption = f"{args.scene}/{pose}" + (" (close-up)" if crop else "")
            draw.rectangle(draw.textbbox((x, y + 38), caption, font=small), fill=(0, 0, 0))
            draw.text((x, y + 38), caption, font=small, fill=(255, 255, 255))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    sheet.save(args.out)
    print(f"wrote {args.out} {sheet.size[0]}x{sheet.size[1]}")


if __name__ == "__main__":
    main()
