# Midway bench harness

Runs the real-game benchmark scenario for the C++ Wasm engine: Midway Open Pacific, scripted flight,
with the engine arm graded against the three.js arm before any timing counts.

| File | Job |
| --- | --- |
| `install.sh` | Packs this checkout's engine packages and installs them into a Midway game copy. |
| `flight.sh` | Runs the scripted flight headed on WebGPU, then (native arm) grades the frames. |
| `flight-bench.playtest.json` | The scenario: take the deck, climb, cockpit view, three screenshots. |
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

## Timing

Only after the parity check passes:

```sh
pnpm profile:wasm-page -- --url <native url> --control <legacy url> --cpu-work --click '#start-deck'
```

Three native and three legacy runs, alternating, under the heavy lock. It reports startup, frame
p50, p95 and p99, hitches, CPU work per frame and (`--memory`) memory per arm.
