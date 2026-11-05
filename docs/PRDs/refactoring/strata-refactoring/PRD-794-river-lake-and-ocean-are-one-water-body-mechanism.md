# PRD-794 — River, lake and ocean are one water-body mechanism

**Status:** PARTIAL — Phase 1's values are pinned; the swim playtest waits for the browser lane, and Phase 2 waits on the CHARTER decision.
**Priority:** P2 — A new biome with water copies one of three hand-written water paths (all phases open).
**Complexity:** 6 (MEDIUM); risk override: water look and swim physics must not change, so the owner's visual-judge rule applies
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-791](PRD-791-a-biome-is-a-validated-data-file.md) (the `IWaterBody` rows)
**Batch:** [Strata refactoring](README.md)

## Context

- `render/river.ts` is 1 308 lines: river ribbon geometry and its shading in one file. `render/water.ts` (272) and `world/water.ts` (158) hold more water code; `world/water.ts` is a linear scan marked `ponytail` while `createSegmentIndex` exists in `@threenative/terrain`.
- `render/ocean.ts` (342) and `packages/terrain/starter/coastal/sea.ts` (360) differ on 143 lines. `starter/forest/water.ts` and `starter/tundra/water.ts` overlap `render/water.ts`.
- `game.ts` passes `limitToFootprint` as `world === "tundra" || world === "forest"` at three call sites; the reach constants 13, 2.5 and 1.12 are literals.
- The swimmer reads the river current (`d08bb6b90`). Existing pins: `packages/terrain/__tests__/water.spec.ts`, `river-clearance.spec.ts`, `water-proof.spec.ts`, `playtests/swim.playtest.json`.

## Solution

Each biome's `IWaterBody` rows (`river`, `lake`, `ocean`) drive one path. The bake in
`@threenative/terrain` writes the ribbon and lake footprints, the ocean level, and the terrain carve
(Unreal `FWaterCurveSettings`). A runtime `WaterBodies` query in `@threenative/core/world` answers
`surfaceAt`, `currentAt` and `footprintAt` from the baked arrays through a segment index. Rendering
and physics read the same store, as they do for `Heightfield`. Shading stays in game `src/render/`,
and `ocean.ts` and the starter `sea.ts` become one copy-out source.

## Acceptance Criteria

- [ ] AC-1 [local]: `surfaceAt` and `currentAt` return the same values as today at fixed probes in the forest river, the tundra lake and the coastal ocean. proof: `water-bodies-values.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: The swimmer still floats and drifts with the current. proof: `playtests/swim.playtest.json` — Evidence: pending.
- [ ] AC-3 [local]: The water keeps its look in forest, coastal and tundra. proof: `capture-strata-worlds` before and after, two runs per arm, fresh judge NEUTRAL or IMPROVEMENT — Evidence: pending.

## Blocked on

- `CHARTER.md` admits water-body queries as core mechanism ("queryable storage shared by rendering and physics", beside `Heightfield`) — unblocked by the owner's approval of the CHARTER line.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Water bodies | Game load → `WaterBodies` → river mesh, swim buoyancy and current | `world/water.ts` and the geometry half of `render/river.ts`: deleted | AC-1, AC-2 |
| Sea surface | Coastal world → one copy-out sea source | `render/ocean.ts` or `starter/coastal/sea.ts`: one deleted | AC-3 |

## Execution Phases

#### Phase 1: pin water
**Status:** PARTIAL — the three kinds' values are pinned; the swim playtest is open.
**Files:** `examples/strata-terrain-preview/__tests__/water-bodies-values.spec.ts` (new)
- [x] Surface height, current vector and footprint at fixed probes for the three water kinds, green on today's code. proof: `pnpm --filter strata-terrain-preview exec vitest run __tests__/water-bodies-values.spec.ts` — Evidence: 4/4 pass in 2.3 s on today's code, and `pnpm exec tsc --noEmit -p tsconfig.json` exits 0 in the example. The spec reads the committed bake (`src/world/baked.json` for forest and coastal, `src/world/tundra.json` for the tundra) and calls today's queries (`waterSurfaceAt`/`waterCurrentAt` in `world/water.ts`, and `createWaterMesh` for the sea):
  - forest river (`river`, 5.32 m wide, so 13.3 m of reach): surface 13.730976740569075 at [-120, -220], 11.626775327408664 at [-110, -175] and 12.8125147026022 at [-100, -95], with current {0.2064408711935989, 0.8760035197993371}, {0.016071794375532095, 0.899856487127559} and {0.5272509284188672, 0.7293877284966087}. The water stops between 13.2 m and 13.4 m either side of the (-110, -175) station: [-96.8, -175] and [-123.2, -175] answer, [-96.6, -175] and [-123.4, -175] do not.
  - forest lake (-70, 25; level 13.3 m; cap 105 m): 13.3 m and a zero current at the centre, at [30, 25] (100 m out) and at the river's last station [-70, -60], where the higher lake surface wins and the river stops carrying; [36, 25] (106 m) has no water.
  - tundra kettles (near (65, 80), level 28.8 m, cap 34 m; far (-65, -50), level 30 m, cap 46 m): 28.8 m and 30 m with a zero current out to the cap — [65, 114] and [-65, -4] answer, [65, 115] and [-65, -3] do not.
  - coastal ocean: the sea plane stands at the bake's `waterLevel` of 1.5 m (the mesh's y) and its stretched geometry spans ±4120 m, so [250, 250] and [2000, -2000] stand on it at 1.5 m and [4200, 0] does not. The coastal bake has no river and no lake, so the sea carries no current (zero vector).
- [ ] The swim playtest is green on today's code and its numbers are recorded. proof: `playtests/swim.playtest.json`
  - Open: browser lane.

#### Phase 2: one mechanism
**Status:** NOT STARTED
**Files:** `packages/core/src/world-water-bodies.ts` (new), `packages/core/src/world.ts`, `packages/terrain/src/core/bake-biome.ts`, `docs/architecture/CHARTER.md`, example `world/water.ts`, `render/{river,water,ocean}.ts`, `game.ts`
- [ ] `WaterBodies` serves the probes with a segment index and no world-name check. proof: AC-1 spec plus a core unit spec `packages/core/__tests__/world-water-bodies.spec.ts`
- [ ] Duplicate water paths deleted and `limitToFootprint` read from the row. proof: `rg -n 'limitToFootprint' examples/strata-terrain-preview/src/game.ts` shows no world name

#### Phase 3: prove the game
**Status:** NOT STARTED
**Files:** none
- [ ] Swim playtest and river clearance stay green. proof: AC-2 and `river-clearance.spec.ts`
- [ ] Fresh visual judge passes. proof: AC-3
