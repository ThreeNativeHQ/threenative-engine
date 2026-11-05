# PRD-799 — `world-cells.ts` second split

**Status:** NOT STARTED
**Priority:** P2 — `WorldCells` is back at 2 977 lines with a 450-line constructor and an LOD-bias controller that no spec pins (all phases open).
**Complexity:** 5 (MEDIUM); risk override: complex async state
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-595](../../strata-terrain-hardening/PRD-595-world-cells-splits-by-seam-and-survives-a-race-fuzz.md) AC-3 (walk playtests after the first split). Start after the forest lane commits its open edits to `world-cells.ts` and `world-cell-data.ts`.
**Batch:** [Strata refactoring](README.md)

## Context

Read-only audit, 2026-11-04:

- `packages/core/src/world-cells.ts` is 2 977 lines; PRD-595 took it from 10 228 to 2 444 on 2026-10-11 and it has grown since. Sections: options and launch flags (103–410), fields, constructor and `static load` (413–1 233, constructor about 450 lines), `update` and adaptive LOD bias (1 318–1 690), readiness and spawn wait (1 797–2 083), residency, admission and build queue (2 083–2 417), placement build, stale and evict (2 417–2 977).
- Type-only cycles with `world-cell-chunks`, `-impostors`, `-prewarm` and `-data` through `IAssetState`, which `world-cell-models.ts` defines and `world-cells.ts` re-exports.
- About 27 specs reach it through `world.js`, including `world-cells-race.spec.ts` (1 000 seeds). No spec names `#adaptLodBias` behaviour, `terrainReadinessInView`, `LOD_BIAS_MARKER`, `validateGpuFrame` or `enableGpuSceneTally`.
- Unreal names: `UWorldPartitionRuntimeCell` (`UE 5.8.3: Engine/Source/Runtime/Engine/Public/WorldPartition/WorldPartitionRuntimeCell.h:236`), `FWorldPartitionStreamingSource` (`WorldPartitionStreamingSource.h:341`).

## Solution

Pin the unpinned behaviour, then extract in order: `world-cell-options.ts`,
`world-cell-lod-bias.ts`, `world-cell-readiness.ts`, `world-cell-residency.ts`,
`world-cell-placements.ts`. Each collaborator owns its state behind a host interface of at most 20
members, as PRD-595 did. The four type-only cycles go by importing `IAssetState` from
`world-cell-models.ts` directly.

## Acceptance Criteria

- [ ] AC-1 [local]: `world-cells.ts` is under 1 500 lines, no new file exceeds 1 500, and no existing spec changes. proof: `wc -l` and `git diff --stat packages/core/__tests__/` — Evidence: pending.
- [ ] AC-2 [local]: The world suite and the 1 000-seed race fuzz stay green. proof: `pnpm exec vitest run packages/core/__tests__/world-*.spec.ts` — Evidence: pending.
- [ ] AC-3 [local]: Strata and the abyss world stream as before. proof: `pnpm --filter strata-terrain-preview test:terrain:web` and `phase477-world-streaming.desktop.playtest.json` — Evidence: pending.

## Integration Ledger

Integration: unchanged — `world.ts` exports `WorldCells` and its types as before.

## Execution Phases

#### Phase 1: pin
**Status:** NOT STARTED
**Files:** `packages/core/__tests__/world-cells-lod-bias.spec.ts` (new), `packages/core/__tests__/world-cells-options.spec.ts` (new)
- [ ] LOD bias: over-budget frame times raise the bias by `LOD_BIAS_RISE`, it decays toward 1 and stays within its bounds. Green on today's code. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-lod-bias.spec.ts`
  - Not started. What the pin needs, measured so the next lane does not rediscover it: the loop is `#adaptLodBias(renderer)` inside `update`, and it is fully observable — `lodBias()` and `setLodBias()` are exported from `src/model-lod.ts`, the clock is injectable as `admissionNow`, and the renderer surface it reads is `gpuMainMs()` plus `targetFps()`. The gate that a fresh world has to clear first is `#biasOverBudget`'s prewarm check (`#prewarm.queued > 0 || #prewarm.owed > #prewarm.drawn` holds the rise while the ring is still warming), so the spec must drive the ring to drained over the committed `__tests__/fixtures/world-v1` package (the `makeWorld`/`drain` pattern in `world-cells-admission.spec.ts`) before stepping the clock. The step is `LOD_BIAS_STEP_SECONDS` 0.5 s, rise 1.08, decay 0.95, band `[1, 2.5]`, and a rise needs `gpuMs > mainGpuShare × frameMs` while a decay needs `< 0.6 ×` it.
- [ ] Options: launch flag, URL parameter and global resolve in order; `terrainReadinessInView` answers for a cell in and out of view. Green on today's code. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-options.spec.ts`
  - Not started. The launch-flag readers that are pure functions already have a home and a spec — `world-gpu-flags.spec.ts`, pinned under PRD-798 Phase 1, covers `gpuSceneRequested`, `bundlesAsked`/`bundlesRequested`, `shadowGpuKeysRequested`, `lodFromFollowRequested` and `gpuSceneValidationRequested` including their resolution order. What is left for THIS box is the two instance-scoped answers: `terrainReadinessInView(camera)` (needs a loaded ring and a `Frustum`) and the option resolution `WorldCells.load` does on top of those flags, which needs the same `world-v1` fixture.

#### Phase 2: extract
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cell-{options,lod-bias,readiness,residency,placements}.ts` (new), `world-cells.ts`, `world-cell-{chunks,impostors,prewarm,data}.ts` (import fix)
- [ ] Five modules extracted; type cycles gone. proof: AC-1 and AC-2

#### Phase 3: prove the games
**Status:** NOT STARTED
**Files:** none
- [ ] Strata and abyss playtests green. proof: AC-3
