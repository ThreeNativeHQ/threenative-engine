"""Labelled sheet of a sameness gate run (PRD-646): the two engines' ID frames and where they disagree.

  python3 -I tools/unreal-reference/sameness-sheet.py <out.png> --captures <root> --scene cornell
      [--pose cornell ...] [--before <root>] [--crop x,y,w,h]

<root> is a capture root the gate has run on (`pnpm unreal-look:compare --sameness --captures <root>`).
It holds overlap/<scene>/ID/<pose>.png (the overlap) and <pose>.unreal.png / <pose>.threenative.png (each
engine's frame redrawn in the exact colour of each object, so equal objects have equal colours).
--scene is the capture folder of the scene: cornell, sunlit-room, shadow/foliage, or reference.

One row per pose. Columns: UNREAL 5.8.3 · ID | WASM ENGINE · ID | OVERLAP · ID (white: the engines draw
a failing object differently). With --before <root>, a second gate run on the same Unreal frames:
WASM ENGINE BEFORE · ID | WASM ENGINE AFTER · ID | UNREAL 5.8.3 · ID | OVERLAP AFTER · ID.
--crop adds a row per pose with that region (full-frame pixels) enlarged to the width of a cell.
Every header names the layer (ID) and the scene and pose, so a reader knows what each frame is.
"""

import argparse
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 640, 360


def font(size):
    for path in ("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def folder(root, scene):
    return os.path.join(root, "overlap", "ID" if scene == "reference" else os.path.join(scene, "ID"))


def poses_of(root, scene):
    names = sorted(
        f[: -len(".png")]
        for f in os.listdir(folder(root, scene))
        if f.endswith(".png") and not f.endswith((".unreal.png", ".threenative.png"))
    )
    if not names:
        raise SystemExit(f"TN_SAMENESS_SHEET_MISSING: no overlap frame under {folder(root, scene)}")
    return names


def frame(root, scene, pose, kind):
    """The pose's overlap frame (kind ''), or one engine's classified frame ('unreal', 'threenative')."""
    suffix = f".{kind}.png" if kind else ".png"
    path = os.path.join(folder(root, scene), f"{pose}{suffix}")
    if not os.path.exists(path):
        raise SystemExit(f"TN_SAMENESS_SHEET_MISSING: {path}")
    return Image.open(path).convert("RGB")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("--captures", required=True)
    parser.add_argument("--scene", required=True)
    parser.add_argument("--pose", action="append", default=[])
    parser.add_argument("--before")
    parser.add_argument("--crop")
    args = parser.parse_args()
    poses = args.pose or poses_of(args.captures, args.scene)
    # (header, root, kind): the frames of one column.
    if args.before:
        columns = [
            ("WASM ENGINE BEFORE · ID", args.before, "threenative"),
            ("WASM ENGINE AFTER · ID", args.captures, "threenative"),
            ("UNREAL 5.8.3 · ID", args.captures, "unreal"),
            ("OVERLAP AFTER · ID", args.captures, ""),
        ]
    else:
        columns = [
            ("UNREAL 5.8.3 · ID", args.captures, "unreal"),
            ("WASM ENGINE · ID", args.captures, "threenative"),
            ("OVERLAP · ID", args.captures, ""),
        ]
    crop = tuple(int(v) for v in args.crop.split(",")) if args.crop else None
    crop_h = round(W * crop[3] / crop[2]) if crop else 0
    row_h = H + crop_h
    sheet = Image.new("RGB", (W * len(columns), row_h * len(poses)), (0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    big = font(26)
    for row, pose in enumerate(poses):
        for col, (header, root, kind) in enumerate(columns):
            image = frame(root, args.scene, pose, kind)
            cells = [(image.resize((W, H), Image.NEAREST), 0)]
            if crop:
                x, y, w, h = crop
                cells.append((image.crop((x, y, x + w, y + h)).resize((W, crop_h), Image.NEAREST), H))
            for cell, top in cells:
                sheet.paste(cell, (col * W, row * row_h + top))
                label = header + (f"  crop {args.crop}" if top else f"  {args.scene}/{pose}")
                tx, ty = col * W + 10, row * row_h + top + 8
                draw.rectangle(draw.textbbox((tx, ty), label, font=big), fill=(0, 0, 0))
                draw.text((tx, ty), label, font=big, fill=(255, 255, 0))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    sheet.save(args.out)
    print(f"wrote {args.out} {sheet.size[0]}x{sheet.size[1]}")


if __name__ == "__main__":
    main()
