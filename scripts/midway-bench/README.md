# Midway bench harness

Runs the real-game benchmark scenario for the C++ Wasm engine: Midway Open Pacific, scripted flight,
with the engine arm graded against the three.js arm before any timing counts.

| File | Job |
| --- | --- |
| `install.sh` | Packs this checkout's engine packages and installs them into a Midway game copy. |
| `flight.sh` | Runs the scripted flight headed on WebGPU, then (native arm) grades the frames. |
| `flight-bench.playtest.json` | The scenario: take the deck, climb, cockpit view, three screenshots. |
| `flight-bench-desktop.playtest.json` | The same flight on the desktop engine player (`flight.sh desktop <tag>` with `MIDWAY_PLAYER_DIR`, graded against the same legacy web runs). |
| `real-input.mjs` | Real X11 keys and mouse (xdotool) on the packaged desktop engine player, proven from game state: HUD click, W, ArrowDown, ArrowUp, C, a right-button drag, Escape. Own Xvfb and kwin, never the user's display. `node scripts/midway-bench/real-input.mjs <packaged dir>`; red (11 fails) on a player built before the input fix. |
| `parity.ts` | The fail-closed frame check. Exit 1 when a native frame is not the legacy frame. |

## Setup

Two copies of the same game commit outside every repo: one with `engine: "legacy"` and one with
`engine: "native"`. Never edit the game's gameplay source. Build the packages, then install:

```sh
MIDWAY_PACKS=... sh scripts/midway-bench/install.sh "$MIDWAY_NATIVE_DIR"
```

`pnpm pack` ships each package's existing `dist`, so rebuild `packages/create-threenative`
(`pnpm exec tsup --config tsup.config.ts`) after a `three-native` change, and the Wasm host
(`cmake --build packages/runtime-native/build/wasm --target tn-native-engine-web`) after a C++ change.

## Run

Take two legacy runs first. They are the reference, and they must agree with each other.

```sh
export MIDWAY_LEGACY_DIR=... MIDWAY_NATIVE_DIR=...
sh scripts/midway-bench/flight.sh legacy a
sh scripts/midway-bench/flight.sh legacy b
MIDWAY_PARITY_REFS="$MIDWAY_RUNS/a-legacy $MIDWAY_RUNS/b-legacy" sh scripts/midway-bench/flight.sh native c1
```

`flight.sh` exits 3 when the parity check fails: do not time that build. Optional env:
`TN_HEAVY_LOCK` (a flock file shared with other GPU lanes), `TN_VK_ICD` and `TN_VK_LIB` (a per-process
Vulkan driver), `MIDWAY_RUNS`, `MIDWAY_SCENARIO`. Run only while host load is low: a loaded host
stalls the page past the playtest's operation timeout, and `flight.sh` already raises it to 180 s.

## What the check grades

SSIM on luma over an 8x6 tile grid, for `takeoff`, `cockpit` and `after`. The verdict is the worst
tile (a localized defect such as a dead instrument panel moves one tile) and the whole-frame mean.
Floors: worst tile at least 0.70 and mean at least 0.93, calibrated between a broken native run
(worst tile 0.257) and a fixed one (0.85 to 0.97). Legacy runs agree with each other at 0.95 to 0.999,
and must stay above the worst-tile floor, or the reference is unstable and the check fails. A missing
frame or a size mismatch fails. `scripts/__tests__/midway-parity.spec.ts` pins the floors on 320x180
frames of the broken and fixed native runs.

Desktop engine player (2026-10-13, 1280x720, NVIDIA): takeoff worst tile 0.784, cockpit and after 0.796, mean
0.947 to 0.967, against legacy web spread 0.965 to 1. The floors hold unchanged. The worst tiles sit on the left HUD
panel, where WebKitGTK draws the text and the mission range reads a different value, not on the 3D scene.

## Timing

Only after the parity check passes:

```sh
pnpm profile:wasm-page -- --url <native url> --control <legacy url> --cpu-work --click '#start-deck'
```

Three native and three legacy runs, alternating, under the heavy lock. It reports startup, frame
p50, p95 and p99, hitches, CPU work per frame and (`--memory`) memory per arm.

Desktop flights use the canonical dashboard reducer for both A/B arms, rather than historical
scratch `frames.py` scripts:

```sh
pnpm exec tsx -e 'import { readFileSync } from "node:fs"; import { playerFrames } from "./scripts/midway-bench/dashboard.ts"; console.log(playerFrames(readFileSync(process.argv[1], "utf8")));' "$MIDWAY_RUNS/<tag>-desktop/run.log"
```

CPU and instructions share the last 1,000 complete active player frames (`updates > 0`, with finite,
positive CPU time, instructions and frame time). Zero-update capture/teardown frames and incomplete
measurements are excluded before taking the tail. The reducer exposes used, eligible and excluded
counts; winner qualification requires all 1,000 used frames in every pinned baseline and candidate run.
HUD p95 still uses all snapshots, and matrix visits still use the last projection observation;
these windows are not aligned to the CPU/instruction tail. Raw run logs stay unchanged.

## Dashboard

`pnpm perf:live` also serves the Midway tab at `http://127.0.0.1:8765/midway`: PRD-610 KPI cards, desktop against
web Wasm against three.js, a trend per run and A/B groups by tag prefix. It reads `MIDWAY_RUNS` (default
`~/.cache/tmp-tn/midway-runs`) and never writes. Malformed log lines are skipped and counted; a run with no samples
shows "no samples", not zero.
