#!/usr/bin/env python3
"""Same-scene benchmark sheet for Unreal's pan motion run: TSR at a low screen percentage vs ThreeNative.

    python3 -I scripts/unreal-look/side-by-side.py --out <dir> --frames 30,60,90,120 \
        [--metric-frames A-B] --crop x,y,w,h ARM...

Each ARM is `<label>=<dir>[@<ref-label>]`. A dir holds `pan.NNNN.png` frames (also
`pan.NNNN.0000.png`); the first integer after `pan.` is the frame number. An arm with a `@ref-label`
is scored against that arm's dir over every frame both dirs hold (or only frames in
`--metric-frames A-B`, inclusive), not only the requested frames.

Writes `<out>/sheet.png` (one arm header row, requested frames scaled to 640 px wide on a uniform
grid, a 3x crop row at the middle requested frame, a red rectangle on that row marking the crop)
and `<out>/metrics.json` (mae, edgeError and flicker against the reference, with the metric frame
range), and prints the metrics table. Bad input exits 2.
"""

import argparse
import contextlib
import io
import json
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

CELL_W = 640
TEXT_PX = 40
BAR_PAD = 10
EDGE_SHARE = 0.9
FRAME_RE = re.compile(r"pan\.(\d+)")


@dataclass(frozen=True)
class Arm:
    label: str
    directory: Path
    reference: str | None


def fail(message: str) -> NoReturn:
    print(f"side-by-side: {message}", file=sys.stderr)
    raise SystemExit(2)


def parse_arms(specs: list[str]) -> list[Arm]:
    arms: list[Arm] = []
    labels: set[str] = set()
    for spec in specs:
        label, equals, rest = spec.partition("=")
        if not equals or not label or not rest:
            fail(f"bad ARM {spec!r}: expected <label>=<dir>[@<ref-label>]")
        directory, at, reference = rest.partition("@")
        if not directory:
            fail(f"bad ARM {spec!r}: the dir is empty")
        if label in labels:
            fail(f"duplicate ARM label {label!r}")
        labels.add(label)
        arms.append(Arm(label, Path(directory), reference if at else None))
    for arm in arms:
        if arm.reference is not None and arm.reference not in labels:
            fail(f"ARM {arm.label!r} names unknown @{arm.reference!r}")
    return arms


def frame_paths(directory: Path) -> dict[int, Path]:
    if not directory.is_dir():
        fail(f"{directory} is not a directory")
    frames: dict[int, Path] = {}
    for path in sorted(directory.glob("pan.*.png")):
        match = FRAME_RE.search(path.name)
        if match is not None:
            frames[int(match.group(1))] = path
    if not frames:
        fail(f"{directory} has no pan.*.png frames")
    return frames


def load_rgb(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0


def luma(rgb: np.ndarray) -> np.ndarray:
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def sobel_magnitude(values: np.ndarray) -> np.ndarray:
    pad = np.pad(values, 1, mode="edge")
    gx = (pad[:-2, 2:] + 2.0 * pad[1:-1, 2:] + pad[2:, 2:]) - (
        pad[:-2, :-2] + 2.0 * pad[1:-1, :-2] + pad[2:, :-2]
    )
    gy = (pad[2:, :-2] + 2.0 * pad[2:, 1:-1] + pad[2:, 2:]) - (
        pad[:-2, :-2] + 2.0 * pad[:-2, 1:-1] + pad[:-2, 2:]
    )
    return np.hypot(gx, gy)


def edge_mask(reference: np.ndarray) -> np.ndarray:
    magnitude = sobel_magnitude(luma(reference))
    return magnitude >= float(np.quantile(magnitude, EDGE_SHARE))


def summary(values: list[float]) -> dict[str, float] | None:
    if not values:
        return None
    return {"mean": float(np.mean(values)), "p95": float(np.percentile(values, 95))}


def compare(
    arm: Arm, reference: Arm, metric_frames: tuple[int, int] | None = None
) -> dict[str, Any]:
    arm_frames = frame_paths(arm.directory)
    ref_frames = frame_paths(reference.directory)
    common = sorted(set(arm_frames) & set(ref_frames))
    if metric_frames is not None:
        first, last = metric_frames
        common = [frame for frame in common if first <= frame <= last]
        if not common:
            fail(
                f"{arm.label} and {reference.label} share no frames in "
                f"--metric-frames {first}-{last}"
            )
    elif not common:
        fail(f"{arm.label} and {reference.label} share no frames")
    mae: list[float] = []
    edge_error: list[float] = []
    flicker: list[float] = []
    previous: tuple[np.ndarray, np.ndarray] | None = None
    for frame in common:
        current = load_rgb(arm_frames[frame])
        ref = load_rgb(ref_frames[frame])
        if current.shape != ref.shape:
            fail(
                f"frame {frame} size differs: {arm.label} is {current.shape[1]}x{current.shape[0]}, "
                f"{reference.label} is {ref.shape[1]}x{ref.shape[0]}"
            )
        difference = np.abs(current - ref)
        mae.append(float(difference.mean()))
        edge_error.append(float(difference[edge_mask(ref)].mean()))
        if previous is not None:
            previous_arm, previous_ref = previous
            flicker.append(float(np.abs((current - previous_arm) - (ref - previous_ref)).mean()))
        previous = (current, ref)
    return {
        "reference": reference.label,
        "frameCount": len(common),
        "metricFrames": None if metric_frames is None else list(metric_frames),
        "mae": summary(mae),
        "edgeError": summary(edge_error),
        "flicker": summary(flicker),
    }


def compute_metrics(
    arms: list[Arm], metric_frames: tuple[int, int] | None = None
) -> dict[str, dict[str, Any]]:
    by_label = {arm.label: arm for arm in arms}
    return {
        arm.label: compare(arm, by_label[arm.reference], metric_frames)
        for arm in arms
        if arm.reference is not None
    }


def format_stat(stat: dict[str, float] | None, key: str) -> str:
    return "-" if stat is None else f"{stat[key]:.6f}"


def print_table(
    results: dict[str, dict[str, Any]], metric_frames: tuple[int, int] | None = None
) -> None:
    range_text = "all" if metric_frames is None else f"{metric_frames[0]}-{metric_frames[1]}"
    print(f"metric frames: {range_text}")
    print(
        f"{'arm':<16} {'ref':<16} {'frames':>6} "
        f"{'mae_mean':>10} {'mae_p95':>10} {'edge_mean':>10} {'edge_p95':>10} "
        f"{'flick_mean':>11} {'flick_p95':>11}"
    )
    for label, row in results.items():
        mae = row["mae"]
        edge = row["edgeError"]
        flicker = row["flicker"]
        print(
            f"{label:<16} {str(row['reference']):<16} {int(row['frameCount']):>6} "
            f"{format_stat(mae, 'mean'):>10} {format_stat(mae, 'p95'):>10} "
            f"{format_stat(edge, 'mean'):>10} {format_stat(edge, 'p95'):>10} "
            f"{format_stat(flicker, 'mean'):>11} {format_stat(flicker, 'p95'):>11}"
        )


def draw_centered(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
) -> None:
    left, top, right, bottom = box
    bounds = draw.textbbox((0, 0), text, font=font)
    width = bounds[2] - bounds[0]
    height = bounds[3] - bounds[1]
    x = left + (right - left - width) / 2 - bounds[0]
    y = top + (bottom - top - height) / 2 - bounds[1]
    draw.text((x, y), text, font=font, fill="white")


def scaled_frame(path: Path) -> Image.Image:
    with Image.open(path) as source:
        image = source.convert("RGB")
    height = max(1, round(image.height * CELL_W / image.width))
    return image.resize((CELL_W, height), Image.Resampling.LANCZOS)


def build_sheet(
    arms: list[Arm], frames: list[int], crop: tuple[int, int, int, int], out: Path
) -> None:
    font = ImageFont.load_default(size=TEXT_PX)
    paths = {arm.label: frame_paths(arm.directory) for arm in arms}
    bar_h = TEXT_PX + 2 * BAR_PAD
    middle = frames[len(frames) // 2]
    crop_w, crop_h = crop[2] * 3, crop[3] * 3

    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    left_w = max(
        int(probe.textlength(str(frame), font=font)) for frame in frames
    ) + 2 * BAR_PAD

    cells: dict[tuple[str, int], Image.Image | None] = {}
    for frame in frames:
        for arm in arms:
            path = paths[arm.label].get(frame)
            cells[(arm.label, frame)] = None if path is None else scaled_frame(path)
    cell_h = max((cell.height for cell in cells.values() if cell is not None), default=1)
    for key, cell in cells.items():
        if cell is not None and cell.height != cell_h:
            cells[key] = cell.resize((CELL_W, cell_h), Image.Resampling.LANCZOS)

    width = max(left_w + len(arms) * CELL_W, left_w + len(arms) * crop_w)
    height = bar_h + len(frames) * cell_h + bar_h + crop_h
    sheet = Image.new("RGB", (width, height), (0, 0, 0))
    draw = ImageDraw.Draw(sheet)

    for index, arm in enumerate(arms):
        x = left_w + index * CELL_W
        draw_centered(draw, (x, 0, x + CELL_W, bar_h), arm.label, font)

    middle_index = frames.index(middle)
    for row, frame in enumerate(frames):
        y = bar_h + row * cell_h
        draw_centered(draw, (0, y, left_w, y + cell_h), str(frame), font)
        for index, arm in enumerate(arms):
            x = left_w + index * CELL_W
            cell = cells[(arm.label, frame)]
            if cell is None:
                draw_centered(draw, (x, y, x + CELL_W, y + cell_h), f"no frame {frame}", font)
                continue
            sheet.paste(cell, (x, y))
            if row != middle_index:
                continue
            path = paths[arm.label][frame]
            with Image.open(path) as source:
                source_w, source_h = source.size
            scale_x, scale_y = CELL_W / source_w, cell_h / source_h
            box = (
                x + round(crop[0] * scale_x),
                y + round(crop[1] * scale_y),
                x + round((crop[0] + crop[2]) * scale_x),
                y + round((crop[1] + crop[3]) * scale_y),
            )
            draw.rectangle(box, outline="red", width=2)

    crop_y = bar_h + len(frames) * cell_h
    for index, arm in enumerate(arms):
        x = left_w + index * crop_w
        draw_centered(draw, (x, crop_y, x + crop_w, crop_y + bar_h), arm.label, font)
        path = paths[arm.label].get(middle)
        if path is None:
            draw_centered(
                draw,
                (x, crop_y + bar_h, x + crop_w, crop_y + bar_h + crop_h),
                f"no frame {middle}",
                font,
            )
        else:
            with Image.open(path) as source:
                image = source.convert("RGB")
            box = (crop[0], crop[1], crop[0] + crop[2], crop[1] + crop[3])
            patch = image.crop(box).resize((crop_w, crop_h), Image.Resampling.NEAREST)
            sheet.paste(patch, (x, crop_y + bar_h))

    sheet.save(out / "sheet.png")


def parse_frames(value: str) -> list[int]:
    try:
        frames = list(dict.fromkeys(int(part) for part in value.split(",") if part.strip()))
    except ValueError:
        fail(f"--frames is not a comma-separated integer list: {value!r}")
    if not frames:
        fail("--frames is empty")
    return frames


def parse_crop(value: str) -> tuple[int, int, int, int]:
    try:
        crop = tuple(int(part) for part in value.split(","))
    except ValueError:
        fail(f"--crop is not x,y,w,h: {value!r}")
    if len(crop) != 4:
        fail(f"--crop is not x,y,w,h: {value!r}")
    if crop[2] <= 0 or crop[3] <= 0:
        fail(f"--crop needs a positive width and height: {value!r}")
    x, y, width, height = crop
    return x, y, width, height


def parse_metric_frames(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"\s*(\d+)\s*-\s*(\d+)\s*", value)
    if match is None:
        fail(f"--metric-frames is not an inclusive A-B integer range: {value!r}")
    first, last = int(match.group(1)), int(match.group(2))
    if first > last:
        fail(f"--metric-frames starts after it ends: {value!r}")
    return first, last


def self_test() -> None:
    with tempfile.TemporaryDirectory() as work:
        ref_dir = Path(work) / "ref"
        arm_dir = Path(work) / "arm"
        ref_dir.mkdir()
        arm_dir.mkdir()
        for frame in range(6):
            image = Image.new("RGB", (96, 64), (0, 0, 0))
            left = 4 + frame * 6
            ImageDraw.Draw(image).rectangle((left, 20, left + 15, 35), fill=(255, 255, 255))
            image.save(ref_dir / f"pan.{frame:04d}.png")
            image.filter(ImageFilter.GaussianBlur(1)).save(arm_dir / f"pan.{frame:04d}.png")

        arms = [Arm("arm", arm_dir, "ref"), Arm("ref", ref_dir, None)]
        results = compute_metrics(arms)
        assert results["arm"]["edgeError"]["mean"] > 0, "a blurred edge must score above zero"

        control = [Arm("control", ref_dir, "ref"), Arm("ref", ref_dir, None)]
        same = compute_metrics(control)["control"]
        for metric in ("mae", "edgeError", "flicker"):
            assert same[metric]["mean"] == 0.0, f"{metric} of a dir against itself is not zero"
            assert same[metric]["p95"] == 0.0, f"{metric} p95 of a dir against itself is not zero"

        try:
            with contextlib.redirect_stderr(io.StringIO()):
                parse_arms(["bad=" + str(ref_dir) + "@missing"])
        except SystemExit as error:
            assert error.code == 2, f"unknown @ref exits {error.code}, not 2"
        else:
            raise AssertionError("an unknown @ref did not exit 2")

        for bad_range in ("100-200", "5-4"):
            try:
                with contextlib.redirect_stderr(io.StringIO()):
                    compare(arms[0], arms[1], parse_metric_frames(bad_range))
            except SystemExit as error:
                assert error.code == 2, f"--metric-frames {bad_range} exits {error.code}, not 2"
            else:
                raise AssertionError(f"--metric-frames {bad_range} did not exit 2")

    print("self-test ok")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, help="directory for sheet.png and metrics.json")
    parser.add_argument("--frames", help="comma-separated frame numbers for the sheet")
    parser.add_argument(
        "--metric-frames", help="inclusive A-B frame range for the metrics; default all"
    )
    parser.add_argument("--crop", help="x,y,w,h in full-frame pixels for the 3x crop row")
    parser.add_argument("--self-test", action="store_true", help="run the synthetic checks and exit")
    parser.add_argument("arms", nargs="*", help="<label>=<dir>[@<ref-label>]")
    args = parser.parse_args(argv)

    if args.self_test:
        self_test()
        return 0
    if args.out is None:
        fail("--out is required")
    if args.frames is None:
        fail("--frames is required")
    if args.crop is None:
        fail("--crop is required")
    if not args.arms:
        fail("at least one ARM is required")

    arms = parse_arms(args.arms)
    frames = parse_frames(args.frames)
    metric_frames = None if args.metric_frames is None else parse_metric_frames(args.metric_frames)
    crop = parse_crop(args.crop)
    args.out.mkdir(parents=True, exist_ok=True)

    results = compute_metrics(arms, metric_frames)
    (args.out / "metrics.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print_table(results, metric_frames)
    build_sheet(arms, frames, crop, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
