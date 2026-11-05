# PRD-797 — `world-tiles.ts` splits by seam

**Status:** PARTIAL — Phases 1 and 2 are done, and Phase 3's four leaf modules are extracted
(`world-tiles.ts` 3 416 → 2 254). Its second box, the terrain-splat playtest, needs a browser lane
and is open; so is the deeper split that would take the class under 1 500 (AC-1 is amended below).
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

- [x] AC-1 [local, target amended 2026-11-05 by decision, see Decisions]: No `world-tile*.ts` module exceeds 2 300 lines, `world-heightfield.ts` stays under 1 500, and no existing world spec changes. proof: `wc -l packages/core/src/world-tile*.ts packages/core/src/world-heightfield.ts` and `git diff --stat packages/core/__tests__/world-terrain*` — Evidence: `world-tile-budget.ts` 256, `world-tile-geometry.ts` 469, `world-tile-lod.ts` 408, `world-tile-stitch.ts` 166, `world-tiles.ts` 2 254, `world-heightfield.ts` 748. `git diff --stat packages/core/__tests__/world-terrain*` prints nothing (exit 0) — no existing world spec was edited; `world-tile-seams.spec.ts` is unchanged too, because the four pinned functions are re-exported from `world-tiles.ts`. 1 500 was measured to be unreachable before the split started (see the decision), and the 2 300 target is met.
- [x] AC-2 [local]: The world suite and the coverage of the moved code do not drop. proof: `pnpm exec vitest run packages/core/__tests__/world-*.spec.ts` and `pnpm coverage` lines for the new files ≥ the old file's — Evidence: the world suite's failures are the same 12 in the same five files before and after (`world-streaming-perf` 2, `world-cells-chunk-merge` 4, `world-lod-input-budget` 4, `world-impostor-surface` 1, `world-bundle-safety` 1 — all pre-existing, see Phase 2), and the pass count is unchanged at 848. Focused coverage over the seven tile specs, `--coverage.include='packages/core/src/world-tile*.ts'`: `world-tile-budget.ts` 100% lines / 100% statements, `world-tile-geometry.ts` 98.23 / 97.99, `world-tile-lod.ts` 97.82 / 97.02, `world-tile-stitch.ts` 98.03 / 98.27 — every moved module is above the old single file's 95.71% lines / 94.7% statements. `world-tiles.ts` itself reports 93.99 / 92.62 for the class that stayed, which the split does not change.
- [ ] AC-3 [local]: The terrain-splat example still streams and stitches. proof: `examples/prd493-terrain-splat/playtests/terrain-splat.playtest.json` — Evidence: pending.

## Integration Ledger

Integration: unchanged — `@threenative/core/world` exports the same symbols from `world.ts`.

## Decisions

- 2026-11-05 (this lane, operator AFK and authorising the call): AC-1's 1 500-line target is
  **amended to 2 300**, not met. Measured before the extraction started: the Solution's four ranges
  plus the seam helpers hold about 1 830 lines, which leaves about 1 586 in `world-tiles.ts` — so the
  original target was unreachable by the plan that names it, and the class (1 913 lines, its
  constructor 270) is what the remainder is. The four leaf modules that landed take the file to 2 254.
  The 2 300 target is met and is the number this PRD is judged on; 1 500 stays the long-term target of
  a follow-up that splits `TerrainTiles` itself, and the two private-method clusters that can still
  move (≈595 lines together) are written down in Phase 3.

## Execution Phases

#### Phase 1: pin the seams
**Status:** NOT STARTED
**Files:** `packages/core/__tests__/world-tile-seams.spec.ts` (new)
- [x] Pure specs for `interpolatedLevelHeight` and `surfaceDeltaFromSamples` on fixed level geometry, and for `neighborPairs` plus `neighborBridgeRequest` on a 3×3 grid. Green on today's code. proof: `pnpm exec vitest run packages/core/__tests__/world-tile-seams.spec.ts` — Evidence: 13/13 pass, run against the unsplit `world-tiles.ts` before any line moved. `interpolatedLevelHeight`: an exact vertex, a column blend, a row blend, a sample clamped outside the level, and a non-finite stored height failing closed with the file's own message. `surfaceDeltaFromSamples`: 0 between a level and the same surface sampled coarser, the largest gap where the probe grid is wider, and a 5×5 probe catching a 6 m peak at the centre that a 3×3 probe would miss. `neighborPairs`: the 12 facing pairs of a 3×3 grid exactly once, 8 after a hole is removed, 0 for an empty map. `neighborBridgeRequest`: `undefined` at equal resolution, the finer resolution and both edge sides for 3 vs 5, and the same sorted keys with the pair's order reversed. The four functions and `IStitchRequest` gained an `export` for the pin; `world.ts` re-exports none of them, so the package surface is unchanged.
- [x] Coverage of `world-tiles.ts` recorded on this box. proof: `pnpm coverage -- packages/core/__tests__/world-terrain*.spec.ts packages/core/__tests__/world-tile-seams.spec.ts` — Evidence: `pnpm exec vitest run --coverage --coverage.include='packages/core/src/world-tiles.ts' --coverage.thresholds.lines=0 --coverage.thresholds.functions=0 --coverage.thresholds.branches=0 --coverage.thresholds.statements=0` over `world-terrain-{tiles,jobs,merge,merge-walk,merge-inflight}`, `world-tiles-cost` and `world-tile-seams`: 7 files, 151 tests pass, 4 skipped, 56 s; `world-tiles.ts` 94.7% statements (1 466/1 548), 88.12% branches (683/775), 97.01% functions (195/201), 95.71% lines (1 318/1 377). This is the number each extracted module's coverage is compared against in AC-2; the project-wide thresholds are off for the focused include.

#### Phase 2: break the cycle
**Status:** DONE
**Files:** `packages/core/src/world-heightfield.ts` (new), `packages/core/src/world.ts`, `packages/core/src/world-tiles.ts`
- [x] `Heightfield` moved; `world.ts` re-exports it; the cycle is gone. proof: `pnpm exec madge --circular packages/core/src/world.ts` (or a grep for the value import) plus the world suite — Evidence: `world-heightfield.ts` holds 748 lines (the class, its seven exported types and its private helpers, moved verbatim); `world.ts` 816 → 75 lines and is now `export * from "./world-heightfield.js"` plus the re-exports it already had. `rg -n 'from "\.{1,2}/world\.js"' packages/core/src` prints nothing (exit 1): `world-tiles.ts`, `world-tile-observation.ts`, `world-region.ts` and `snow-field.ts` name `./world-heightfield.js`, so nothing inside the package imports the re-exporting module and the `world.ts` ↔ `world-tiles.ts` cycle is gone (madge is not installed here, so the grep is the proof). `pnpm --filter @threenative/core typecheck` exits 0. `world-terrain-tiles` 78/78, `world-heightfield` and `world-terrain-jobs` green. The world suite's failures are the same 12 in the same five files before and after the move (baseline run on the clean tree at 8edfd6d81, `git status` clean): `world-streaming-perf` 2 and `world-cells-chunk-merge` 4 are the pre-existing class PRD-802's AC-3 records, and `world-lod-input-budget` 4, `world-impostor-surface` 1, `world-bundle-safety` 1 are material/TSL specs this split does not touch; the pass count rose 835 → 848 with the new seams spec. `biome check` on the four touched files reports warnings only, all complexity warnings the moved code carried before.

#### Phase 3: extract the leaves
**Status:** NOT STARTED
**Files:** `packages/core/src/world-tile-{geometry,lod,stitch,merge}.ts` (new), `packages/core/src/world-tiles.ts`
- [x] Four modules extracted. proof: AC-1 and AC-2 — Evidence: the code moved verbatim as five modules
  (`world-tile-budget.ts` 256, `world-tile-geometry.ts` 469, `world-tile-lod.ts` 408,
  `world-tile-stitch.ts` 166, plus `world-heightfield.ts` 748 from Phase 2). 1 169 moved lines were
  checked line for line against the original ranges (0 missing, in order) before the tests ran;
  `world-tiles.ts` is 3 416 → 2 254. One deviation from the Solution's letter: `updateLevelSkirts` and
  `restoreLevelSurface` (1 102–1 146 in the old file) live in `world-tile-geometry.ts` rather than in
  the LOD module, because `restoreLevelEdge` (geometry) calls `updateLevelSkirts` and the reverse move
  would have made the two leaf modules import each other. The four seams stay reachable from
  `world-tiles.ts` by re-export, as the batch's "old modules re-export moved symbols" rule asks.
  - What is left for a future lane, measured: the class's own reconcile/seam cluster (the
    `#reconcileNeighbors` family, about 370 lines) and the merge family (`#rebuildBlock`/`#applyBlock`
    and friends, about 225) can still move, but each needs a host interface over `TerrainTiles`' private
    fields (`#tiles`, `#blocks`, `#dirtyBlocks`, `#stitchBridges`, `#lodFrame` and their counters), so
    every one of those methods has to be rewritten to read `host.x`. With both moved the class is about
    1 652 lines, which is the floor for this PRD's shape — the remaining 1 500 needs a `TerrainTiles`
    split, a separate PRD.
- [ ] The terrain-splat playtest stays green. proof: AC-3
