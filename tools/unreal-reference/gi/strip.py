"""Labelled frame strip of a GI calibration scene's motion run (PRD-638).

  python3 -I tools/unreal-reference/gi/strip.py <out.png> --scene cornell --run switch --frames 58,60,61,64,70,90
      --row unreal/L7-Epic-motion:frame="UNREAL 5.8.3 · L7-Epic" --row threenative/L7:frame="WASM ENGINE · L7"
      [--diff 0,1 [--diff-label <text>]] [--captures <dir>] [--cell 384x216] [--crop x0,y0,x1,y1] [--gain 4]

One column per frame number. One row per --row, as `<engine>/<folder>:<kind>=<label>`: kind `frame` is the run's
frame NNNN (<run>.NNNN.png), kind `still` the converged still of that frame (still-NNNN.0000.png). `--diff a,b`
adds a row of |row a - row b| times --gain (for ghosting: a moving frame against its still). Every cell carries
its row label, which names the engine and the layer, and its frame number, burned in large.
"""

import argparse
import os

from PIL import Image, ImageChops, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
CAPTURES = os.path.join(HERE, "..", "captures")


def font(size):
    for path in ("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def fitted(draw, text, width, start):
    """The largest font of at most `start` pixels whose text fits `width`."""
    for size in range(start, 11, -1):
        face = font(size)
        box = draw.textbbox((0, 0), text, font=face)
        if box[2] - box[0] <= width:
            return face
    return font(12)


def parse_row(spec):
    head, _, label = spec.partition("=")
    path, _, kind = head.rpartition(":")
    engine, _, folder = path.partition("/")
    if kind not in ("frame", "still") or not engine or not folder or not label:
        raise SystemExit(f"TN_MOTION_STRIP_BAD_ROW: {spec} (want <engine>/<folder>:<frame|still>=<label>)")
    return engine, folder, kind, label


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("--scene", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--frames", required=True)
    parser.add_argument("--row", action="append", required=True)
    parser.add_argument("--diff", default=None)
    parser.add_argument("--diff-label", default=None)
    parser.add_argument("--gain", type=float, default=4.0)
    parser.add_argument("--captures", default=CAPTURES)
    parser.add_argument("--cell", default="384x216")
    parser.add_argument("--crop", default=None)
    args = parser.parse_args()
    width, height = (int(v) for v in args.cell.split("x"))
    frames = [int(f) for f in args.frames.split(",")]
    crop = [float(v) for v in args.crop.split(",")] if args.crop else None
    rows = [parse_row(spec) for spec in args.row]

    def load(engine, folder, kind, frame):
        name = f"{args.run}.{frame:04d}.png" if kind == "frame" else f"still-{frame:04d}.0000.png"
        path = os.path.join(args.captures, engine, args.scene, "motion", args.run, folder, name)
        if not os.path.exists(path):
            raise SystemExit(f"TN_MOTION_STRIP_MISSING: {path}")
        image = Image.open(path).convert("RGB")
        if crop:
            w, h = image.size
            image = image.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
        return image.resize((width, height), Image.LANCZOS)

    cells = [[load(e, f, k, frame) for frame in frames] for e, f, k, _ in rows]
    labels = [label for *_, label in rows]
    if args.diff:
        a, b = (int(v) for v in args.diff.split(","))
        cells.append(
            [
                ImageChops.difference(cells[a][i], cells[b][i]).convert("L").point(lambda v: min(255, int(v * args.gain))).convert("RGB")
                for i in range(len(frames))
            ]
        )
        labels.append(args.diff_label or f"DIFF x{args.gain:g}: row {a + 1} - row {b + 1}")
    sheet = Image.new("RGB", (width * len(frames), height * len(cells)), (0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    for r, row in enumerate(cells):
        for c, image in enumerate(row):
            sheet.paste(image, (c * width, r * height))
            x, y = c * width + 8, r * height + 6
            top = fitted(draw, labels[r], width - 16, 26)
            draw.rectangle(draw.textbbox((x, y), labels[r], font=top), fill=(0, 0, 0))
            draw.text((x, y), labels[r], font=top, fill=(255, 255, 0))
            big = font(max(22, width // 9))
            caption = f"frame {frames[c]}"
            drop = top.size + 8
            draw.rectangle(draw.textbbox((x, y + drop), caption, font=big), fill=(0, 0, 0))
            draw.text((x, y + drop), caption, font=big, fill=(255, 255, 255))
            small = font(max(12, width // 24))
            tag = f"{args.scene}/{args.run}"
            below = drop + big.size + 6
            draw.rectangle(draw.textbbox((x, y + below), tag, font=small), fill=(0, 0, 0))
            draw.text((x, y + below), tag, font=small, fill=(200, 200, 200))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    sheet.save(args.out)
    print(f"wrote {args.out} {sheet.size[0]}x{sheet.size[1]}")


if __name__ == "__main__":
    main()
