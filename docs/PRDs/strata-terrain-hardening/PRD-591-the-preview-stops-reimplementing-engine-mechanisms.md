# PRD-591 — The preview stops re-implementing engine mechanisms

**Status:** NOT STARTED
**Priority:** P2 — A second prop LOD pipeline, a spawn-readiness gate and the scatter loop stay in example code where every terrain game must copy them (AC-1 to AC-4).
**Complexity:** 6 (MEDIUM); risk override: visual output changes, so the owner's visual-judge rule applies
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-585](PRD-585-strata-proof-runs-in-ci.md) (the CI job guards the moves)
**Epic:** [Strata terrain hardening](README.md)

## Context

Example audit of `2d2124792` (2026-10-10), `examples/strata-terrain-preview/src/render/`:

- `props.ts:119, 627, 798-897` hand-writes an LOD ladder (`LOD_BANDS`, `levelFor` with
  hysteresis, `setLevels`, one `InstancedBatch` per variant, level and role). The game path
  (`game.ts:736`) already uses `createStreamedProps` on `WorldCells`; only `editorView.ts:766`
  calls `createProps`. Two prop pipelines exist, and `packages/terrain/__tests__/prop-lod.spec.ts`
  (647 lines) tests the older one.
- `loading.ts:69-193`: `createSpawnReadiness` / `spawnReadinessSnapshot`, a spawn gate every
  streamed terrain game repeats.
- `scatter.ts:299-340`: the rejection-sampling loop and spacing grid repeat for every terrain
  game. Per-biome magic numbers (`treeLimit` 3200/600/55/0, `spruceAttempts: 80000`,
  `scatter.ts:563-568`). It runs synchronously in `enter` (`game.ts:591`), not sliced.
- `terrain.ts` (1191 lines; `createGroundMaterial` about 430) does not use `loadTerrainSplat`,
  which `packages/terrain/starter/forest/world.ts:4, 121` already uses. Height bands are constants
  (`SNOW {145,195}`, `SHORE {7.5,1}`) instead of values measured from the world's height range.
- `propMaterials.ts` (1131) and `pack.ts` (838) each define wind, foliage tint and cutout; `pack.ts:144`
  and `propMaterials.ts:282-310` repeat the wind hash.

Mechanism (pooling, LOD, culling, streaming, readiness) belongs in `packages/core`; appearance
stays in game `src/render/` (root `AGENTS.md`, "Where a change goes").

## Solution

The editor view uses the streamed prop path; delete the ladder and its spec. Move spawn readiness
into `WorldCells` as `whenSpawnReady(position)`. Ship a generic `scatter(rules)` in
`@threenative/terrain` and keep rules in game source; run it in the bake, not in `enter`. Compare
the hand-written ground against `loadTerrainSplat` under the visual judge and keep the plumbing
from the engine. Derive height bands from the measured height range. One `foliageSurface()` for
both material paths.

## Acceptance Criteria

- [ ] AC-1 [local]: The editor draws props through the streamed path, and `levelFor`/`setLevels` are deleted. proof: `pnpm --filter strata-terrain-preview test:terrain:editor` plus `count-loc.ts` — Evidence: pending.
- [ ] AC-2 [local]: `WorldCells.whenSpawnReady` gates the preview's spawn, and the example's readiness module is deleted. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-data.spec.ts` plus `test:terrain:web` — Evidence: pending.
- [ ] AC-3 [local]: Scatter runs in the bake, and `enter` does no scatter work. proof: `test:terrain:web` asserting no long task over 50 ms during `enter` — Evidence: pending.
- [ ] AC-4 [local]: Ground plumbing uses `loadTerrainSplat`, and height bands come from the world's measured range. proof: `test:terrain:web` — Evidence: pending.
- [ ] AC-5 [local]: A fresh visual judge rates the before/after captures of all five kits NEUTRAL or IMPROVEMENT (same pose, headed WebGPU, two runs per arm). proof: judge verdict and images on the PR — Evidence: pending.

## Execution Phases

#### Phase 1: one prop pipeline
**Status:** NOT STARTED
- [ ] Ladder deleted; editor on streamed props. proof: editor script + count-loc

#### Phase 2: readiness and scatter
**Status:** NOT STARTED
- [ ] Spawn readiness in `WorldCells`. proof: spec + web playtest
- [ ] Scatter off the `enter` path. proof: web playtest long-task assertion

#### Phase 3: ground and look check
**Status:** NOT STARTED
- [ ] Engine splat plumbing, measured bands. proof: web playtest
- [ ] Visual judge passes. proof: judge verdict on the PR
