# PRD-566 — Terrain LOD morphs on the GPU and picks its level by screen error

**Status:** PARTIAL — Phase 1 measurement in progress; The CPU-cost branch of the measurement gate is accepted; valid hardware walk proof remains open.
**Priority:** P2 — Phase 1 walk-tail proof is pending; GPU morph and screen-error selection are unbuilt.
**Complexity:** 3 (LOW) — 1–5 implementation files (`world-tiles.ts`, the terrain probe) (+1), per-tile transition state already exists (+0), native proof reuses the installed morph path (+0); the score stays 3 because the morph replaces a CPU loop with stock three morph targets; risk override: none
**Owner:** João
**Depends on:** None. Respects [PRD-473](../open-world/PRD-473-open-worlds-hold-120-fps-gpu-driven.md) (merged blocks, rejected height texture), [PRD-460](../open-world/PRD-460-invisible-streaming-transitions.md) (terrain is its non-goal) and [PRD-461](../done/open-world/PRD-461-view-distance-basics.md) (switches stay in the haze).

## Context

`TerrainTiles` changes a tile's level with a three-frame blend (`LOD_TRANSITION_FRAMES = 3`, `packages/core/src/world-tiles.ts:219`). Each blend frame runs `updateLodTransitionGeometry` (`world-tiles.ts:1292`). It visits every vertex of the finer level. For each vertex it calls `tile.field.heightAt` and `tile.field.normalAt`, interpolates the coarser level, and writes `position.setY` and `normal.setXYZ`. `normalAt` reads five heights, so a 65×65 tile makes about 25,000 field reads per blend frame. The same file records that this access pattern cost 46 ms when level building used it (`fieldHeightGrid`, `world-tiles.ts:489`). No measurement exists for the blend frames. `blendingTiles` (`world-tiles.ts:2064`) counts the tiles that pay the cost.

The level itself comes from fixed distances in metres. `lodDistances` defaults to two and four tile widths (`world-tiles.ts:1934`), `lodLevelForDistance` picks the level (`world-tiles.ts:2182`), and three's `LOD` switches on the same numbers (`world-tiles.ts:2391`). The same metres give a different screen error on a 1440p desktop and on a phone. Props already pick levels by projected pixel error with hysteresis (`selectLodLevel`, `packages/core/src/model-lod.ts:166`; default budget `DISCRETE_LOD_DEFAULT_ERROR_PIXELS = 1`, `model-lod.ts:211`). Terrain already measures each level's surface error for its pop bound (`coarsestSelectableLevel`, `world-tiles.ts:1421`).

**What Unreal does.** Clean-room summary, no code copied:

- UE 5.8.3: `Engine/Shaders/Private/LandscapeVertexFactory.ush:655-685`. The vertex shader computes a fractional LOD. The fraction is the morph alpha. Each vertex lerps its position and height toward the same point snapped to the next-coarser grid, and lerps its normal the same way. The CPU writes no vertex.
- UE 5.8.3: `Engine/Source/Runtime/Landscape/Private/LandscapeRender.cpp:575-590` (`ComputeLODFromScreenSize`). The section's squared screen size gives the LOD. Between the LOD0 and LOD1 screen sizes the LOD is a linear fraction. Beyond LOD1 it is a logarithm with a distribution scalar. `LandscapeRender.cpp:4482-4504` scales the screen size by the view's LOD distance factor before the pick.

**Constraints already decided here:**

- PRD-473 rejected an instanced flat grid that samples a per-tile height texture, because the engine would then own the game's `surface` (rule 3). Stock three morph targets avoid this: three applies them to any material, so the game's surface material stays untouched.
- PRD-473 also requires a tile to stay outside its merged block while it morphs. This PRD keeps that rule.
- PRD-460 lists terrain as a non-goal ("it morphs already"), so this work does not belong in PRD-460.
- PRD-461's recipe test asserts that every LOD switch lies at or beyond fog near (`packages/core/__tests__/world-streaming-recipe.spec.ts:68`). A screen-error pick must not move a switch nearer than that.

## Solution

1. **Measure first.** Add a blend-frame case to `packages/core/__tests__/world-tiles-cost.spec.ts`. It counts `heightAt` and `normalAt` calls per blending tile, as the file's operation-count cases do, and times one blend frame under `TN_BENCH=1`. The terrain probe reports the largest `blendingTiles` count in a frame. **Gate:** continue only if one blending 65×65 tile costs at least 0.5 ms per blend frame in the bench case, or the terrain playtest shows blend frames in its worst 1% of frame times. Otherwise record the decline under `## Decisions` and delete Phases 2–3 (R4).
2. **Morph with stock three morph targets.** When a level is built, the finer level of each adjacent pair gets one relative morph target. Its position delta is the coarser surface height minus the fine height at each fine vertex (the same `interpolatedLevelHeight` values the CPU blend computes now), and it carries the matching normal delta. These come from the shared `fieldHeightGrid`, once per level. A blend frame then sets only `mesh.morphTargetInfluences[0]`. The transition lifecycle, the three-frame default and the merge-block exclusion stay unchanged. With validation on, the CPU still computes the blended heights for `maxLodPop`, because the pop scan reads CPU attributes.
3. **Pick by screen error, with `lodDistances` as the floor.** Each tile keeps its levels' absolute surface errors, which `coarsestSelectableLevel` already computes. Selection calls the shared `selectLodLevel` with the props' resolved `maxPixelError` policy, so one knob governs both and no new constant appears. `lodDistances`, when given or defaulted, is the nearest distance at which a switch may happen. Screen error can only hold a finer level farther out, never coarsen nearer. This keeps PRD-461's haze rule true by construction. The phone-side saving (coarsening earlier) is deliberately not claimed.

**Risks:**

- **Memory.** Each finer level carries one more position attribute and one more normal attribute (about 100 KB for a 65×65 level). This is counted against `residentByteBudget`.
- **Shader variants.** A morph target adds a pipeline variant per surface material. The pipeline census must show one variant, not one per tile.
- **Native.** Morph targets are proven by conformance row `53-morph-target-animation`. A terrain claim needs its own desktop run.

## Acceptance Criteria

- [ ] AC-1 [local]: A morph frame writes no `position` and no `normal` attribute on the CPU, and the tile's rendered surface at morph progress p equals the CPU blend at p within 1 mm. proof: red-green `pnpm exec vitest run packages/core/__tests__/world-terrain-tiles.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: The abyss-framework terrain walk keeps `lodTransitions > 0`, `maxLodPop ≤ 16` and `maxLodTransitionFrames` unchanged, with 0 console errors on a named WebGPU adapter. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/terrain.playtest.json --url 'http://127.0.0.1:5183/?terrain' --server-command 'pnpm --filter abyss-framework dev --host 127.0.0.1 --port 5183 --strictPort' --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-3 [local]: Under PRD-461's recipe, every screen-error switch distance at 1280×720 and at 2560×1440 is at least fog near (180 m) and at least the `lodDistances` floor. proof: `pnpm exec vitest run packages/core/__tests__/world-streaming-recipe.spec.ts` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| GPU terrain morph | A game streams terrain through `TerrainTiles.follow` / `WorldCells`; a level change starts a transition | `updateLodTransitionGeometry`'s per-vertex CPU writes are deleted; the CPU blend survives only behind `validate` | AC-1, AC-2 |
| Screen-error terrain LOD | The same `follow` call that picks the level | `lodLevelForDistance` stays only as the floor | AC-3 |

## Execution Phases

#### Phase 1: Measure the blend frame
**Status:** PARTIAL
**Files:** `packages/core/__tests__/world-tiles-cost.spec.ts`, `examples/abyss-framework/src/scenes/TerrainProbe.ts`
**Implementation:** an operation-count case for one blend frame, a `TN_BENCH` timing case, and a probe field for the most blending tiles in one frame. The gate verdict goes under `## Decisions`.
- [x] The blend frame's field reads per tile are counted, and its time per 65×65 tile is recorded here. proof: `TN_BENCH=1 pnpm exec vitest run packages/core/__tests__/world-tiles-cost.spec.ts` — 2026-10-10: exit 0, 20/20 tests pass; 4,225 `normalAt` and 25,350 `heightAt` calls per tile. The final separate `-t 'times one blending'` run (exit 0, 1 passed/19 filtered) measured 2.416 ms mean, 1.692 ms median, 10.069 ms p99 across 100 frames after 20 warm-ups; earlier isolated mean 1.239 ms. No spies in the timed loop; one resident 65×65 tile, validation/merging off, no admissions or transition completion during the timed `process()` call. This includes the one-tile process bookkeeping; transition-start `follow()` and completion/restoration are outside the timer. Final full bench also measured 1.575 ms per 289-tile walking `follow()+process()` and 0.310 ms settled. A bounded repeat during PRD-564’s allowed CPU window measured 1.266 ms mean, 1.171 ms median, 2.613 ms p99 (same 100 samples/20 warm-ups; 1 passed/19 filtered; desktop load 16.67/20.41/24.00). This was lower contention, not an unloaded measurement. Logs: `/tmp/prd566-bench-final.log`, `/tmp/prd566-bench-final-isolated.log`, `/tmp/prd566-quiescent-bench.log`.
- [ ] The terrain walk reports the largest per-frame `blendingTiles` and whether blend frames sit in the worst 1%. proof: the AC-2 playtest command — Partial: the same scenario against a separately started, warmed server completed 180 ticks (exit 1, 20/26 assertions pass); the added peak assertion passed with 0→4 blending tiles. The probe retained 552 per-world-draw blend counts, including completion frames; transitions 0→33, max LOD pop 5.2491774559021, max transition frames 3. Worst-1% remains unverified: `TN_PLAYTEST_SOFTWARE_ADAPTER` (`swiftshader`), `TN_CAPTURE_BLANK`, console/runtime errors, topology failures and existing seam/stitch triviality failures prevent valid walk proof. Earlier cold runs returned `TN_PLAYTEST_BRIDGE_MISSING`; scene doctor reached the bridge after 12.3 s but reported Google SwiftShader and a blank frame. Logs: `/tmp/prd566-terrain-warm-green.log`, `/tmp/prd566-warm-green-artifacts/`, `/tmp/prd566-scene-doctor-2.log`.

#### Phase 2: Morph targets replace the CPU blend
**Status:** NOT STARTED
**Files:** `packages/core/src/world-tiles.ts`, `packages/core/__tests__/world-terrain-tiles.spec.ts`
**Implementation:** build the relative morph target with each finer level, drive the influence from the existing transition progress, keep the CPU blend only for `validate`, and count the morph bytes in `residentByteBudget`.
**Verification:** AC-1 and AC-2 close this phase.
- [ ] The same walk runs on the desktop host with matching transition counts; no mobile claim. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/terrain.playtest.json --target desktop --executable <pkg>`

#### Phase 3: Screen-error selection with the distance floor
**Status:** NOT STARTED
**Files:** `packages/core/src/world-tiles.ts`, `packages/core/__tests__/world-streaming-recipe.spec.ts`, `docs/guides/world-streaming.md`
**Implementation:** keep absolute errors per level, call `selectLodLevel` with the props' resolved policy, and clamp to the `lodDistances` floor. The guide states that `lodDistances` is now the nearest switch.
**Verification:** AC-3 closes this phase.
- [ ] Two viewports choose different levels for the same tile, and neither switches nearer than the floor. proof: `pnpm exec vitest run packages/core/__tests__/world-terrain-tiles.spec.ts`
- [ ] The guide documents the floor and the shared pixel budget. proof: `pnpm check:docs`

## Decisions

- 2026-10-10, Phase 1 measurement arm: the measured 2.416 ms per blending 65×65 tile (earlier isolated mean 1.239 ms) meets the unchanged ≥0.5 ms bench gate. Root accepted the unchanged CPU-cost branch after the 1.266 ms bounded repeat; Phases 2–3 remain unticked until their implementation and proof pass. Observed desktop load ranged from 17.56/22.30/25.80 to 30.53/29.26/27.42; these are loaded-desktop results, not unloaded hardware qualification. The laptop declined jobs at 99–100°C. No valid worst-1% or visual-judge verdict is claimed. Remaining proof: rerun AC-2 with `--live-clock` on a named real adapter/display, request the existing `runtime.performance` series, and correlate explicitly aligned world-draw samples with the probe's `blendFrames`; loader/error frames can prevent a valid tail zip, and fixed-step/SwiftShader capture does not hold that claim.
- The walk exposed an engine telemetry blocker: `TerrainTiles.debug()` emitted absent `pendingConstruction` as `undefined`, causing `$.components.terrain.pendingConstruction must be JSON-safe`. Omit only that absent optional field in the shared engine method; no terrain rendering or LOD selection changed. Focused red: 1 failed/19 filtered; green cost file: 16 passed/4 opt-in bench skips. Core/probe typechecks and core build passed; Biome passed with five existing complexity warnings; `pnpm check:docs` checked 3,025 links successfully. No commits, push, PR, merge or archive were performed.
