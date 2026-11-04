#!/usr/bin/env python3
"""Reads Unreal 5.8.3 `ProfileGPU` tables from an editor log (PRD-539 side-by-side benchmark).

    python3 -I scripts/unreal-look/profile-gpu.py <ThreeNativeReference.log> [--tree] [--min-ms 0.05]
    python3 -I scripts/unreal-look/profile-gpu.py --csv <Saved/Profiling/CSV/Profile(...).csv>...

Prints one JSON line per profiled frame: the root, the scene render (`SceneRender - ViewFamilies`) and
the temporal-upscale passes (any row whose name holds `TSR` or `TemporalSuperResolution`), each the
inclusive GPU time in ms. `--tree` also prints every row at or above `--min-ms`. A log with no
profile table exits 2: a missing observation is a failure, not zero.
"""
import json
import re
import sys

TIME = re.compile(r"([0-9.]+) ms")


def blocks(lines):
    current = None
    for line in lines:
        if "GPU Profile for Frame" in line:
            current = {"title": line.split("Display:")[-1].strip(), "rows": []}
            yield current
        elif current is not None and line.count("┃") >= 4:
            cells = line.split("┃")
            inclusive = TIME.search(cells[2])
            label = cells[3].rstrip()
            if inclusive is None or not label.strip():
                continue
            depth = (len(label) - len(label.lstrip())) // 3
            current["rows"].append((float(inclusive.group(1)), depth, label.strip()))


def summarize(block):
    rows = block["rows"]
    root = next((ms for ms, _, name in rows if name == "<root>"), None)
    scene = sum(ms for ms, _, name in rows if name == "SceneRender - ViewFamilies")
    tsr = [(name, ms) for ms, _, name in rows if "TSR" in name or "TemporalSuperResolution" in name]
    # Inclusive times nest, so the TSR total is the outermost TSR row of each subtree.
    outer = []
    for ms, depth, name in rows:
        if "TSR" in name or "TemporalSuperResolution" in name:
            if not outer or depth <= outer[0][1]:
                outer = [r for r in outer if r[1] < depth] + [(ms, depth, name)]
    return {
        "frame": block["title"],
        "rootMs": root,
        "sceneRenderMs": round(scene, 3),
        "tsrMs": round(sum(ms for ms, d, _ in outer if d == min(r[1] for r in outer)), 3) if outer else None,
        "tsrPasses": tsr,
    }


def main(argv):
    if len(argv) < 1 or argv[0].startswith("-"):
        print(__doc__, file=sys.stderr)
        return 2
    tree = "--tree" in argv
    min_ms = float(argv[argv.index("--min-ms") + 1]) if "--min-ms" in argv else 0.05
    with open(argv[0], encoding="utf-8", errors="replace") as handle:
        found = list(blocks(handle.read().splitlines()))
    if not found:
        print(f"no ProfileGPU table in {argv[0]}", file=sys.stderr)
        return 2
    for block in found:
        print(json.dumps(summarize(block)))
        if tree:
            for ms, depth, name in block["rows"]:
                if ms >= min_ms:
                    print(f"{ms:8.3f} {'  ' * depth}{name[:80]}")
    return 0




def csv_summary(path, stats=("GPUTime", "GPU/TemporalSuperResolution", "GPU/PostProcessing", "GPU/SlateUI")):
    """Unreal CSV profiler (`TN_UE_CSV_GPU=1`): the header row is at the end, rows grow as stats appear.
    Keeps the frames that drew the scene (GPU time over 1 ms; idle editor ticks read about 0.3 ms)."""
    import csv
    import statistics

    with open(path, newline="") as handle:
        rows = list(csv.reader(handle))
    header = rows[-2] if rows[-1][:1] == ["[HasHeaderRowAtEnd]"] else rows[0]
    data = rows[1:-2]
    def column(name):
        if name not in header:
            return None
        index = header.index(name)
        return [float(row[index]) if index < len(row) and row[index] else 0.0 for row in data]
    gpu = column("GPUTime")
    if gpu is None:
        raise SystemExit(f"{path}: no GPUTime column; was r.GPUCsvStatsEnabled on?")
    keep = [i for i, value in enumerate(gpu) if value > 1.0]
    if not keep:
        raise SystemExit(f"{path}: no frame drew the scene")
    out = {"csv": path, "frames": len(keep)}
    for name in stats:
        values = column(name)
        if values is None:
            out[name] = None
            continue
        picked = sorted(values[i] for i in keep)
        out[name] = {
            "p50": round(statistics.median(picked), 3),
            "p95": round(picked[max(0, int(0.95 * len(picked)) - 1)], 3),
            "mean": round(statistics.fmean(picked), 3),
        }
    return out


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--csv":
        for item in sys.argv[2:]:
            print(json.dumps(csv_summary(item)))
        sys.exit(0)
    sys.exit(main(sys.argv[1:]))
