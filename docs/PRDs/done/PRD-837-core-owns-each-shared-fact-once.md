# PRD-837 — Core owns each shared fact once

**Status:** DONE — all three phases landed, AC-2 is green (4607 core tests) and the AC-1 and near-plane visual judges returned NEUTRAL (2026-11-08).
**Priority:** P2 — the boxes are landed but for one; what is open is the before/after visual judge on the near-plane value and on the strata forest/abyss pair, so the tier rates that verification rather than a copy count.
**Complexity:** 6 (MEDIUM); risk override: LOD selection and the renderer facts decide what is drawn, so the owner's visual-judge rule applies to Phases 1 and 2
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](../refactoring/untangle-2026-11-06/README.md) — R5

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

- [x] AC-1 [local]: Strata forest and the abyss example load and draw, and the visual judge returns NEUTRAL or better. proof: `capture-strata-worlds` forest plus the abyss scenario, with the judge verdict on this box. Judge 2026-11-08 (fresh read-only Opus subagent, `judge-632`): BEFORE `b48c653c1` (origin/develop) vs AFTER `5bd45931a` (this PR), headed WebGPU on NVIDIA turing (RTX 2080) for all 44 images, 2 runs per arm, BEFORE/AFTER burned in; images and `manifest.md` in `~/Downloads/pr632-visual-judge/`. Criteria set before judging: no visible change in exposure, colour, sky and environment light, shadows, LOD and geometry presence, fog or sharpness beyond the same-arm run-to-run noise. Verdict: **NEUTRAL, PASS**. Strata forest (`capture-strata-worlds`, four poses) reports `loaded=true`, `errors=[]` on all four runs and draws the distant tree carpet, lake, mountains and haze on both arms, inside the noise; the player pose moves per run, so it was judged by eye. The abyss world (`phase477-world-capture`, three poses) is byte-identical across all four runs. Caveat recorded, not hidden: the abyss title card reads about 1% darker on AFTER (mean 0.1123 vs 0.1113, about 0.3 of an 8-bit level, uniform), cross-arm RMSE 0.017-0.024 against a 0.017-0.018 noise, invisible by eye, with unseeded particles and two runs, so it is not attributed. The local-only licensed Strata assets are absent, so both arms draw the procedural fallback.
- [x] AC-2 [local]: Affected core tests stay green. proof: `npx vitest run packages/core/__tests__` (the root vitest project, which is what `pnpm --filter @threenative/core test` delegates to `publint` for) → **4607 passed, 4 skipped, 321 files**, including the four areas this PRD touched (`renderer-facts.spec.ts`, `gpu-readings.spec.ts`, `lod-near-plane.spec.ts`, and the dev-global constraint). `pnpm --filter @threenative/core test` itself runs `publint --strict` only → `All good!`.

## Decisions

- **The logical asset load is out of this PRD** (2026-11-07). The Context row and the Solution promise "a `loadLogical` exported from the core world subpath, and a report when `WorldCells` is built without `assets`", but no box carries it and no code does it. It is a behaviour change for every game that streams a world without an asset pipeline, so it needs its own red-green pass and its own proof rather than a line in this PRD's Solution. Filed here so it is not lost.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| LOD pick | `WorldTiles`, `WorldCells`, `InstancedBatchLod`, `ModelLod` update | 5 inline recipes deleted | Phase 1 |
| World package read | `WorldCells.load`, terrain bake | Terrain manifest copy deleted | Phase 1 |
| Backend facts | `Game` startup, `WorldEnvironment.apply`, template `src/render/` | Ad hoc checks deleted | Phase 2 |

## Execution Phases

#### Phase 1: World facts
**Status:** DONE
**Files:** `model-lod.ts`, `instanced-batch-lod.ts`, `world-tiles.ts`, `world-cell-chunks.ts`, `world-package.ts`, `packages/terrain/src/core/world-package.ts`, `packages/assets/src/world/proxy.ts`.

The LOD recipe is two claims, because one of them changes what is drawn and the other does not:

- [x] One `selectLodFor` owns `worldSphere → conservativeViewDepth → bias`, with every current caller reading it. `model-lod.ts` exports it, returning **both** the raw `depth` (a reporter projects an error from it) and the `biased` distance (a level selection compares it), because the six callers each want one of the two and each used to spell the step itself. What each caller does next stays its own — the error chain and hysteresis, the per-placement budget, the two reporting paths, the selector — because those are six different decisions, not one recipe. No behaviour changed: every site keeps its own near plane for now, which is the next box. Known gap: no spec pins terrain’s raw-depth choice — the branch matches the base at that site, so nothing moved, but `selectLodFor` returns `biased` beside `depth` and the mistake is easy to repeat. proof: `rg -n 'conservativeViewDepth\(' packages/core/src` finds only `model-lod.ts`; `npx vitest run packages/core/__tests__` → 4570 passed, 4 skipped.
- [x] Terrain uses core's world package type, and the biome `impostor` value reaches `impostorDistance`. Terrain's `IWorldPackageManifest`, `IWorldPackageAsset` and `IWorldPackageRun` are `import("@threenative/core/world")` type aliases — erased before the bundle, so the "no core import" boundary was never at risk — and the bake refuses a stated distance that is not positive or not beyond every authored LOD gate, naming the species, rather than letting core reject it at load. proof: `npx vitest run packages/terrain/__tests__/impostor-distance.spec.ts` → 4 passed.

- [x] The near-plane default is one value. **The code is landed**: `LOD_NEAR_PLANE = 0` is exported by `model-lod.ts`, `world-cell-chunks.ts` and `geometry-capture.ts` take it instead of their `?? 0.1`, and `lod-near-plane.spec.ts` pins the value, fails on any caller that reintroduces a private default, and pins the one behaviour change — a sphere ten centimetres ahead is no longer `degenerate`. **The judge is open**: the reach is a camera object with **no** `near` — every three.js camera has one (0.1 by default), so the starter, racing and snow poses should judge NEUTRAL by construction — and the verdict below closes it. proof: `npx vitest run packages/core/__tests__` → 4573 passed, 4 skipped; the box closes with the verdict recorded here. Judge 2026-11-08 (fresh read-only Opus subagent, `judge-632`): BEFORE `b48c653c1` (origin/develop) vs AFTER `5bd45931a` (this PR), headed WebGPU on NVIDIA turing (RTX 2080) for all 44 images, 2 runs per arm, BEFORE/AFTER burned in; images and `manifest.md` in `~/Downloads/pr632-visual-judge/`. Criteria set before judging: no visible change in exposure, colour, sky and environment light, shadows, LOD and geometry presence, fog or sharpness beyond the same-arm run-to-run noise. Verdict on starter, racing and snow: **NEUTRAL, PASS** — no clipping, missing geometry or depth artefacts; every BEFORE/AFTER difference is inside the run-to-run noise.

#### Phase 2: Renderer facts
**Status:** DONE
**Files:** new `packages/core/src/renderer-facts.ts`, `renderer.ts`, `resolution-scaler.ts`, `frame-budget.ts`, `look/world-environment.ts`, `game-startup.ts`.

- [x] `rendererFacts` is the only owned-engine check: `packages/core/src/renderer-facts.ts` reads the facade's own `info.engine`, and the four subsystems that probed it by hand (`game-startup`, `WorldEnvironment.apply` twice, `WorldCellRenderBundles.ownsBundles`) call it. The probe does not spell `"engine" in` anywhere in the package, so the box's `rg` proof holds. It ships `{ kind, ownedEngine }` and nothing more: `webglFallback` already has one owner (`isWebGLFallbackRenderer`, in `@threenative/core/render/environment`) and `software` has no caller yet — a field nothing reads is the thing this PRD exists to delete. proof: `rg -n '"engine" in' packages/core/src` returns nothing outside a doc comment; `pnpm --filter @threenative/core exec vitest run __tests__/game.spec.ts __tests__/renderer-facts.spec.ts __tests__/world-environment-defaults.spec.ts __tests__/world-bundles.spec.ts` → 157 passed.
- [x] One `GpuReadings` owns the GPU series. `packages/core/src/gpu-readings.ts` owns the sample, its frame, the repeat rule (a frame id that repeats is a resolve still in flight), the EMA and the three numbers the subsystems disagreed about — `GPU_STALE_FRAME_LIMIT` (8), `GPU_READING_MAX_AGE_FRAMES` (16) and `GPU_WINDOW_MIN_SAMPLES` (4). The renderer holds a series and feeds it, and the scaler takes its two constants from it; the budget keeps its own per-frame boolean and the scaler keeps its age check inline, because each rejects an unknown where the series treats one as fresh — that difference is stated in the module rather than papered over. proof: `npx vitest run packages/core/__tests__/gpu-readings.spec.ts packages/core/__tests__/frame-budget.spec.ts packages/core/__tests__/frame-budget-gpu-series.spec.ts packages/core/__tests__/resolution-scaler.spec.ts` → 77 passed; the whole core suite → 4570 passed, 4 skipped.

#### Phase 3: Dev global
**Status:** DONE
**Files:** new `packages/core/src/dev-global.ts`, `debug.ts`, `hot.ts`, `game-dev-tools.ts`, `worker.ts`, `packages/ui/src/DebugOverlay.tsx`.

- [x] One module owns `__THREENATIVE__`: `packages/core/src/dev-global.ts` exports the key, the `IDevTools`/`DevGlobal` shapes and the `devGlobal`/`publishDevGlobal` accessors, and the debug flag, hot reload, the game's dev tools, the engine's public export and the UI overlay all read it from there instead of spelling the literal. Two honest exceptions, both recorded in that module: the worker keeps its own mirror list, because that list is a typed tuple its mirror machinery builds its runtime shape from (moving it there changed what the worker host forwarded), and `packages/ui` reaches the key through `@threenative/core`'s export. proof: `npx vitest run packages/core/__tests__/dev-global.spec.ts packages/core/__tests__/debug.spec.ts` → 22 passed; the whole core and ui suites → 4592 passed, 4 skipped. One exception, found by `check-core-boundary` on a built scaffold: the debug overlay may not import the key, because a static reference from `packages/ui` keeps core's `dev-global` — and `__THREENATIVE__` with it — in every game's production chunk. The overlay keeps a stripped local copy and `packages/ui/__tests__/debug-overlay-key.spec.ts` pins it to `DEV_GLOBAL_KEY`, so a rename in core fails a test instead of leaving the overlay reading nothing.
