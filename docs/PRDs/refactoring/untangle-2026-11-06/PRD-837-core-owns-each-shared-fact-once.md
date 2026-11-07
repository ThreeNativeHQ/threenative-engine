# PRD-837 — Core owns each shared fact once

**Status:** PARTIAL — Phase 2 landed and Phase 3 landed; the LOD recipe and the `world.json` contract are open.
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

The LOD recipe is two claims, because one of them changes what is drawn and the other does not:

- [x] One `selectLodFor` owns `worldSphere → conservativeViewDepth → bias`, with every current caller reading it. `model-lod.ts` exports it, returning **both** the raw `depth` (a reporter projects an error from it) and the `biased` distance (a level selection compares it), because the six callers each want one of the two and each used to spell the step itself. What each caller does next stays its own — the error chain and hysteresis, the per-placement budget, the two reporting paths, the selector — because those are six different decisions, not one recipe. No behaviour changed: every site keeps its own near plane for now, which is the next box. proof: `rg -n 'conservativeViewDepth\(' packages/core/src` finds only `model-lod.ts`; `npx vitest run packages/core/__tests__` → 4570 passed, 4 skipped.
- [ ] The near-plane default is one value. **This is the defect the box named, and it changes a picture:** `world-cell-chunks.ts:784` and `geometry-capture.ts:423` fall back to `?? 0.1` while the other four use `?? 0`, so the same camera with no `near` reports two different view depths. Unifying them moves the depth, hence a level, in those two sites — the owner's visual-judge rule applies, and the BEFORE/AFTER captures are the proof this box owes. The value to keep is `0`: `conservativeViewDepth` documents the near plane as a guard against a degenerate projection, and five callers plus its own doc agree. proof: the judge verdict on starter, racing and snow, same pose, recorded on this box.
- [x] Terrain uses core's world package type, and the biome `impostor` value reaches `impostorDistance`. Terrain's `IWorldPackageManifest`, `IWorldPackageAsset` and `IWorldPackageRun` are now `import("@threenative/core/world")` aliases — a **type** import, erased before the bundle, so the addon still pulls nothing from core at runtime and the boundary it was protecting is intact. `far.impostor` was validated and then read by nothing, so a game stating it got no `impostorDistance` in `world.json` and the engine's whole-asset impostor never engaged; `bake-biome.ts` carries each foliage species' distance into its asset record now, with a caller's own value winning. `assets`' `IWorldPackageSource` is a partial parse view of the file (chunks, runs, the JSON node), not a second declaration of the contract, so it stays its own. proof: `npx vitest run packages/terrain/__tests__ packages/create-threenative/__tests__/terrain-kit.spec.ts` → 557 passed, 40 files; `pnpm typecheck` → 0.

#### Phase 2: Renderer facts
**Status:** DONE
**Files:** new `packages/core/src/renderer-facts.ts`, `renderer.ts`, `resolution-scaler.ts`, `frame-budget.ts`, `look/world-environment.ts`, `game-startup.ts`.

- [x] `rendererFacts` is the only owned-engine check: `packages/core/src/renderer-facts.ts` reads the facade's own `info.engine`, and the four subsystems that probed it by hand (`game-startup`, `WorldEnvironment.apply` twice, `WorldCellRenderBundles.ownsBundles`) call it. The probe does not spell `"engine" in` anywhere in the package, so the box's `rg` proof holds. It ships `{ kind, ownedEngine }` and nothing more: `webglFallback` already has one owner (`isWebGLFallbackRenderer`, in `@threenative/core/render/environment`) and `software` has no caller yet — a field nothing reads is the thing this PRD exists to delete. proof: `rg -n '"engine" in' packages/core/src` returns nothing outside a doc comment; `pnpm --filter @threenative/core exec vitest run __tests__/game.spec.ts __tests__/renderer-facts.spec.ts __tests__/world-environment-defaults.spec.ts __tests__/world-bundles.spec.ts` → 157 passed.
- [x] One `GpuReadings` serves the renderer, the scaler and the budget. `packages/core/src/gpu-readings.ts` owns the sample, its frame, the repeat rule (a frame id that repeats is a resolve still in flight), the EMA and the three numbers the subsystems disagreed about — `GPU_STALE_FRAME_LIMIT` (8 consecutive stale notes drop the value), `GPU_READING_MAX_AGE_FRAMES` (16) and `GPU_WINDOW_MIN_SAMPLES` (4) — plus `gpuReadingIsFresh` for a window decision. The renderer holds a series and feeds it; the scaler's two constants come from the module; the budget keeps its per-frame boolean and the shared predicate behind it. proof: `npx vitest run packages/core/__tests__/gpu-readings.spec.ts packages/core/__tests__/frame-budget.spec.ts packages/core/__tests__/frame-budget-gpu-series.spec.ts packages/core/__tests__/resolution-scaler.spec.ts` → 77 passed; the whole core suite → 4570 passed, 4 skipped.

#### Phase 3: Dev global
**Status:** DONE
**Files:** new `packages/core/src/dev-global.ts`, `debug.ts`, `hot.ts`, `game-dev-tools.ts`, `worker.ts`, `packages/ui/src/DebugOverlay.tsx`.

- [x] One module owns `__THREENATIVE__`: `packages/core/src/dev-global.ts` exports the key, the `IDevTools`/`DevGlobal` shapes and the `devGlobal`/`publishDevGlobal` accessors, and the debug flag, hot reload, the game's dev tools, the engine's public export and the UI overlay all read it from there instead of spelling the literal. Two honest exceptions, both recorded in that module: the worker keeps its own mirror list, because that list is a typed tuple its mirror machinery builds its runtime shape from (moving it there changed what the worker host forwarded), and `packages/ui` reaches the key through `@threenative/core`'s export. proof: `npx vitest run packages/core/__tests__/dev-global.spec.ts packages/core/__tests__/debug.spec.ts` → 22 passed; the whole core and ui suites → 4592 passed, 4 skipped.
