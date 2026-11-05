# PRD-796 — Strata `game.ts` is wiring, not a world switch

**Status:** NOT STARTED
**Priority:** P2 — `game.ts` is 2 070 lines with 24 world-name comparisons and about 1 200 lines of telemetry mixed into the world wiring (all phases open).
**Complexity:** 4 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-791](PRD-791-a-biome-is-a-validated-data-file.md)
**Batch:** [Strata refactoring](README.md)

## Context

- `examples/strata-terrain-preview/src/game.ts` is 2 070 lines. It holds spawn points, camera offsets, vista flags, sapling heights, the 1–5 world keys, a shared `baked.json` slice for forest and coastal, and the far-forest gate `world === "forest"`.
- Telemetry spans `game.ts`, `viewStatistics.ts` and `render/waterProof.ts` (596, enabled for coastal only): a reveal and pipeline probe, a per-view GPU window aggregator and a spawn-gate reporter, about 1 200 lines in total.
- The playtests that pin this game today: `terrain`, `walk`, `edge`, `vista`, `reveal`, `loop`, `lod`, `collide`, `swim`.

## Solution

After PRD-791, the world keys come from the biome folder list and every per-world value from the
row. Telemetry moves to one example module, `src/diagnostics.ts`; no second game consumes it, so it
does not enter a package. `game.ts` keeps scene lifecycle and wiring only.

## Acceptance Criteria

- [ ] AC-1 [local]: `game.ts` is under 800 lines and holds no world name. proof: `wc -l` and `rg -n '"(forest|coastal|alpine|desert|tundra)"' examples/strata-terrain-preview/src/game.ts` prints nothing — Evidence: pending.
- [ ] AC-2 [local]: Every Strata playtest gives the same result as before the split. proof: the nine scenarios — Evidence: pending.

## Integration Ledger

Integration: unchanged — the scene, its entry point and its playtests stay the same; code moves between example files.

## Execution Phases

#### Phase 1: pin the game
**Status:** NOT STARTED
**Files:** `examples/strata-terrain-preview/__tests__/world-keys.spec.ts` (new)
- [x] A spec maps keys 1–5 to worlds and pins the spawn and camera pose per world on today's code. proof: `pnpm --filter strata-terrain-preview exec vitest run __tests__/world-keys.spec.ts`
  - 3/3 green on today's code. `WORLD_SELECT` (new, `src/game.ts`) is now the selector's one owner: the input map spreads it, the frame loop walks `Object.keys(WORLD_SELECT)`, and the spec pins `Digit1`–`Digit5` to forest, coastal, alpine, desert and tundra in that order. A third test compares the selector with `BIOME_SPECS`, so a sixth biome row without a key and a key without a row both fail.
  - Spawn and camera, per world: `SPAWN_POINTS` and `SPAWN_CAMERA_OFFSET` equal the pinned pairs, and the launch camera is the spawn plus that offset two metres above the ground under the spawn. The ground under each spawn is read from that world's own bake (`heightAt`, `toBeCloseTo(…, 4)`): forest 16.449971199035645 m, coastal 3.349959373474121 m, alpine 15.999755859375 m, desert 10.199771881103516 m, tundra 28.021677017211914 m.
- [x] The nine playtests run on today's code and their results are recorded on this box. proof: each `playtests/*.playtest.json`
  - Ran all nine on HEAD 44f08f71e with `examples/strata-terrain-preview/local-assets` present, `TN_PLAYTEST_HOST_DISPLAY=1`, `--browser-recipe webgpu --headed`, `adapter.info` nvidia/turing (RTX 2080, not SwiftShader), dev server on port 5196. Every run reports 0 network errors, so the licensed art loads.

  | scenario | exit | console errors | failed assertions | record |
  |---|---|---|---|---|
  | `terrain` | 2 | 0 | `diagnostics` (`TN_PLAYTEST_OBSERVATION_UNAVAILABLE`) | `travel` last 41.20020499406995 m against the scenario's 50 m wait |
  | `reveal` | 1 | 224 | `props.reveal.pipelineCensusAvailable`, `props.reveal.pipelinesCreated`, `diagnostics` | census unavailable, `pipelinesCreated` -1, `worldReady` and `revealComplete` true |
  | `loop` | 1 | 249 | `props.reveal.pipelineCensusAvailable`, `props.reveal.pipelinesSinceReveal`, `diagnostics` | `travel` 59.83181684386177 m, 844 frames |
  | `lod` | 1 | 456 | `diagnostics` | 6 perf warnings, `coverNearEye` 7 852 |
  | `collide` | 1 | 308 | `diagnostics` | 3 perf warnings, `travel` 52.135304751486395 m |
  | `swim` | 1 | 347 | `diagnostics` | 10 perf warnings, 1 runtime diagnostic, `TN_CAPTURE_BLANK`, `travel` 131.21905403796222 m |
  | `edge` | 1 | 237 | `diagnostics` | every resource assertion passes: `travel` 149.1231472588627 m, `edgeOvershoot` 58.02667236328125 m, `grounded` true |
  | `vista` | 1 | 424 | `visual.0.region.darkPixels`, `diagnostics` | `coverNearEye` 7 852 and `currentViewWindows` 3 pass; 0 dark pixels against a 0.4 floor |
  | `walk` | 2 | 0 | `diagnostics` (`TN_PLAYTEST_OBSERVATION_UNAVAILABLE`) | `travel` last 41.19384339607136 m against the scenario's 50 m wait |

  - Sim-side values every arm shares, which is what AC-2 compares: `grounded` true, `bilinearDifference` 1.5, `maxContactError` between 3.09e-05 m and 7.04e-05 m, `contactSamples` 101–1 820, `worldReady` and `revealComplete` true wherever the scenario waits for them.
  - Two causes, both older than this PRD, keep the board red on this machine. The ground material's pipeline binds 24 fragment-stage samplers and this device allows 16 (`The number of samplers (24) in the Fragment stage exceeds the maximum per-stage limit (16)`), so the terrain surface draws white under the vegetation; `edge` measures bottom-third RGB 235.3/239.8/244.0. The pipeline census reports itself unavailable, which fails `reveal` and `loop` on their own assertion. `walk` and `terrain` time out at 41.2 m because the scenario holds `KeyD` for 420 ticks at `JOG` 6 m/s, which covers 42 m, against a 50 m pin; `loop`'s longer hold reaches 59.83 m at the same pace, which confirms the rate rather than the terrain.

#### Phase 2: split
**Status:** NOT STARTED
**Files:** `src/game.ts`, `src/diagnostics.ts` (new), `src/viewStatistics.ts`, `render/waterProof.ts`
- [ ] Telemetry in `diagnostics.ts`; world values from the biome row. proof: AC-1 plus `strata-view-statistics.spec.ts` and `water-proof.spec.ts`

#### Phase 3: prove the game
**Status:** NOT STARTED
**Files:** none
- [ ] The nine playtests match the Phase 1 record. proof: AC-2
