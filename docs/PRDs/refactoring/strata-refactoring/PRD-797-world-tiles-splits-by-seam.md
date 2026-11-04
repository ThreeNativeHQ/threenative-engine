# PRD-797 — `world-tiles.ts` splits by seam

**Status:** NOT STARTED
**Priority:** P2 — `world-tiles.ts` grew from 2 880 to 3 416 lines after PRD-595, and PRD-790 Phase 2 (streaming) will add more to it (all phases open).
**Complexity:** 4 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** None (land before PRD-790 Phase 2 to keep the streaming diff small)
**Batch:** [Strata refactoring](README.md)

## Context

Read-only audit, 2026-11-04:

- `packages/core/src/world-tiles.ts` is 3 416 lines. `TerrainTiles` (about lines 1 504–3 416) has about 78 members. Above it: option and state types (62–265), byte estimates and validation (265–510), mesh build and merge jobs (510–905), LOD morph and level sampling (906–1 340), neighbour-pair stitch planning (1 343–1 500).
- Runtime import cycle: `world.ts` imports `world-tiles.ts` and `world-tiles.ts` imports `Heightfield` (`world.ts:154`) as a value.
- Pinned today by eight specs, the largest `world-terrain-tiles.spec.ts` (3 004 lines), plus `world-terrain-jobs`, `world-terrain-merge`, `-merge-walk`, `-merge-inflight`, `world-tiles-cost`, `world-streaming-perf`, `auto-batch`. Every public method is named in a spec. Not pinned in isolation: `interpolatedLevelHeight`, `surfaceDeltaFromSamples`, `neighborPairs`, `neighborBridgeRequest`.
- Consumers outside core: `examples/prd493-terrain-splat`, `examples/abyss-framework` (`phase477-world-streaming*` scenarios), Strata `world/forestStage.ts`.
- Unreal reference for the names: `FLandscapeRenderSystem` (`UE 5.8.3: Engine/Source/Runtime/Landscape/Public/LandscapeRender.h:448`) keeps per-section LOD apart from the component.

## Solution

Move `Heightfield` to `world-heightfield.ts` first, which breaks the cycle; `world.ts` re-exports it.
Then extract leaf modules in order: `world-tile-geometry.ts` (265–905), `world-tile-lod.ts`
(906–1 340), `world-tile-stitch.ts` (1 343–1 500 plus the `#reconcileNeighbors` helpers),
`world-tile-merge.ts` (the `#rebuildBlock` and `#applyBlock` family). `TerrainTiles` stays in
`world-tiles.ts` with its types. No logic change; `world.ts` exports are unchanged.

## Acceptance Criteria

- [ ] AC-1 [local]: No `world-tile*.ts` or `world-heightfield.ts` file exceeds 1 500 lines, and no world spec changes. proof: `wc -l packages/core/src/world-tile*.ts packages/core/src/world-heightfield.ts` and `git diff --stat packages/core/__tests__/world-terrain*` — Evidence: pending.
- [ ] AC-2 [local]: The world suite and the coverage of the moved code do not drop. proof: `pnpm exec vitest run packages/core/__tests__/world-*.spec.ts` and `pnpm coverage` lines for the new files ≥ the old file's — Evidence: pending.
- [ ] AC-3 [local]: The terrain-splat example still streams and stitches. proof: `examples/prd493-terrain-splat/playtests/terrain-splat.playtest.json` — Evidence: pending.

## Integration Ledger

Integration: unchanged — `@threenative/core/world` exports the same symbols from `world.ts`.

## Execution Phases

#### Phase 1: pin the seams
**Status:** NOT STARTED
**Files:** `packages/core/__tests__/world-tile-seams.spec.ts` (new)
- [ ] Pure specs for `interpolatedLevelHeight` and `surfaceDeltaFromSamples` on fixed level geometry, and for `neighborPairs` plus `neighborBridgeRequest` on a 3×3 grid. Green on today's code. proof: `pnpm exec vitest run packages/core/__tests__/world-tile-seams.spec.ts`
- [ ] Coverage of `world-tiles.ts` recorded on this box. proof: `pnpm coverage -- packages/core/__tests__/world-terrain*.spec.ts packages/core/__tests__/world-tile-seams.spec.ts`

#### Phase 2: break the cycle
**Status:** NOT STARTED
**Files:** `packages/core/src/world-heightfield.ts` (new), `packages/core/src/world.ts`, `packages/core/src/world-tiles.ts`
- [ ] `Heightfield` moved; `world.ts` re-exports it; the cycle is gone. proof: `pnpm exec madge --circular packages/core/src/world.ts` (or a grep for the value import) plus the world suite

#### Phase 3: extract the leaves
**Status:** NOT STARTED
**Files:** `packages/core/src/world-tile-{geometry,lod,stitch,merge}.ts` (new), `packages/core/src/world-tiles.ts`
- [ ] Four modules extracted. proof: AC-1 and AC-2
- [ ] The terrain-splat playtest stays green. proof: AC-3
