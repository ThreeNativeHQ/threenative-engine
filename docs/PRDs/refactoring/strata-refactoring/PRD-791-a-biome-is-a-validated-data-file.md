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

Values live in `starter/<biome>/biome.data.json`, beside the other copy-out files. An unknown field, a
missing field or an out-of-range value fails and names the biome and the field.

## Acceptance Criteria

- [x] AC-1 [local]: A malformed `biome.data.json` fails validation and names the biome and the field. proof: `pnpm exec vitest run packages/terrain/__tests__/biome-spec.spec.ts` — Evidence: 6/6 pass; with `seed` removed from `alpine/biome.data.json` the run fails `TypeError: alpine: biome field 'seed' is missing.`, and passes again with the file restored. Intervals and the nullable fields are range-checked, not just parsed: a `null` height is a value while `"8"`, `[0]` and an object are refused, `[0, -5]` is below the floor, `[52, 0]`, `[6.4, 3.2]` and `[32, 0]` must ascend, a slope must stay within 0-90, a spacing and a river width must be greater than 0, a band must end above where it starts, and snow must shed from a gentler slope than it sheds to. Removing those three rules from `validateBiome` turns 2 of the 6 tests red (`desert's malformed file was accepted`).
- [x] AC-2 [local]: The five worlds resolve the same values from `biome.data.json` as from today's code. proof: `pnpm --filter strata-terrain-preview exec vitest run --config vitest.config.ts __tests__/biome-values.spec.ts` — Evidence: 3/3 pass; the same committed table is asserted twice, once against today's code (`BIOMES`, `scatterRules`, `FAR_FOREST_RULES`, `BENCHMARK`, `speciesFor`, `SPAWN_POINTS`, the baked worlds) and once against the five validated files; changing `density: 3200` to `3201` in the table fails the run.
- [ ] AC-3 [local]: The example holds no world-name comparison. proof: `rg -c 'world [!=]==|\.world [!=]==' examples/strata-terrain-preview/src` prints nothing — Evidence: partial. `render/sky.ts` prints nothing; six files still do, 128 comparisons in total: pack 45, terrain 33, game 18, propMaterials 14, scatter 10, biomes 8.
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
- 2026-11-04: the file is `biome.data.json`, not `biome.json`. Biome 1.9.4 parses every file of that
  name as its own project config and fails `pnpm lint`; `packages/create-threenative/template-assets/quality/biome.json`
  is a real nested config, and every scaffolded project gets one at its root. The schema and the API
  keep their names (IBiomeSpec, validateBiome).

## Execution Phases

#### Phase 1: pin today's values
**Status:** DONE
**Files:** `examples/strata-terrain-preview/__tests__/biome-values.spec.ts` (new)
- [x] A spec resolves every per-world value the code holds today (biome rows, scatter, far forest, benchmark pose, species lists, spawn and camera points) for all five worlds and matches a committed table. Green on today's code. proof: `pnpm --filter strata-terrain-preview exec vitest run --config vitest.config.ts __tests__/biome-values.spec.ts` — 2/2 pass before Phase 2 added a second describe. Five pure extractions made the unreachable values reachable, each a rename-and-move: `scatterRules` (`scatter.ts`: the per-world ternaries and their literals), `speciesFor` (`pack.ts`: the inline `loadPack` species filter), `SPAWN_POINTS`/`SPAWN_CAMERA_OFFSET` (`worldData.ts` (new), from the two `game.ts` spawn ternaries), `FAR_FOREST_WORLDS` (`farForest.ts`: the `game.ts` gate), and `export` on `pack.ts`'s `STONE` and `IPackSpecies`. `landform` is pinned from `LANDFORMS[kind].reference` naming that world's DEM crop; collision class from the roles of `buildPropVariants()`'s parts, which is the rule `game.ts` collides with. `aliases` is the one row no code exports: the biome file is its only owner (asserted in the Phase 2 describe), and the MCP's inline synonym table hands it over in PRD-793. The pin bites: `density: 3200` changed to `3201` fails the run.

#### Phase 2: schema and five files
**Status:** DONE
**Files:** `packages/terrain/src/core/biome.ts` (new), `packages/terrain/src/index.ts`, `packages/terrain/starter/*/biome.data.json` (new), `packages/terrain/__tests__/biome-spec.spec.ts` (new)
- [x] `IBiomeSpec` and `validateBiome` reject an unknown, missing or out-of-range field with the biome and field name (red with a removed field, green with the full file). proof: `pnpm exec vitest run packages/terrain/__tests__/biome-spec.spec.ts` — 6/6 pass; with `seed` removed from `alpine/biome.data.json` the run fails `TypeError: alpine: biome field 'seed' is missing.` and passes with the file restored. `validateBiome` carries `@requires npm i @threenative/terrain`, like every other catalogue entry in this package, so the capability manifest can install it from a scaffolded project.
- [x] The Phase 1 spec, pointed at the five `biome.data.json` files, matches the same table. proof: `biome-values.spec.ts` — 3/3 pass; the file describe reads each file through `validateBiome` and asserts the same `TABLE` rows Phase 1 asserts against the code.

#### Phase 3: the example reads the files
**Status:** OPEN — one of the six files done (`render/sky.ts`, 0 comparisons); the rest are listed in the box below.
**Files:** `examples/strata-terrain-preview/src/game.ts`, `render/{biomes,pack,terrain,scatter,propMaterials,sky}.ts`
- [ ] 0 world-name comparisons left. proof: the AC-3 `rg` command, plus `pnpm --filter strata-terrain-preview typecheck`
  - `render/sky.ts` is at 0: its five comparisons became six named fields on the look preset (`softShadowFilter`, `shadowMapSize`, `tightShadowContacts`, `shadowRefreshStep`, `temporalAA`, `waterProof`), same values, `outdoor-shadows.spec.ts` and `typecheck` green.
  - Left, by count (`rg -c` after Phase 1's extractions): `render/pack.ts` 45, `render/terrain.ts` 33, `game.ts` 18, `render/propMaterials.ts` 14, `render/scatter.ts` 10, `render/biomes.ts` 8. Not started: each needs its per-world branches replaced by named fields read from `biome.data.json`, and `game.ts` first needs the file loaded in the browser and its rows passed into `loadPack`/`createTerrain`/`createOutdoorSky`.
- [ ] The web playtest and the loop playtest stay green. proof: `pnpm --filter strata-terrain-preview test:terrain:web` and `playtests/loop.playtest.json` (`pipelinesSinceReveal` 0)
- [ ] Fresh visual judge NEUTRAL or IMPROVEMENT for the five worlds. proof: AC-4
