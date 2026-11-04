# PRD-791 — A biome is a validated data file that the MCP and the game both read

**Status:** NOT STARTED
**Priority:** P1 — The terrain MCP cannot make a sixth biome while biome rules live in 142 world-name branches (all phases open); it gates PRD-792 and PRD-793.
**Complexity:** 5 (MEDIUM); risk override: the five worlds must keep their look, so the owner's visual-judge rule applies
**Owner:** ThreeNative maintainers
**Depends on:** None (coordinates with PRD-790 Phase 1 and PRD-591 AC-4)
**Batch:** [Strata refactoring](README.md)

## Context

- 142 world-name comparisons in `examples/strata-terrain-preview/src/` (`rg -c 'world [!=]==|\.world [!=]=='`):
  `render/pack.ts` 45, `render/terrain.ts` 33, `game.ts` 24, `render/propMaterials.ts` 14,
  `render/scatter.ts` 13, `render/biomes.ts` 8, `render/sky.ts` 5.
- Per-world constants live in code: the `BIOMES` table (`render/biomes.ts`, about lines 173–352),
  `SCATTER` (spruce spacing 4.6, count 3 200), `FAR_FOREST_RULES` (cell 6, reach 2 300, slope
  36–46°), `BENCHMARK[world]`, species lists (`render/pack.ts`, about lines 826–865), spawn points and
  camera offsets (`game.ts`, about lines 689–705 and 1 819), vista flags and sapling heights.
- `IScatterParams` (`packages/terrain/src/core/types.ts`) already describes spacing, height, slope
  and water avoidance. Strata does not use it.
- `packages/terrain/starter/<world>/` already holds `recipe.json`, `surface.json`, `assets.json`,
  `sky.ts` and `world.ts` as copy-out game source.

## Solution

`@threenative/terrain` exports the type `IBiomeSpec` and `validateBiome(spec, name)`. The package
holds the schema and no values. Sections, named after Unreal (see the batch README):

- `landform` (a `LandformKind`), `sizeMeters`, `seed`
- `foliage: IFoliageType[]` (species, asset id, density, slope interval, height interval, spacing,
  collision class `none | trunk | hull`, far-field rule)
- `grass: IGrassType[]` and `layers: ILayerInfo[]` (bands as fractions of the measured height range)
- `water: IWaterBody[]` (`river`, `lake` or `ocean`, with width, depth and footprint limit)
- `spawn` (points and camera offset) and `aliases` (words a request may use)
- `look` (a name the game resolves to its own preset; the package reads no colour)

Values live in `starter/<biome>/biome.json`, beside the other copy-out files. An unknown field, a
missing field or an out-of-range value fails and names the biome and the field.

## Acceptance Criteria

- [ ] AC-1 [local]: A malformed `biome.json` fails validation and names the biome and the field. proof: `pnpm exec vitest run packages/terrain/__tests__/biome-spec.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: The five worlds resolve the same values from `biome.json` as from today's code. proof: `pnpm --filter strata-terrain-preview exec vitest run __tests__/biome-values.spec.ts` — Evidence: pending.
- [ ] AC-3 [local]: The example holds no world-name comparison. proof: `rg -c 'world [!=]==|\.world [!=]==' examples/strata-terrain-preview/src` prints nothing — Evidence: pending.
- [ ] AC-4 [local]: The five worlds keep their look. proof: `capture-strata-worlds` before and after, two runs per arm, fresh judge NEUTRAL or IMPROVEMENT for all five — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Biome data | Strata `game.ts` world load and `scripts/bake.mjs` → `validateBiome` → resolved rows | The `BIOMES`, `SCATTER`, `FAR_FOREST_RULES` and species tables are deleted | AC-2, AC-3 |
| Biome schema | `terrain_generate` (PRD-793) reads the same file | New | PRD-793 AC-1 |

## Decisions

- 2026-11-04 (planning, from the owner's MCP goal): the schema moves into `@threenative/terrain`
  instead of `render/biomes.ts` (PRD-790's first design), so the MCP can validate a biome without the
  example. PRD-790 Phase 1 boxes 1 and 2 are delivered here.

## Execution Phases

#### Phase 1: pin today's values
**Status:** NOT STARTED
**Files:** `examples/strata-terrain-preview/__tests__/biome-values.spec.ts` (new)
- [ ] A spec resolves every per-world value the code holds today (biome rows, scatter, far forest, benchmark pose, species lists, spawn and camera points) for all five worlds and matches a committed table. Green on today's code. proof: `pnpm --filter strata-terrain-preview exec vitest run __tests__/biome-values.spec.ts`

#### Phase 2: schema and five files
**Status:** NOT STARTED
**Files:** `packages/terrain/src/core/biome.ts` (new), `packages/terrain/src/index.ts`, `packages/terrain/starter/*/biome.json` (new), `packages/terrain/__tests__/biome-spec.spec.ts` (new)
- [ ] `IBiomeSpec` and `validateBiome` reject an unknown, missing or out-of-range field with the biome and field name (red with a removed field, green with the full file). proof: `pnpm exec vitest run packages/terrain/__tests__/biome-spec.spec.ts`
- [ ] The Phase 1 spec, pointed at the five `biome.json` files, matches the same table. proof: `biome-values.spec.ts`

#### Phase 3: the example reads the files
**Status:** NOT STARTED
**Files:** `examples/strata-terrain-preview/src/game.ts`, `render/{biomes,pack,terrain,scatter,propMaterials,sky}.ts`
- [ ] 0 world-name comparisons left. proof: the AC-3 `rg` command, plus `pnpm --filter strata-terrain-preview typecheck`
- [ ] The web playtest and the loop playtest stay green. proof: `pnpm --filter strata-terrain-preview test:terrain:web` and `playtests/loop.playtest.json` (`pipelinesSinceReveal` 0)
- [ ] Fresh visual judge NEUTRAL or IMPROVEMENT for the five worlds. proof: AC-4
