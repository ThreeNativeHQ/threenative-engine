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
- [ ] The nine playtests run on today's code and their results are recorded on this box. proof: each `playtests/*.playtest.json`

#### Phase 2: split
**Status:** NOT STARTED
**Files:** `src/game.ts`, `src/diagnostics.ts` (new), `src/viewStatistics.ts`, `render/waterProof.ts`
- [ ] Telemetry in `diagnostics.ts`; world values from the biome row. proof: AC-1 plus `strata-view-statistics.spec.ts` and `water-proof.spec.ts`

#### Phase 3: prove the game
**Status:** NOT STARTED
**Files:** none
- [ ] The nine playtests match the Phase 1 record. proof: AC-2
