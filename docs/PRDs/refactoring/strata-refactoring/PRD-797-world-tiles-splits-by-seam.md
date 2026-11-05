# PRD-797 — `world-tiles.ts` splits by seam

**Status:** PARTIAL — Phases 1 and 2 are done on this branch (the four seams are pinned and the
`world.ts` ↔ `world-tiles.ts` cycle is gone); Phase 3, the four leaf modules, is open.
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
- [x] Pure specs for `interpolatedLevelHeight` and `surfaceDeltaFromSamples` on fixed level geometry, and for `neighborPairs` plus `neighborBridgeRequest` on a 3×3 grid. Green on today's code. proof: `pnpm exec vitest run packages/core/__tests__/world-tile-seams.spec.ts` — Evidence: 13/13 pass, run against the unsplit `world-tiles.ts` before any line moved. `interpolatedLevelHeight`: an exact vertex, a column blend, a row blend, a sample clamped outside the level, and a non-finite stored height failing closed with the file's own message. `surfaceDeltaFromSamples`: 0 between a level and the same surface sampled coarser, the largest gap where the probe grid is wider, and a 5×5 probe catching a 6 m peak at the centre that a 3×3 probe would miss. `neighborPairs`: the 12 facing pairs of a 3×3 grid exactly once, 8 after a hole is removed, 0 for an empty map. `neighborBridgeRequest`: `undefined` at equal resolution, the finer resolution and both edge sides for 3 vs 5, and the same sorted keys with the pair's order reversed. The four functions and `IStitchRequest` gained an `export` for the pin; `world.ts` re-exports none of them, so the package surface is unchanged.
- [x] Coverage of `world-tiles.ts` recorded on this box. proof: `pnpm coverage -- packages/core/__tests__/world-terrain*.spec.ts packages/core/__tests__/world-tile-seams.spec.ts` — Evidence: `pnpm exec vitest run --coverage --coverage.include='packages/core/src/world-tiles.ts' --coverage.thresholds.lines=0 --coverage.thresholds.functions=0 --coverage.thresholds.branches=0 --coverage.thresholds.statements=0` over `world-terrain-{tiles,jobs,merge,merge-walk,merge-inflight}`, `world-tiles-cost` and `world-tile-seams`: 7 files, 151 tests pass, 4 skipped, 56 s; `world-tiles.ts` 94.7% statements (1 466/1 548), 88.12% branches (683/775), 97.01% functions (195/201), 95.71% lines (1 318/1 377). This is the number each extracted module's coverage is compared against in AC-2; the project-wide thresholds are off for the focused include.

#### Phase 2: break the cycle
**Status:** DONE
**Files:** `packages/core/src/world-heightfield.ts` (new), `packages/core/src/world.ts`, `packages/core/src/world-tiles.ts`
- [x] `Heightfield` moved; `world.ts` re-exports it; the cycle is gone. proof: `pnpm exec madge --circular packages/core/src/world.ts` (or a grep for the value import) plus the world suite — Evidence: `world-heightfield.ts` holds 748 lines (the class, its seven exported types and its private helpers, moved verbatim); `world.ts` 816 → 75 lines and is now `export * from "./world-heightfield.js"` plus the re-exports it already had. `rg -n 'from "\.{1,2}/world\.js"' packages/core/src` prints nothing (exit 1): `world-tiles.ts`, `world-tile-observation.ts`, `world-region.ts` and `snow-field.ts` name `./world-heightfield.js`, so nothing inside the package imports the re-exporting module and the `world.ts` ↔ `world-tiles.ts` cycle is gone (madge is not installed here, so the grep is the proof). `pnpm --filter @threenative/core typecheck` exits 0. `world-terrain-tiles` 78/78, `world-heightfield` and `world-terrain-jobs` green. The world suite's failures are the same 12 in the same five files before and after the move (baseline run on the clean tree at 8edfd6d81, `git status` clean): `world-streaming-perf` 2 and `world-cells-chunk-merge` 4 are the pre-existing class PRD-802's AC-3 records, and `world-lod-input-budget` 4, `world-impostor-surface` 1, `world-bundle-safety` 1 are material/TSL specs this split does not touch; the pass count rose 835 → 848 with the new seams spec. `biome check` on the four touched files reports warnings only, all complexity warnings the moved code carried before.

#### Phase 3: extract the leaves
**Status:** NOT STARTED
**Files:** `packages/core/src/world-tile-{geometry,lod,stitch,merge}.ts` (new), `packages/core/src/world-tiles.ts`
- [ ] Four modules extracted. proof: AC-1 and AC-2
  - Not started. Measured on the current file before starting, so the next lane does not discover it
    late: the Solution's four ranges are 265–905 (641 lines), 906–1 340 (435) and 1 343–1 500 (158),
    plus 2 742–3 112 for the seam/reconcile helpers (371) and 3 128–3 352 for the merge family (225) —
    about 1 830 lines. `world-tiles.ts` would keep about 1 586, so AC-1's 1 500 needs either one module
    the Solution does not name (the byte and budget estimates at 376–465 are the obvious fifth, 90
    lines) or a narrower AC. The class itself is 1 913 lines (1 504–3 416) and its constructor alone is
    270 (1 616–1 885), so no set of leaf modules reaches a 1 000-line file.
- [ ] The terrain-splat playtest stays green. proof: AC-3
