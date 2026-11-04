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
- [x] AC-3 [local]: The example holds no world-name comparison. proof: `rg -c 'world [!=]==|\.world [!=]==' examples/strata-terrain-preview/src` prints nothing — Evidence: it prints nothing (exit 1, no match) across all 128 comparisons, `game.ts`'s last 18 included, and `pnpm --filter strata-terrain-preview typecheck` exits 0. The last 18 became values, not labels: `bake` (the bundle file and its key) in the biome file, `vistaAim` (metres the pinned camera looks along x/z, and its rise) on the look, `saplingHeight`, `stoneSinkShare`, `stoneScans`, `riverMirrorsPonds`, `stageArm`, and the deletion of `limitToFootprint` from `createRivers`/`createLakes`/`waterSurfaceAt`/`waterCurrentAt`/`ribbon` (every water-bearing biome is footprint-limited, so the flag and its false branch were dead). Byte-identical proof that no placement moved: the five worlds' `*.placements.bin` and `baked.json` rebaked from this tree `cmp` equal to the same bake from `HEAD` (213 140 forest, 144 192 coastal, 3 598 alpine, 3 554 desert, 40 459 tundra placements).
- [ ] AC-4 [local]: The five worlds keep their look. proof: `capture-strata-worlds` before and after, two runs per arm, fresh judge NEUTRAL or IMPROVEMENT for all five — Evidence: NOT RUN by the refactor lane; the browser/visual-judge lanes are the owner's. No value in this phase changes what reaches the screen, and one candidate change was withdrawn on evidence: `temperate.stoneTint` carries `[0.44, 0.46, 0.42]`, the only value that ever reached a pixel for the forest and the coast (see Decisions, 2026-11-05). Byte-identical placements are not a look proof and are not offered as one.

- 2026-11-05: `temperate.stoneTint` keeps `[0.44, 0.46, 0.42]`, and the `[0.48, 0.44, 0.39]` that
  stood in that field on HEAD is deleted. On HEAD, `terrain.ts:321` (`stoneColor`) and
  `terrain.ts:765` (the ground massif) both read
  `otherBiome ? biome.stoneTint : [0.44, 0.46, 0.42]`, and `propMaterials.ts:1136`'s reader sits
  inside `if (biome && biome.world !== "forest" && biome.world !== "coastal")`: for the forest and
  the coast every stone path took the literal, so `[0.48, 0.44, 0.39]` was unreachable on those
  two worlds. Once the split reads the field unconditionally, the field has to carry the value that
  actually reached the screen, or the refactor would have changed the look it is supposed to move.
  An instruction to revert it was withdrawn on this evidence rather than followed into an unjudged
  appearance change.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Biome data | Strata `game.ts` world load and `scripts/bake.mjs` → `validateBiome` → resolved rows | The `BIOMES`, `SCATTER`, `FAR_FOREST_RULES` and species tables are deleted | AC-2, AC-3 |
| Biome schema | `terrain_generate` (PRD-793) reads the same file | New | PRD-793 AC-1 |

## Decisions

- 2026-11-04 (planning, from the owner's MCP goal): the schema moves into `@threenative/terrain`
  instead of `render/biomes.ts` (PRD-790's first design), so the MCP can validate a biome without the
  example. PRD-790 Phase 1 boxes 1 and 2 are delivered here.
- 2026-11-05: the example reads the five files directly (`src/render/biomeData.ts` imports the package's
  `starter/<biome>/biome.data.json` as JSON and validates them once at load), rather than threading a
  spec argument through `createTerrain`/`loadPack`/`scatterProps`. Every branch the refactor replaces
  already had the world in hand, so a module-level validated table is the smallest read that keeps the
  file the only owner of the values. `biome-values.spec.ts` reads through the same table, so a mistyped field
  fails at load, named.
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
**Status:** DONE for the code — all six files and `game.ts` are at 0 world-name comparisons, `AC-3` green. The
playtest and visual-judge boxes below stay open (they are not this lane's to run), and the look table's
residual boolean switches are listed as an open item.
**Files:** `examples/strata-terrain-preview/src/game.ts`, `render/{biomes,pack,terrain,scatter,propMaterials,sky}.ts`
- [x] 0 world-name comparisons left. proof: the AC-3 `rg` command, plus `pnpm --filter strata-terrain-preview typecheck` — Evidence: the command prints nothing (exit 1) and `typecheck` exits 0, with 93 example tests in 11 files and 6 package tests green. Every placement the bake writes is byte-identical to `HEAD` (see AC-3).
  - `render/sky.ts` is at 0: its five comparisons became six named fields on the look preset (`softShadowFilter`, `shadowMapSize`, `tightShadowContacts`, `shadowRefreshStep`, `temporalAA`, `waterProof`), same values, `outdoor-shadows.spec.ts` and `typecheck` green.
  - Landed: `render/{biomes,terrain,pack,propMaterials,scatter}.ts` are at 0 (110 comparisons). Look decisions became named per-look fields on `IBiome` (`lawnGround`, `crestRock`, `crestTurf`, `mesaGround`, `mesaRock`, `mossGround`, `mats`, `localSnow`, `stoneSnow`, `stoneMoss`, `stoneMossTint`, `stoneSnowTint`, `stoneSectionTint`, `canopyTint`, `bladeTint`, `cutoutTint`, `propGrassTint`, `canopyInnerShade`, `canopyLinearInner`, `canopyAmbientOcclusion`, `canopyEmissiveScale`, `woodCanopy`, `crownGeometryNormals`, `authoredAlphaTest`, `pinnedCrags`, `scrubBush`, `strawBlades`, `dryStones`, `stoneGroundBand`, `contactRockface`, `stoneFrontFace`, `shoreGround`, `surveyedBackdrop`, `surveyCollar`, `openMeadow`, `oliveMeadow`, `woodedGround`, `cobbledRiverBed`, `sandRipples`, and the values `snowHollowLift`, `snowShedFrom`, `stoneGrey`, `distantStoneShare`, `groundCollarMeters`, `groundDistantStone`, `terrainCastsShadow`, `continuationTilt`, `groundSkyLight`, `bladeScale`, `bladeJitter`, `scrubChance`, `scrubScale`, `scrubJitter`, `coverDrift`). Rule decisions became reads of the validated file through a new `src/render/biomeData.ts` (the five `starter/<biome>/biome.data.json`, imported as JSON and validated once at load by `validateBiome`): `scatterRules` now resolves the file's `foliage`/`grass`/`water` rows instead of the deleted `SCATTER_RULES` table, memoised because `grassWeight` is a hot path; `speciesFor` draws exactly the species its file names, resolved to the pack's own art. New `IBiomeSpec` fields, each named after what it decides: `species` (the asset ids a biome holds), `foliage[].stands`, `foliage[].grassThreshold`, `foliage[].standThreshold`, `grass[].slopeFalloff`, `grass[].heightFalloff`, `grass[].mats` (the `thinning` label this commit replaced), `grass[].waterMargin`, `grass[].beach`, `grass[].detailSpacing` — filled in all five files and asserted in `biome-values.spec.ts` (file side) and its code-side mapping helpers. Green: `__tests__/biome-values.spec.ts`, `ground-vegetation`, `placements`, `rocks`, `far-forest`, `forest-backdrop`, `prop-surfaces`, `water-proof`, `river-clearance`, `groundSampler` (83 tests), `packages/terrain/__tests__/biome-spec.spec.ts` 6/6, `typecheck`.
  - `game.ts`'s last 18 are values now, not labels: `bake: { file, key }` in the biome file (which bundle the bake wrote this world into, and its key inside it) replaced the `world === "forest" || world === "coastal"` file choice; `vistaAim: { at: [x, z], rise: number | null }` on the look replaced the vista ternary and the three-armed `lookAt` chain (coastal aims 80/190 level with its own sea, alpine -200/170 at +170 m, desert -180/-160 at +30 m); `saplingHeight` (2 alpine, 1.4 tundra, null else) replaced the two `world === "alpine" ? 2 : world === "tundra" ? 1.4` ternaries; `stoneSinkShare` (0.12 on the two lawn worlds, null else) replaced `(world === "forest" || world === "coastal")` and its `* 0.12`; `stoneScans` (2 desert, 1 else) replaced the desert's `boulder:0` fill; `riverMirrorsPonds` (tundra) replaced `world === "tundra" ? lake?.reflectionAt`; `stageArm` (forest) replaced the `?stage=` gate. The ocean is `spec.water.some(kind === "ocean")`, the lakes and the swimming queries lost `limitToFootprint` outright (a parameter that was true for every water-bearing biome, so its false branch was dead), and the coast key flips to the other world in the same bake bundle instead of naming two worlds.
  - The value model this phase adopted: a branch is replaced by a value the branch computed, never by a tag that picks the formula. `coverDrift` stopped being `"wood" | "mats" | "sand" | "crest"` — four hardcoded curves a sixth biome would have to extend — and became `{ field, frequency, offset, amplitude, band }`, one curve (`coverDriftWeight` in `scatter.ts`) over one parameterised two-octave field (`render/coverField.ts`: `ICoverField`, `fieldWeight`, `STAND_FIELD`, `MATS_FIELD`, which `forestWeight` and the mat field now read rather than repeating their own octaves). The four looks carry the four curves' own numbers: wood `0.65 + 0.35·field(3.1, 2.7)`, sand `0.08 + 0.6` over a `[0.5, 0.3]` band at `(6.3, 5.7)`, crest over a `[0.3, 0.45]` band at `(2.1, 2.4)`, mats over a `[0.45, 0.3]` band at `(1, 1)` on the mat field. The package's `grass[].thinning` (`height | density | mats`) went the same way: `mats: [threshold, span] | null`, and `grassWeight` is one product, `meadow × density × height fade × mat weight`, so a dune field's `0.32` and a mat plain's `[0.47, 0.3]` are numbers in the file. The tree's own thresholds became reads too: `treeGrassThreshold`/`treeStandThreshold` and `grassWaterMargin` (declared by the earlier commit but still answered by `temperate ? 0.3 : 0.18` in the code) are now the rule.
  - Residual, named: the look table still carries booleans a world reads as facts — `lawnGround` (the ground is graded from photographed turf), `mats` (a mat plain), `mesaGround`/`mesaRock` (bedded mesa), `pinnedCrags`, and ~30 more like them — and `scatter.ts` aliases four (`temperate`, `desert`, `tundra`, `alpine`). A sixth biome sets them and writes no code, which is the test that separates them from a rename, but each one still selects a different formula and converting them is a per-look rewrite no local check can prove; that needs the visual judge. Left open with that reason rather than claimed.
- [ ] The web playtest and the loop playtest stay green. proof: `pnpm --filter strata-terrain-preview test:terrain:web` and `playtests/loop.playtest.json` (`pipelinesSinceReveal` 0) — Evidence: RED before this lane touched the file, on the same assertion. `playtests/terrain.playtest.json`'s `walk-distance` wait (`GameState.travel ≥ 50`) times out at 41.1993 m on this tree, at 41.1993 m with `&propCollision=off` and at **41.2013 m on `HEAD`** (`git archive HEAD examples/strata-terrain-preview` into a scratch tree, same dev server, same scenario, same flags). A 420-tick `KeyD` hold at the game's `JOG = 6 m/s` over `1/60 s` ticks is 42 m, so 50 m was never reachable in that hold; the assertion predates this branch's work and belongs to whoever owns the walk's budget. Reverting does not fix it, so it is not a regression this PRD can own. NOT RUN: the built-preview lane (`test:terrain:web` runs `pnpm build` and `vite preview` on port 5196) and `loop.playtest.json`; only the dev-server lane was run, on the pristine and the current tree.
- [ ] Fresh visual judge NEUTRAL or IMPROVEMENT for the five worlds. proof: AC-4
