# PRD-796 — Strata `game.ts` is wiring, not a world switch

**Status:** DONE (2026-11-05) — all phases and both acceptance boxes are ticked. `game.ts` was 732 lines when ticked (738 at 95d804746) with no world name, the meadow, the spawn gate and the player rig live in their own example modules, and the nine playtests on the owned engine (`TN_ENGINE=threenative`) match the Phase-1 record. The Phase 2 box closed once `strata-view-statistics.spec.ts` pinned 22 measured holds (`fb068fbb9`).
**Priority:** P2 — `game.ts` is 2 070 lines with 24 world-name comparisons and about 1 200 lines of telemetry mixed into the world wiring; all phases are done.
**Complexity:** 4 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-791](PRD-791-a-biome-is-a-validated-data-file.md)
**Batch:** [Strata refactoring](../../../packages/terrain/docs/PRDs/strata-refactoring/README.md)

## Context

- `examples/strata-terrain-preview/src/game.ts` is 2 070 lines. It holds spawn points, camera offsets, vista flags, sapling heights, the 1–5 world keys, a shared `baked.json` slice for forest and coastal, and the far-forest gate `world === "forest"`.
- Telemetry spans `game.ts`, `viewStatistics.ts` and `render/waterProof.ts` (596, enabled for coastal only): a reveal and pipeline probe, a per-view GPU window aggregator and a spawn-gate reporter, about 1 200 lines in total.
- The playtests that pin this game today: `terrain`, `walk`, `edge`, `vista`, `reveal`, `loop`, `lod`, `collide`, `swim`.

## Solution

After PRD-791, the world keys come from the biome folder list and every per-world value from the
row. Telemetry moves to one example module, `src/diagnostics.ts`; no second game consumes it, so it
does not enter a package. `game.ts` keeps scene lifecycle and wiring only.

## Acceptance Criteria

- [x] AC-1 [local]: `game.ts` is under 800 lines and holds no world name. proof: `wc -l` and `rg -n '"(forest|coastal|alpine|desert|tundra)"' examples/strata-terrain-preview/src/game.ts` prints nothing — Evidence: `wc -l examples/strata-terrain-preview/src/game.ts` prints 732, and the grep exits 1 with no output. Rerun 2026-11-05 at 95d804746: `game.ts` 738 lines, `sceneProps.ts` 605, `diagnostics.ts` 1 009, the grep exits 1; later commits `089ce28b6` and `08cab127b` added the lines, and the cap of 800 holds. The removed 682 lines now live in `src/sceneProps.ts` (603: the props and staged-world build), `src/playerRig.ts` (222: the capsule, the mannequin and the follow camera), `src/spawnGate.ts` (183: the admission gate and its failure receipt) and `src/sceneState.ts` (21: the state shape the three share). `src/game.ts` keeps scene lifecycle and wiring.
- [x] AC-2 [local]: Every Strata playtest gives the same result as before the split. proof: the nine scenarios — Evidence: re-ran all nine on the owned engine (`TN_ENGINE=threenative`) on both arms: the Phase-1 code (arm `p1`, `game.ts` at `d464fe0ea` plus `render/worldData.ts`) and the split code (arms `p2` and `p2b`). 0 console errors in all nine split runs (Phase 1: 0 except `reveal`'s 3 and `lod`'s 2, so the split count is lower, not equal) and the measured sim values are identical to the millimetre where the run reaches them: `edge` `travel` 149.1231472588627 m, `edgeOvershoot` 58.02667236328125 m, `maxContactError` 7.766071286141596e-05 m, `contactSamples` 1 094 on both arms; `swim` `travel` 131.21905403796222 m, `swimSamples` 406, `swimExits` 2, `swimDrift` 2.7151123884826696 m on both arms; `vista` and `lod` `coverNearEye` 7 852 on both arms; `collide` `propColliders` 104 and `propOverlapFrames` 0 on both arms; `loop` `travel` 59.8332 m (Phase 1) against 59.8341 m; `collide` `travel` 52.1364 m against 52.1403 m; `terrain` and `walk` time out on the same 50 m wait at 41.218 m and 41.197 m on both arms. The pass/fail verdict differs only where a machine-timing policy fired, and re-running the Phase-1 code on the same machine minutes later (arm `p1b`) reproduces those same failures: `edge` and `collide` fail on the shadow-draw `TN_PLAYTEST_PERF_WARNING` pre-split too. Evidence limits (audit, 2026-11-05): the raw artifacts of arms `p1`, `p1b`, `p2` and `p2b` are not committed or cited, and the `p1b` explanation is not independently verified; the `edge` numbers also match PRD-795's AC-2 on the same engine.

## Integration Ledger

Integration: unchanged — the scene, its entry point and its playtests stay the same; code moves between example files.

## Execution Phases

#### Phase 1: pin the game
**Status:** DONE
**Files:** `examples/strata-terrain-preview/__tests__/world-keys.spec.ts` (new)
- [x] A spec maps keys 1–5 to worlds and pins the spawn and camera pose per world on today's code. proof: `pnpm --filter strata-terrain-preview exec vitest run __tests__/world-keys.spec.ts`
  - 3/3 green on today's code. `WORLD_SELECT` (new, `src/game.ts`) is now the selector's one owner: the input map spreads it, the frame loop walks `Object.keys(WORLD_SELECT)`, and the spec pins `Digit1`–`Digit5` to forest, coastal, alpine, desert and tundra in that order. A third test compares the selector with `BIOME_SPECS`, so a sixth biome row without a key and a key without a row both fail.
  - Spawn and camera, per world: `SPAWN_POINTS` and `SPAWN_CAMERA_OFFSET` equal the pinned pairs, and the launch camera is the spawn plus that offset two metres above the ground under the spawn. The ground under each spawn is read from that world's own bake (`heightAt`, `toBeCloseTo(…, 4)`): forest 16.449971199035645 m, coastal 3.349959373474121 m, alpine 15.999755859375 m, desert 10.199771881103516 m, tundra 28.021677017211914 m.
- [x] The nine playtests run on today's code and their results are recorded on this box. proof: each `playtests/*.playtest.json`
  - Ran all nine on the owned engine (`TN_ENGINE=threenative`, the C++ engine compiled to Wasm: `threenative.config.ts` sets `engine: "threenative"`) with `examples/strata-terrain-preview/local-assets` present, `TN_PLAYTEST_HOST_DISPLAY=1`, `--browser-recipe webgpu --headed`, `adapter.info` nvidia/turing (RTX 2080, not SwiftShader), dev server `TN_ENGINE=threenative pnpm exec vite --port 5196 --strictPort --host 127.0.0.1`. `TN_FRAME_BUDGET` reports `"threads":"on (8)"`, the page is cross-origin isolated (COOP `same-origin`, COEP `require-corp`) and no run logs `TN_WEB_THREADS_OFF`. Every run reports 0 network errors, so the licensed art loads. These are the Phase-1 numbers the split is compared with.
  - The upstream-three lane these numbers replaced bound 24 fragment-stage samplers against this adapter's 16, drew the terrain white (bottom-third RGB 235.3/239.8/244.0) and logged 224–456 console errors. The owned engine draws the textured surface: 0 console errors on all nine, and bottom-third mean RGB between 82.4/96.0/82.6 and 145.5/152.3/74.4, every channel well under 220.

  | scenario | exit | console errors | failed assertions | record (owned engine) |
  |---|---|---|---|---|
  | `terrain` | 2 | 0 | `diagnostics` (`TN_PLAYTEST_OBSERVATION_UNAVAILABLE`) | `travel` last 41.21794833602745 m against the scenario's 50 m wait |
  | `reveal` | 2 | 3 | `diagnostics` (`TN_PLAYTEST_CAPTURE_PROVENANCE_MISSING`) | capture-provenance flake (no screenshot artifact); `worldReady` and `revealComplete` true, `travel` 0.0032754902014157116 m |
  | `loop` | 0 | 0 | — | `travel` 59.833165503889774 m, 844 frames |
  | `lod` | 2 | 2 | `diagnostics` (`TN_PLAYTEST_OBSERVATION_UNAVAILABLE`) | observation timeout; `coverNearEye` 7 852 |
  | `collide` | 0 | 0 | — | `travel` 52.1363586628161 m, `propColliders` 104, `propOverlapFrames` 0 |
  | `swim` | 0 | 0 | — | `travel` 131.21905403796222 m, `swimSamples` 406, `swimExits` 2, `swimDrift` 2.7151123884826696 m |
  | `edge` | 1 | 0 | `diagnostics` (`TN_PLAYTEST_PERF_WARNING`) | every resource assertion passes: `travel` 149.1231472588627 m, `edgeOvershoot` 58.02667236328125 m, `grounded` true, `maxContactError` 7.766071286141596e-05 m, `contactSamples` 1 094 |
  | `vista` | 0 | 0 | — | `coverNearEye` 7 852, `currentViewWindows` 7, `worldReady` and `revealComplete` true |
  | `walk` | 2 | 0 | `diagnostics` (`TN_PLAYTEST_OBSERVATION_UNAVAILABLE`) | `travel` last 41.1972960659014 m against the scenario's 50 m wait |

  - Sim-side values every arm shares, which is what AC-2 compares: `grounded` true, `bilinearDifference` 1.5, `maxContactError` between 3.11e-05 m and 7.15e-05 m, `contactSamples` 268–1 820, `worldReady` and `revealComplete` true wherever the scenario waits for them.
  - What keeps the board red on the owned engine is the scenarios' own waits and the machine's timing policy, not the game. `walk` and `terrain` time out at 41.2 m because their walk step holds 420 ticks at `JOG` 6 m/s, which covers 42 m, against a 50 m pin; `loop`'s longer hold reaches 59.83 m at the same pace. The `TN_PLAYTEST_PERF_WARNING` and `TN_PLAYTEST_CAPTURE_PROVENANCE_MISSING` failures move between runs and between arms on identical code: the Phase-1 code re-run minutes later (`edge`, `collide`, `swim`, labelled `p1b`) fails `edge` and `collide` on the same shadow-draw warning that the pre-split run hours earlier passed, and `lod`'s `propTriangles` pin (20.78 M against an 18 M cap) lands either side of the cap in the same world.

#### Phase 2: split
**Status:** DONE — every part of the split landed and the spec the box names is green (6/6, `fb068fbb9`).
**Files:** `src/game.ts`, `src/diagnostics.ts` (new), `src/worlds.ts` (new), `src/viewStatistics.ts`, `render/waterProof.ts`
- [x] Telemetry in `diagnostics.ts`; world values from the biome row. proof: AC-1 plus `strata-view-statistics.spec.ts` and `water-proof.spec.ts`
  - Ran both named specs before this box was ticked: `pnpm exec vitest run __tests__/strata-view-statistics.spec.ts` reports 6 passed of 6 (rerun 2026-11-05 at 95d804746: 6/6), alone 3/3, and `pnpm --filter strata-terrain-preview exec vitest run __tests__/water-proof.spec.ts` reports 17 passed of 17. `strata-view-statistics.spec.ts` was red until now on its own pin, which `4bbdfac16` moved ("a fixed forest vista pose and scenario for the look goal" added the `vista` measured hold, 21 holds to 22); the spec now pins 22. AC-1 stands: `wc -l examples/strata-terrain-preview/src/game.ts` prints 732 and `rg -n '"(forest|coastal|alpine|desert|tundra)"' examples/strata-terrain-preview/src/game.ts` exits 1 with no output. Telemetry lives in `src/diagnostics.ts` (1 009 lines), and the launch point, camera offsets, start world and bake come from the biome row.
  - Moved to `src/diagnostics.ts` (new, 1 006 lines when written, 1 009 at 95d804746): the closed frame-budget window and the per-view window groups, their `frameBudget.onWindow` handler, the per-frame counters (`observeFrame`), the reveal and pipeline probe (`createRevealProbe`), the step measurements (`createMeasure`: travel, edge overshoot, prop overlap, the asymmetric contact witness, the swim samples, the water samples, the prop and cover counts) and the state report (`publish`), plus the measurement half of the initial state (`initialDiagnosticsState`).
  - World values come from the biome row: the launch point and the camera offsets read `spec.spawn.at` and `spec.spawn.cameraOffset`, the scenes are built from `WORLD_ORDER`, the start world is `START_WORLD`, and `render/worldData.ts` is gone because the row owns those two pairs. `src/worlds.ts` (new, 49 lines) owns the selector list and the baked-bundle loader, which reads `spec.bake`.
  - The two specs keep their pins: `world-keys.spec.ts` reads `WORLD_SELECT` from `src/worlds.ts` and the spawn from `biomeSpec(world).spawn`, `biome-values.spec.ts` compares the same row values against its own literals, and `forest-startup.spec.ts` calls `witnessAsymmetricContact()` instead of pulling the witness out of `game.ts` by text, because the witness moved with the code it witnesses.
  - `water-proof.spec.ts` green. Historical, superseded by the first bullet (the pin moved to 22 in `fb068fbb9`): `strata-view-statistics.spec.ts` was red on a pin this PRD does not touch: it expects 21 measured holds in `playtests/terrain.playtest.json` and the scenario holds 22.
  - AC-1's line cap is met: `game.ts` is 732 lines, and the three moves it named — the spawn gate and its failure report, the props and staged-world build, the player rig with its follow camera — are `src/spawnGate.ts`, `src/sceneProps.ts` and `src/playerRig.ts`. `src/sceneState.ts` holds the state the three share, so none of them imports the scene.
  - The pins followed the code. `__tests__/strata-loading.spec.ts` extracts production declarations by name and now reads the three sources in turn; its gate, spawn-readiness, progress and failure-receipt cases are green (51/51), including five `defers hidden world draws until prepared streams attach` cases that were red before this split for a missing `look` in their sandbox. `water-proof.spec.ts`, `world-keys.spec.ts` and `biome-values.spec.ts` are green; the example's whole suite goes from 22 failed of 242 to 17 failed of 242, and every remaining red is the one already listed above or in a package this PRD does not touch (`prop-lod`, `prop-streaming`, `forest-stage`, `temporalAA`, `terrain-splat-package`).
  - Closed 2026-11-05 (`fb068fbb9`, 6/6 on the rerun). Historical note, kept for the record: `strata-view-statistics.spec.ts` was still red on its own pin (it expects 21 measured holds in `playtests/terrain.playtest.json` and the scenario holds 22), which this PRD does not touch; `pnpm --filter strata-terrain-preview exec vitest run __tests__/strata-view-statistics.spec.ts` reports 1 failed of 30 across the four specs run with it.

#### Phase 3: prove the game
**Status:** DONE
**Files:** none
- [x] The nine playtests match the Phase 1 record. proof: AC-2
  - Nine scenarios on the split code (arms `p2`, `p2b`) against the Phase-1 owned-engine record (`p1`): a console-error count of 0 in all nine (Phase 1 recorded 3 for `reveal` and 2 for `lod`, so the split is lower, not equal) and the same sim values wherever a run reaches them, listed on AC-2. The three parts the split moved — the spawn gate, the props build and the player rig — are pinned by `strata-loading.spec.ts`, which is 51/51 green (rerun 2026-11-05 at 95d804746: 51/51), including the five cases that were red before the split.
