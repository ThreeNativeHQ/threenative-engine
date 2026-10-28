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

Two copies of the same game commit outside every repo: one with `engine: "threejs"` and one with
`engine: "threenative"`. Never edit the game's gameplay source. Configure the builds as described below,
then rebuild and install:

```sh
export MIDWAY_PACKS="$HOME/.cache/tmp-tn/midway-packs"
sh scripts/midway-bench/install.sh "$MIDWAY_LEGACY_DIR"
sh scripts/midway-bench/install.sh "$MIDWAY_NATIVE_DIR" --no-pack
```

`install.sh` now rebuilds before packing: `pnpm build`, `node packages/runtime-native/scripts/build-native-ui-overlay.mjs`,
then normal incremental CMake dependency builds of `tn-native-engine-web` and `tn-native-engine-player-v8`,
rebuilding changed inputs while retaining compiled artifacts. “Clean” in the build protocol refers to
source checkout cleanliness, not forced recompilation. It refuses dirty engine/package/tooling
sources, an unrelated Git root, or CMake caches configured from another checkout. It checks the
source revision again after building and packing. Preserve unrelated edits (including compute
tests); prepare from a clean, committed revision instead of resetting them.

The two CMake build directories must already be configured with their dependencies installed.
From the clean engine checkout, configure them if needed, then run the installation commands above:

```sh
cmake --preset wasm -S packages/runtime-native
cmake --preset tn-linux -S packages/runtime-native -B packages/runtime-native/build/tn-engine-ui \
  -DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON -DTN_ENGINE_PLAYER_UI_OVERLAY=ON
```

`$MIDWAY_PACKS/midway-provenance.json` is written only after successful builds and packing. Its
`engineCommit` covers the clean engine source revision used by those commands; `buildProtocol`
names this rebuild protocol, and `playerSha256` binds the freshly built player. Tarball hashes
bind the packed bytes. Installation verifies them and records the same commit/protocol with
installed engine/three package hashes, `package.json` and the game lockfile. It packs the checkout's
patched upstream `three`, preserving the game's other dependency declarations. `--no-pack` requires
this build receipt; historical HEAD-only receipts must be rebuilt, not relabeled. Receipts assume
the configured dependency/toolchain inputs are trusted; they do not attest their compiler revision.

Repackage desktop through the existing entrypoint with the build receipt. It requires the
bundler's clean source commit to match the receipt and the player bytes to match its build hash.
For the existing local Midway copies, run from the owning engine checkout and freshly build the
UI before packaging. The installed runtime-native package does not yet ship the bundler, so the
installed game's generic `build:desktop` fails with `TN_ENGINE_BUNDLER_MISSING`. This UI helper is
checkout source only, not a public installed export; do not reuse stale UI output.

```sh
export MIDWAY_LEGACY_DIR="$HOME/.cache/tmp-tn/midway-legacy"
export MIDWAY_NATIVE_DIR="$HOME/.cache/tmp-tn/midway-native"
export MIDWAY_PLAYER_DIR="$HOME/.cache/tmp-tn/midway-player-ac14"
node --import tsx --input-type=module --eval 'import { buildUi } from "./packages/create-threenative/src/build.ts"; import { loadConfig } from "./packages/create-threenative/src/config.ts"; const cwd = process.env.MIDWAY_NATIVE_DIR; console.log(await buildUi(cwd, await loadConfig(cwd, { target: "desktop" })));'
node packages/runtime-native/scripts/package-engine-desktop.mjs \
  --project "$MIDWAY_NATIVE_DIR" --entry "$MIDWAY_NATIVE_DIR/src/game.ts" \
  --player packages/runtime-native/build/tn-engine-ui/tn-native-engine-player-v8 \
  --build-receipt "$MIDWAY_PACKS/midway-provenance.json" \
  --ui "$MIDWAY_NATIVE_DIR/.threenative/build/ui" --output "$MIDWAY_PLAYER_DIR"
```

Both browser copies and the desktop package must carry matching commit receipts before any arm
launches. The desktop commit covers the bundler source plus the rebuilt player validated against
the preparation receipt. Artifact hashes cover the packaged player, game bundle, assets and UI;
they do not attest the game's source revision. Packaging without `--build-receipt` still works,
including without Git or inside an unrelated consumer repository, but emits no benchmark receipt.
Old desktop packages cannot acquire provenance at flight time: rebuild and repackage them.

## Run

Take two legacy runs first. They are the reference, and they must agree with each other.

```sh
export MIDWAY_LEGACY_DIR=... MIDWAY_NATIVE_DIR=... MIDWAY_PLAYER_DIR=...
sh scripts/midway-bench/flight.sh legacy a
sh scripts/midway-bench/flight.sh legacy b
MIDWAY_PARITY_REFS="$MIDWAY_RUNS/a-legacy $MIDWAY_RUNS/b-legacy" sh scripts/midway-bench/flight.sh native c1
```

Every browser flight runs `pnpm run build:web`, validates `dist` against
`dist.build-report.json`, then serves it with `pnpm exec vite preview` on the runner's port.
`run.log` names the arm, production build mode, recorded engine commit and artifact SHA-256.
Changed package/build bytes, missing or malformed receipts and mismatched commits fail closed.
The runner records each distinct actual browser request URL once in the terminal report's
`acquisition.requestUrls`, without trace snapshots or screenshots. Missing/malformed acquisition
evidence or any request for `/@vite/client` rejects the run. The browser clock choice still forwards
unchanged (`wall-clock` by default, `fixed-step` for visual references).

`flight.sh` exits 3 when the parity check fails: do not time that build. Optional env:
`TN_HEAVY_LOCK` (a flock file shared with other GPU lanes), `TN_VK_ICD` and `TN_VK_LIB` (a per-process
Vulkan driver), `MIDWAY_RUNS`, `MIDWAY_SCENARIO`. Run only while host load is low: a loaded host
stalls the page past the playtest's operation timeout, and `flight.sh` already raises it to 180 s.

## Matched CPU collection (AC-15)

Set `MIDWAY_MATCHED_CPU=1` on each legacy, native or desktop flight. This selects fixed-step
acquisition; an explicit `MIDWAY_BROWSER_CLOCK=wall-clock` conflicts and exits 2. Flags other
than `0` and `1` are rejected. Ordinary flights keep their existing trajectory and clock.

The harness writes `matched-cpu.playtest.json` inside each run directory, preserving the source
scenario and its screenshots/assertions. The three existing WAIT labels `released-stick-climb`,
`canopy-and-instruments` and `gun-view` each become 1,000 ticks. Missing or duplicate screenshot
waits fail before launch. Only the runner receives `TN_PLAYTEST_CPU_WINDOW_LABELS` with those labels;
game builds receive no collection flag. Matching visual references must use this derived trajectory.

```sh
MIDWAY_MATCHED_CPU=1 sh scripts/midway-bench/flight.sh legacy matched-a1
MIDWAY_MATCHED_CPU=1 MIDWAY_PARITY_REFS="<matched legacy ref 1> <matched legacy ref 2>" \
  sh scripts/midway-bench/flight.sh desktop matched-b1
```

Every arm must report all three fixed-step `acquisition.cpuWindows`, each with exactly 1,000
frames, updates and renders, positive main-thread CPU/instructions/cycles and process-tree CPU,
and valid PID/TID identities. Missing counters reject the flight, without a wall-time fallback.
Collection depends on the runner's Linux OS sampler and permitted perf counters; old installations
without this acquisition contract fail closed and must be refreshed by the owning integration lane.

The headline shows the paired legacy/native main-thread CPU ratio, instructions per frame and
process-tree CPU per frame separately for takeoff, cockpit and rear gun. Engine commits must match;
native parity PASS and at least three alternating legacy/candidate pairs per pose are required for
the collection gate. A single pair remains provisional. The root execution gate must still review
isolation, workload and environment before a speed verdict. Historical wall/budget and player CPU
rows are diagnostics and cannot qualify the headline. Real attribution acquisition remains pending until the profile flights below succeed.

Sampler frame/update/render counts establish the observed game work; they do not independently
attest native host completion. Unlabelled historical player frame tails cannot be assigned to poses.
When `TN_PLAYER_FRAME` completion records are present, the reducer requires exactly 1,000 distinct
completed ticks with one update each between the preceding step and each labelled window end in
`observations.signalSeries`. Missing/ambiguous boundaries, incomplete renders and mismatched counts
reject acquisition; it never estimates the boundary from the last frame tail. Without host records,
independent native host reconciliation remains unavailable.

## Separate V8 profile flights

`MIDWAY_CPU_PROFILE=1 sh scripts/midway-bench/flight.sh <legacy|native|desktop> <tag>` forces the
same three fixed-step 1,000-frame CPU windows and passes the shipped `--cpu-prof` option. Run it
separately from unprofiled timing pairs: profiler overhead cannot qualify a speed headline. Output
lives under `MIDWAY_RUNS/profiles/<tag>-<arm>/`, outside the dashboard's top-level run inputs.
Parity references must still match this trajectory; native arms require two legacy references.

Browser production builds explicitly request Vite `--sourcemap`. Attribution requires a local map
for each sampled, requested production JavaScript file; missing maps fail. Desktop uses the shipped
external `game.js.map`, which must appear with a matching SHA-256 in packaged build provenance.
`profile-owners.json` retains profile/script/map hashes and per-pose engine/game/HUD/harness,
unknown, idle and GC sampled wall durations. These are sampled wall intervals, not OS CPU totals.
Three.js and framework UI/assets/terrain belong to engine; game HUD sources and React belong to HUD.
Desktop attribution covers the V8 game isolate; a separate WebView's HUD JavaScript is not sampled.

Both runtimes must provide Linux `clockBounds` around profiler start/stop. The mapper intersects
those measured monotonic/V8 offset brackets and requires every pose and its uncertainty margin to
be fully sampled. Missing clocks, inconsistent calibration, missing pose windows or stale native
maps reject attribution. No real profile, browser or native runtime proof is implied by fixture tests.

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

The runs table also shows whole-frame world-work visits (version 2): median, maximum and sample count
over that same active tail. Every used frame must carry version 2 and six nonnegative safe-integer
parts (`worldUpdateVisits`, `joinDependencyVisits`, `gpuBoundaryVisits`, `gpuProjectionBoundaryVisits`,
`gpuPlanValidationVisits`, `gpuPlanMaintenanceVisits`) whose sum equals the safe-integer
`worldWorkVisitsTotal`. Mixed, unknown or malformed counters hide this summary and reject winner
qualification while retaining CPU/instruction measurements. Historical logs without these fields stay
usable with no world-work summary. Whole-frame work and legacy projection-only `Matrix last` have
different scopes; their history is not directly comparable. Structural targets and pinned references
continue using the original metric; CPU headlines require the matched OS windows above.

## Dashboard

`pnpm dashboard` also serves the Midway tab at `http://127.0.0.1:8765/midway`: PRD-610 KPI cards, desktop against
web Wasm against three.js, a trend per run and A/B groups by tag prefix. It reads `MIDWAY_RUNS` (default
`~/.cache/tmp-tn/midway-runs`) and never writes. Malformed log lines are skipped and counted; a run with no samples
shows "no samples", not zero.
