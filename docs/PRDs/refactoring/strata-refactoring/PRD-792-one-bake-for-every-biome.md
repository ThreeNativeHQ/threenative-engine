# PRD-792 — One bake for every biome

**Status:** PARTIAL — Phase 1 is done (today's bake pinned by a committed digest table two forced
bakes reproduce) and Phase 2's package half is done: `bakeBiome`, `measureBands` and the four named
scatter stages ship in `@threenative/terrain`, and `terrain_generate` cooks through them. What Phase 2
has left is the example's half — its rules as data, per-bucket packages, and the deletion of
`propStreaming.ts`/`placements.ts` — which is the look-critical path this lane cannot prove.
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
**Status:** DONE
**Files:** `examples/strata-terrain-preview/__tests__/bake-golden.spec.ts` (new)
- [x] Two seeded bakes of each world give the same digest (placement count per species, placement hash, height hash, manifest hash). proof: `pnpm --filter strata-terrain-preview exec vitest run __tests__/bake-golden.spec.ts` — Evidence: 1/1 pass in 25 s: `bake-golden.spec.ts` runs `node scripts/bake.mjs --force` twice and asserts the second snapshot equals the first. A snapshot is, per world, the sha256 of `<world>.placements.bin`, the non-zero placement count per species decoded from that table's header, the sha256 of the baked `heights`, and the sha256 of `<world>.world.json`, plus the sha256 of `horizon.json`. `--force` because a warm stamp would skip the work under `pnpm test`; the outputs are byte-identical, so `git status` is clean after the run.
- [x] The digests of today's bake are committed, and the spec matches them. proof: same spec — Evidence: the `GOLDEN` table in `bake-golden.spec.ts`, measured at `8edfd6d81` before any bake code moved, asserts `expect(first).toEqual(GOLDEN)` after asserting `second === first`. Placement totals per world: forest 213 140 (3 131 spruce, 144 698 grass, 43 242 scrub, 7 211 fern, 5 379 sapling, 3 316 poppy, 2 694 litter, 1 616 pebble, 1 384 bush, 357 riverrock, 105 boulder, 7 mountain), coastal 144 192, alpine 3 598, desert 3 554, tundra 40 459 — the same totals PRD-791's AC-3 recorded from `HEAD`, so the pin and the biome refactor agree about the ground. The pin bites: `SCATTER.seed` changed from `466_468` to `466_469` fails the run (`expected { forest: { …(4) }, …(5) } to deeply equal …`), and reverting it restores all five worlds to the table byte for byte (`git diff --stat` prints nothing after the re-bake).

#### Phase 2: fold into the package
**Status:** PARTIAL — the package half landed; the example half is open.
**Files:** `packages/terrain/src/core/{bake-biome,scatter-stages}.ts` (new), `packages/terrain/src/core/types.ts`, `examples/strata-terrain-preview/scripts/bake.mjs`, `render/{scatter,farForest,propStreaming,placements,props}.ts`
- [ ] `bakeBiome` with the four scatter stages matches the Phase 1 digests. proof: `bake-golden.spec.ts` plus `pnpm exec vitest run packages/terrain/__tests__/scatter-identity.spec.ts packages/terrain/__tests__/world-package.spec.ts`
  - Package half landed, example half open. `packages/terrain/src/core/bake-biome.ts` ships `bakeBiome({ state, spec, assets })` and names the four stages (`BAKE_BIOME_STAGES: surfaceSample, densityFilter, selfPrune, meshSpawn`) as the fields of `IScatterParams` that `Terrain.evaluate()` already runs — so the package owns the composition and needs no second scatter engine. `packages/terrain/src/core/bands.ts` ships `measureBands(layers, heights)`, the biome file's fractions resolved once against a world's own samples (snow row separated, its shed pair reported, empty/non-finite samples fail closed, a flat field collapses the bands onto its one height). `terrain_generate` now bakes through `bakeBiome` and validates the starter's `biome.data.json` at the cook, and its result carries `biome` and the resolved `bands`.
  - Proof on this box: `pnpm exec vitest run packages/terrain/__tests__/bake-biome.spec.ts` 9/9 (bands resolution, snow separation, flat field, fail-closed samples, every instance carried, cell runs, seeded determinism, an asset outside the table refused); `terrain-mcp.spec.ts` 47/47 including the five-kit matrix, so every shipped kit still cooks and reports the same counts through the new path. `pnpm --filter @threenative/terrain typecheck` and `build` exit 0.
  - WHY the example half did not follow, measured: the game's `render/biomes.ts` table and the five `biome.data.json` files hold identical *bands* for all five worlds (checked by importing both), so the band half is a safe deletion — but the snow *shed* pair disagrees for one world: `coastal`'s look carries `snowShedFrom: 0.16` while its file carries `shedFrom: 0.04` (`shedTo` 0.22 in both). Switching the coast's shading to the file would move its snow line, and no judge can run here. Either the file row or the look's number is wrong; that is its own red-green with a visual judge, not a mechanical move.
  - Still open in the example: `scripts/bake.mjs`'s recipe chain as data, per-bucket package writing, and the deletion of `render/propStreaming.ts` + `render/placements.ts` (AC-2). The example's `placements.bin` is its own container and `propStreaming.ts` re-partitions it into 128 m buckets at load, so the deletion first needs the bake to write package-shaped cells per bucket and the game to load those — a browser-provable change.
- [ ] Example compiler and rules deleted. proof: AC-2
  - Not started. `wc -l` today: `scripts/bake.mjs` 655, `render/propStreaming.ts` 504, `render/placements.ts` 172. The target is `< 150` for the bake and no compiler at all; see the box above for the order the deletion has to happen in.

#### Phase 3: prove the game
**Status:** NOT STARTED
**Files:** none
- [ ] The web playtest and the loop playtest stay green. proof: `pnpm --filter strata-terrain-preview test:terrain:web` and `playtests/loop.playtest.json`
- [ ] Fresh visual judge passes. proof: AC-3
