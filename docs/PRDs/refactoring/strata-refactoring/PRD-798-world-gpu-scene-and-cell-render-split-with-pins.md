# PRD-798 — `world-gpu-scene.ts` and `world-cell-render.ts` split, and `CellRender` gets unit pins

**Status:** NOT STARTED
**Priority:** P2 — `CellRender` (2 875 lines, about 97 members) has no direct unit test, and `world-gpu-scene.ts` (2 895 lines) holds a cycle with its validation module (all phases open).
**Complexity:** 5 (MEDIUM); risk override: both files decide what the world draws and casts, so the owner's visual-judge rule applies
**Owner:** ThreeNative maintainers
**Depends on:** None. Start after the forest lane commits its open edits to both files (`git status` on 2026-11-04 shows them modified).
**Batch:** [Strata refactoring](README.md)

## Context

Read-only audit, 2026-11-04:

- **`world-gpu-scene.ts` (2 895).** Types and layout constants (28–400), the CPU reference kernel (401–720), report types and frustum helpers (721–905), env and URL flag readers (905–1 068), then `WorldGpuScene` (about 58 members): buffers and regions, dispatch, validation readback (1 850–2 340), buffer growth, main kernel, shadow keys and kernel (2 671–2 895). It and `world-gpu-validation.ts` import each other. Pinned by `world-gpu-scene.spec.ts` (5 147 lines), `world-shadow-gpu-keys`, `world-impostors`, `depth-pyramid`. No spec names the flag readers (`gpuSceneRequested`, `bundlesAsked`, `shadowGpuKeysRequested`, `gpuSceneValidationRequested`).
- **`world-cell-render.ts` (2 875).** Pure helpers (1–358), then `CellRender`: main-pass cull (626–830), swap tracking (840–1 000), shadow claims and keys (997–1 500), batch factories (1 314–1 730), bundles (1 864–2 070), GPU adopt and dress (2 092–2 530), retire (2 536–2 680). Its only importer is `world-cells.ts`. No spec imports `CellRender`; `cullResident`, `tellShadows`, `claimCaster`, `bundleOut`, `seedGpuKeys`, `retireWideKeys`, `drainShared` and `mainShard` are covered only through `WorldCells` integration specs.
- `world-cell-render.ts:176` and `:186` repeat the virtual-shadow layer numbers 26 and 25 by hand (PRD-802 makes them one export).
- Unreal names: `FGPUScene` (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/GPUScene.h:218`), `FInstanceCullingContext` (`Engine/Source/Runtime/Renderer/Public/InstanceCulling/InstanceCullingContext.h:75`).

## Solution

Pin first, then move leaves. `world-gpu-types.ts` takes the shared types, which removes the cycle;
then `world-gpu-flags.ts`, `world-gpu-reference.ts`, `world-gpu-shadow.ts` and
`world-gpu-readback.ts`. For `CellRender`: `world-cell-render-util.ts`, `world-cell-main-cull.ts`,
`world-cell-shadow-claims.ts`, `world-cell-bundles.ts`, `world-cell-gpu-dress.ts`, each behind the
existing host-interface pattern (`ICellRenderHost`). Both classes stay as facades.

## Acceptance Criteria

- [ ] AC-1 [local]: No resulting file exceeds 1 500 lines and no existing world spec changes. proof: `wc -l` and `git diff --stat packages/core/__tests__/` showing only new spec files — Evidence: pending.
- [ ] AC-2 [local]: The world suite stays green, including the 1 000-seed race fuzz. proof: `pnpm exec vitest run packages/core/__tests__/world-*.spec.ts` — Evidence: pending.
- [ ] AC-3 [local]: Strata and the abyss world stream and draw as before. proof: `pnpm --filter strata-terrain-preview test:terrain:web` and `examples/abyss-framework/playtests/phase477-world-streaming*.playtest.json` — Evidence: pending.
- [ ] AC-4 [local]: The forest keeps its look and shadows. proof: `capture-strata-worlds --worlds forest` before and after, two runs per arm, fresh judge NEUTRAL or IMPROVEMENT — Evidence: pending.

## Integration Ledger

Integration: unchanged — `WorldCells` stays the only consumer of `CellRender`, and `world.ts` exports are unchanged.

## Execution Phases

#### Phase 1: pin
**Status:** NOT STARTED
**Files:** `packages/core/__tests__/world-cell-render.spec.ts` (new), `packages/core/__tests__/world-gpu-flags.spec.ts` (new)
- [ ] `CellRender` unit pins against a stub host: `mainShard` is stable and in [0, 32); main cull keeps and drops the expected keys; a shadow claim and its retire leave no claim; a bundle out and back restores the draw list. Green on today's code. proof: `pnpm exec vitest run packages/core/__tests__/world-cell-render.spec.ts`
- [ ] Flag readers: URL parameter, global and default resolve in the documented order for each flag. Green on today's code. proof: `pnpm exec vitest run packages/core/__tests__/world-gpu-flags.spec.ts`

#### Phase 2: split `world-gpu-scene.ts`
**Status:** NOT STARTED
**Files:** `packages/core/src/world-gpu-{types,flags,reference,shadow,readback}.ts` (new), `world-gpu-scene.ts`, `world-gpu-validation.ts`
- [ ] Five modules extracted, cycle gone. proof: AC-1 and AC-2 for this file

#### Phase 3: split `world-cell-render.ts`
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cell-{render-util,main-cull,shadow-claims,bundles,gpu-dress}.ts` (new), `world-cell-render.ts`
- [ ] Five modules extracted. proof: AC-1 and AC-2 for this file
- [ ] Strata, abyss and the judge pass. proof: AC-3 and AC-4
