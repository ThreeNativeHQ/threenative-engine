# Performance learnings

This file is the central record of performance levers tried in this repository, and of the method lessons they
taught. Read it before you choose a lever. Append one entry for each closed lever (keep, reject or inconclusive)
before you start the next one. Do not delete entries: a later result that contradicts an entry is a new entry that
names the old one. The `performance-optimization-loop` skill follows this file. Older per-PRD records are in each
PRD's "Tried and rejected" or "Decisions" section, for example
[PRD-610](docs/PRDs/performance/PRD-610-native-engine-wins-on-real-games.md).

## Method lessons

- **Size a lever before you code it.** Measure its ceiling with a counter or a phase timer inside the measured pose
  windows (`TN_PLAYER_CROSSINGS=1`, `TN_RENDER_PREPARE_SPLIT=1`, a temporary env counter). Then project calls per
  frame times cost per call. On 2026-10-14, two levers chosen from profile shares were flat in A/B.
- **A profile window must exclude loading.** A 100 s call-graph capture of the Midway player included load-time
  garbage collections, so it gave the V8 GC prologue 4.9% of samples. Inside the pose windows there was one GC per
  34 frames.
- **Instructions per frame are the low-noise metric on a loaded host.** Milliseconds and cycles moved by 13 to 17%
  when only the host load changed (load 18 to 11) on 2026-10-14. Alternate off and on runs, and judge with at least
  two pairs.
- **Retired instructions undercount memory-bound work.** Record cycles or thread CPU time beside them. When the two
  disagree, the change moved memory traffic, not computation.
- **Serialize timed runs with one lock.** An "idle for 40 s" `pgrep` check starved queued runs for 50 minutes,
  because `pgrep -f` matches shells whose command text only contains the script name.
- **Ratio levers live in the engine.** A fix in code that both arms run (for example `@threenative/core`) lowers the
  absolute cost but does not move the native or web Wasm ratio against three.js.

## Levers

### 2026-10-14 — V8 GC prologue `promote()` skips the full wrapper walk while the ownership epoch is unmoved — REJECT
- Where: PRD-610, branch `perf/prd610-promote` (reverted).
- Ceiling: profile share 4.9% of samples. It was wrong (see method lessons).
- Result: second off/on pair flat (takeoff 8.58 / 8.70 ms, cockpit 10.44 / 10.44 ms, rear gunner 11.55 / 10.73 ms);
  instructions unchanged. Counter run: 249 GC prologues in 8,400 frames, 26,447 wrappers.
- Cause: GCs are rare in the pose windows, so the walk costs about 0.04 ms per frame.
- Artifact: patch kept outside the repository by the session; the change is a 20-line edit in
  `packages/runtime-native/src/adapters/v8/adapter.cpp`.

### 2026-10-14 — Crossing path reuses decoded numeric and handle arguments — REJECT
- Where: PRD-610, branch `perf/prd610-crossing` (not committed).
- Ceiling: 613 calls per frame × 60 to 120 ns = 0.04 to 0.07 ms per frame.
- Result: A/B flat on two pairs; adapter ctests 75 of 75 passed on and off.
- Cause: the per-call decode is a small part of a crossing. Remove whole classes of crossings instead.
- Measured on the way: 1,725 crossings per frame on Midway; top names per frame `visible` 315, `count` 152,
  `getY` 120, `getX` 120, `time` 109, `setEffectiveWeight` 104, `material` 98, `getZ` 87, `opacity` 83,
  `getWorldPosition` 58; 34,331 live wrappers.

### 2026-10-14 — `publishUiState` serializes a changed HUD frame once instead of three times — KEEP
- Where: `@threenative/core` (`ui-state.ts`, `ui-bridge.ts`), branch `perf/prd610-promote`, commit b642e5dfb.
- Ceiling: `JSON.stringify` was about 7% of the native main thread in the call-graph profile (the same profile
  that overstated GC, so treat this share as an upper bound).
- Result: red-green spy test 3 calls to 1; 101 UI core specs pass; public surface unchanged. Not timed on Midway.
- Cause: the publisher stringified the store to diff it, again for `lastFrame`, and the bridge stringified the
  message a third time.

### 2026-10-14 — PRD-613 Stage 0: render phase split — KEEP (diagnostic)
- Where: [PRD-613](docs/PRDs/native-engine/PRD-613-native-render-thread.md), commit 4abe3d020.
- Result (loaded host, shares only): the ocean reflection pass is about half the render wall at cockpit and rear
  gunner (0.85 / 2.67 / 4.32 ms); its encode costs about 2 ms for 8 items at cockpit, a per-pass fixed cost.
- Cause: one reflection pass per frame re-runs prepare and encode for its own camera.

### 2026-10-14 — Web Wasm owner profile — KEEP (diagnostic)
- Where: [PRD-612](docs/PRDs/native-engine/PRD-612-web-wasm-engine-beats-threejs-on-midway.md).
- Result: on the browser main thread, Wasm engine code 44 to 48%, engine JS glue 23 to 26%, game JS 12 to 15%,
  V8 `(program)` 8%, WebGPU natives 7 to 8%. Animation, the matrix walk and `RenderDatabase::project` are the same
  top owners as on native.
