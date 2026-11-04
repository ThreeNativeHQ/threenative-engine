# PRD-792 — One bake for every biome

**Status:** NOT STARTED
**Priority:** P1 — The MCP cannot bake a new biome while the scatter rules and the world-package compiler live only in the example (all phases open); it gates PRD-793.
**Complexity:** 6 (MEDIUM); risk override: placements change what reaches the screen, so the owner's visual-judge rule applies
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-791](PRD-791-a-biome-is-a-validated-data-file.md)
**Batch:** [Strata refactoring](README.md)

## Context

- `examples/strata-terrain-preview/scripts/bake.mjs` is 655 lines. Each `packages/terrain/starter/*/bake.mjs` is 6 to 8 lines and calls the package. The example bake is the only path that knows the Strata scatter rules.
- `render/propStreaming.ts` (504) and `render/placements.ts` (172) compile placement records at runtime. They duplicate `bakeWorldPackage`, `placementCells` and `writePlacementRecord` in `packages/terrain/src/core/world-package.ts`.
- `render/scatter.ts` (836) and `render/farForest.ts` (264) hold scatter rules as code: noise masks, slope fades, clearings, a far-field rule. `IScatterParams` covers only spacing, height, slope and water avoidance.
- `preparePose` in `render/props.ts` re-derives core `GroundSnap`; the example uses three's `ImprovedNoise` while core/world exports `bakedNoise` and `bakedFractalNoise`.
- Existing pins: `placements.spec.ts`, `propStreaming.spec.ts`, `prop-streaming.spec.ts`, `far-forest.spec.ts` (example); `scatter-identity.spec.ts`, `world-package.spec.ts`, `kit-bake.spec.ts` (terrain).

## Solution

`bakeBiome(spec, options)` in `@threenative/terrain` runs landform, erosion, layers and scatter, then
`bakeWorldPackage`. Scatter runs as four stages named after the Unreal PCG elements:
`surfaceSample`, `densityFilter`, `selfPrune`, `meshSpawn`. Each `IFoliageType` row from PRD-791
drives them; noise masks, slope fades, clearings and the far-field rule become row fields.
`layerWeights(layers, height, slope)` replaces `biomeWeights` and `elevationBand` on the CPU side
(the TSL twin stays in the game), and `measureBiome` uses the package's `terrainStats`. The
game passes its grounding callback and LOD bands as policy. The example's `bake.mjs` becomes a call,
and the runtime compiler in `propStreaming.ts` and `placements.ts` is deleted because the game loads
the baked package.

## Acceptance Criteria

- [ ] AC-1 [local]: `bakeBiome` reproduces today's five worlds byte for byte, or each difference is named and judged. proof: `bake-golden.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: The example holds no scatter rule and no runtime package compiler. proof: `render/propStreaming.ts` and `render/placements.ts` deleted, `scripts/bake.mjs` under 150 lines (`wc -l`) — Evidence: pending.
- [ ] AC-3 [local]: The five worlds keep their look. proof: `capture-strata-worlds` before and after, two runs per arm, fresh judge NEUTRAL or IMPROVEMENT — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Biome bake | `pnpm --filter strata-terrain-preview bake` → `bakeBiome` | Example `scripts/bake.mjs` body, `render/scatter.ts` rules, `render/farForest.ts` rules: deleted | AC-1, AC-2 |
| Prop package | Game load → baked package → `WorldCells.load` | `render/propStreaming.ts`, `render/placements.ts`: deleted | AC-2 |

## Execution Phases

#### Phase 1: pin the bake
**Status:** NOT STARTED
**Files:** `examples/strata-terrain-preview/__tests__/bake-golden.spec.ts` (new)
- [ ] Two seeded bakes of each world give the same digest (placement count per species, placement hash, height hash, manifest hash). proof: `pnpm --filter strata-terrain-preview exec vitest run __tests__/bake-golden.spec.ts`
- [ ] The digests of today's bake are committed, and the spec matches them. proof: same spec

#### Phase 2: fold into the package
**Status:** NOT STARTED
**Files:** `packages/terrain/src/core/{bake-biome,scatter-stages}.ts` (new), `packages/terrain/src/core/types.ts`, `examples/strata-terrain-preview/scripts/bake.mjs`, `render/{scatter,farForest,propStreaming,placements,props}.ts`
- [ ] `bakeBiome` with the four scatter stages matches the Phase 1 digests. proof: `bake-golden.spec.ts` plus `pnpm exec vitest run packages/terrain/__tests__/scatter-identity.spec.ts packages/terrain/__tests__/world-package.spec.ts`
- [ ] Example compiler and rules deleted. proof: AC-2

#### Phase 3: prove the game
**Status:** NOT STARTED
**Files:** none
- [ ] The web playtest and the loop playtest stay green. proof: `pnpm --filter strata-terrain-preview test:terrain:web` and `playtests/loop.playtest.json`
- [ ] Fresh visual judge passes. proof: AC-3
