# PRD-837 — Core owns each shared fact once

**Status:** NOT STARTED
**Priority:** P2 — the open boxes delete 6 inline copies of the LOD recipe (which already disagree on the near-plane default), the 3 declarations of `world.json`, and 3 GPU-sample freshness rules.
**Complexity:** 6 (MEDIUM); risk override: LOD selection and the renderer facts decide what is drawn, so the owner's visual-judge rule applies to Phases 1 and 2
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](README.md) — R5

## Context

Report ids C2, C1, C4, C5, B2, B4, A5. Follows the refactoring batch rule "one owner per value".

| Fact | Copies today | Where |
| --- | --- | --- |
| LOD selection: `worldSphere → conservativeViewDepth → bias → selectLodLevel` | 6 inline sites. One uses `near ?? 0.1`, five use `?? 0`. | `packages/core/src/model-lod.ts:377-430`, `instanced-batch-lod.ts:204-231`, `world-tiles.ts:997-1009,1421-1434`, `world-cell-chunks.ts:775-790` |
| `world.json` contract | 3 declarations. Terrain lacks `impostorDistance`. The biome `impostor: 110` is read by nothing. | `packages/core/src/world-package.ts:98`, `packages/terrain/src/core/world-package.ts:28`, `packages/assets/src/world/proxy.ts:59-64`, `packages/terrain/starter/forest/biome.data.json:39` |
| Logical asset load | 4 paths. A world built without `assets` silently loses the disk cache. | `packages/core/src/world-cells.ts:139-156,891`, `packages/terrain/src/starter.ts:522-536` |
| Backend facts | `"engine" in info` at 8 sites, `kind === "webgpu"` at 58 | `packages/core/src/game-startup.ts:261`, `look/world-environment.ts:945,1212`, `world-cell-render-bundles.ts:213`, `render/chain.ts:685` |
| GPU sample freshness | 8 frames (renderer), 16 (scaler), per frame (budget) | `packages/core/src/renderer.ts:840-862`, `resolution-scaler.ts:107-109,780-798`, `frame-budget.ts:987-1000` |
| `__THREENATIVE__` dev global | 6 owners, 4 shapes, plus a worker mirror list | `packages/core/src/debug.ts:11`, `hot.ts:70`, `game-dev-tools.ts:20-91`, `packages/ui/src/DebugOverlay.tsx:15`, `worker.ts:96` |

## Solution

- `model-lod.ts` exports `selectLodFor(bounds, object, view, errors, level)`. Every site calls it,
  and the near-plane default becomes one value.
- Terrain and assets import core's `IWorldPackage` and validator, and the terrain copy is deleted.
  `loadLogical` is exported from the core world subpath. A `WorldCells` built without `assets` reports.
- `rendererFacts(renderer)` returns `{ kind, ownedEngine, webglFallback, software }`, and core and
  generated code read it. One `GpuReadings` owns timestamp, frame id, freshness and EMA.
- One `dev-global.ts` owns `__THREENATIVE__`, its shape and the worker mirror list.

## Acceptance Criteria

- [ ] AC-1 [local]: Strata forest and the abyss example load and draw, and the visual judge returns NEUTRAL or better. proof: `capture-strata-worlds` forest plus the abyss scenario, with the judge verdict on this box
- [ ] AC-2 [local]: Affected core tests stay green. proof: `pnpm --filter @threenative/core test`

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| LOD pick | `WorldTiles`, `WorldCells`, `InstancedBatchLod`, `ModelLod` update | 5 inline recipes deleted | Phase 1 |
| World package read | `WorldCells.load`, terrain bake | Terrain manifest copy deleted | Phase 1 |
| Backend facts | `Game` startup, `WorldEnvironment.apply`, template `src/render/` | Ad hoc checks deleted | Phase 2 |

## Execution Phases

#### Phase 1: World facts
**Status:** NOT STARTED
**Files:** `model-lod.ts`, `instanced-batch-lod.ts`, `world-tiles.ts`, `world-cell-chunks.ts`, `world-package.ts`, `packages/terrain/src/core/world-package.ts`, `packages/assets/src/world/proxy.ts`.

- [ ] One `selectLodFor`. `rg -n 'conservativeViewDepth\(' packages/core/src` finds only `model-lod.ts`. proof: `pnpm --filter @threenative/core exec vitest run __tests__/model-lod.spec.ts __tests__/model-lod-runtime.spec.ts`
- [ ] Terrain and assets use core's world package type, and the biome `impostor` value reaches `impostorDistance`. proof: `pnpm --filter @threenative/terrain test` plus `pnpm --filter @threenative/core exec vitest run __tests__/world-cells.spec.ts`

#### Phase 2: Renderer facts
**Status:** NOT STARTED
**Files:** new `packages/core/src/renderer-facts.ts`, `renderer.ts`, `resolution-scaler.ts`, `frame-budget.ts`, `look/world-environment.ts`, `game-startup.ts`.

- [ ] `rendererFacts` is the only owned-engine check: `rg -n '"engine" in' packages/core/src` returns nothing. proof: `pnpm --filter @threenative/core exec vitest run __tests__/game.spec.ts`
- [ ] One `GpuReadings` serves the renderer, the scaler and the budget. proof: `pnpm --filter @threenative/core exec vitest run __tests__/frame-budget-gpu-series.spec.ts __tests__/frame-budget.spec.ts`

#### Phase 3: Dev global
**Status:** NOT STARTED
**Files:** new `packages/core/src/dev-global.ts`, `debug.ts`, `hot.ts`, `game-dev-tools.ts`, `worker.ts`, `packages/ui/src/DebugOverlay.tsx`.

- [ ] One module owns `__THREENATIVE__`, and worker mode exposes the same members as page mode. proof: `pnpm --filter @threenative/core exec vitest run __tests__/debug.spec.ts`
