# PRD-870: The procedural forest set reads like the Fab set

**Status:** PARTIAL — Phase 1 measured (2026-11-10); spruce colour first
**Priority:** P2 — a generated forest on a machine without the owner's licensed library draws the procedural set (AC-1 open); the owner asked for it to match the Fab art (2026-11-09).
**Complexity:** 6 (MEDIUM) — 4 to 6 files in `examples/strata-terrain-preview/src/render/` and `scripts/` (2), procedural geometry and atlas generation (2), a judged look target (2); risk override: none
**Owner:** João
**Depends on:** [PRD-866](PRD-866-a-generated-forest-stands-under-mountains-with-real-shapes.md) (the cooked forest these props stand in; no box here waits on it)
**Epic:** [Strata terrain hardening](README.md)

## Problem

Owner, 2026-11-09: "we have to think also about the strata terrain assets. because the strata forest example is using fab right? see if you can reproduce same assets as close as possible to FAB ones, but procedural for our engine".

The forest draws the owner's licensed Fab packs (Project Nature Spruce Forest, Grass Library, Ground Foliage, Meadow Flowers, Fern Collection) and Epic Kite Demo rock scans from the gitignored `local-assets/temperate/` (`src/render/pack.ts`, `src/render/prepared.ts`). Those bytes are local-only and never ship. A cooked forest (`terrain_generate`) or any other machine draws the procedural fallback instead: `src/render/spruce.ts`, `scripts/make-needle-atlas.mjs` and the starter clumps. The gap between the two sets has not been measured.

`?fab=off` (named override, `src/render/pack.ts` `FAB_ART`) draws the procedural set alone on the owner's machine, so both sets render at one pose on one GPU.

## Phases

### Phase 1 — measure the gap

- [x] Capture `?fab=off` and the Fab arm at `player`, `meadow-close`, `overview` and `vista`, two runs per arm, and give both to a fresh read-only judge who ranks the species by how far each procedural one is from its Fab one (silhouette, colour, density, detail). proof: the sheets in `~/Downloads/strata-forest-aaa/prd870/` and the ranked list in this box
  - result (2026-11-10, judge, `farForest=off`, two runs per arm stable): player FAR, meadow-close FAR, overview FAR, vista MEDIUM. Ranked by gap x screen share: (1) spruce canopy colour, value and spacing: procedural crowns are flat light yellow-green cards with no dark core, an even carpet of identical spires; Fab is dark blue-green, shadowed inside, olive lit tips, mixed sizes and gaps. (2) near spruce structure: large flat paddle cards hide the trunk; Fab is open with orange-brown trunks and dead lower branches. (3) flowers: a salmon carpet about 10-20x Fab's density with big star heads. (4) grass shorter and brighter, far forest more even, rocks tan and smooth (Fab dark grey scan). Procedural does better: a clearer spruce spire silhouette. Saplings and ferns unverified (hidden at these poses).
- [x] Measure triangles and draws per arm at each pose. proof: `propTriangles`/`propDraws` from the capture probe, both arms in this box
  - result (GPU ms p50 of 4 windows, props triangles, prop draws; Fab -> procedural): player 21.6 -> 20.7, 16.4 M -> 6.2 M, 104 -> 65; meadow-close 45.4 -> 28.0, 61.8 M -> 26.4 M, 103 -> 70; overview 35.6 -> 53.9, 28.4 M -> 19.2 M, 93 -> 64; vista 41.4 -> 40.4, 14.8 M -> 7.3 M, 84 -> 57. The overview costs 18 ms more with fewer triangles: the procedural crowns' large cards overdraw.

### Phase 2 — the species that cover the screen

- [ ] The procedural spruce matches the Fab spruce in crown profile (tiered drooping skirts, narrow spire), needle-card density and bark colour, within the same triangle budget per LOD level. proof: a judge verdict CLOSE or IMPROVEMENT on the spruce crops, two runs per arm
  - progress (2026-11-10, open): colour regraded (dd5147cda, judge IMPROVEMENT on meadow-close, overview, player; vista NEUTRAL). Crown base two fifths up for stand trees and warmer bark: judge IMPROVEMENT at meadow-close (trunk (59,72,49) -> (106,79,44), Fab about (79,60,47)), overview and vista NEUTRAL. Left: Fab boles stay bare to 60-70% with dead twigs; value and contrast (Fab about 30% darker with near-black gaps), dead lower branches, mixed crown sizes.
- [ ] The procedural grass, fern and flower clumps match their Fab ones in blade shape, height spread and colour at `meadow-close`. proof: a judge verdict on the meadow crops
  - progress (2026-11-10, open): flowers done (2d4ff9b39): one low stem with a 6 cm head per placement; salmon share of the lower half at meadow-close 0.209 -> 0.020 (Fab 0.008), vista 0.055 -> 0.009 (Fab 0.0007); judge IMPROVEMENT. Left: stalks paler and taller than Fab's, grass lighter and shorter with soil between tufts, ferns unjudged.

### Phase 3 — stone and the default

- [ ] The procedural boulder reads as a photoscanned rock (displaced, layered, lichen) at `player` and `river`. proof: a judge verdict on the rock crops
- [ ] Frame time with `?fab=off` is not above the Fab arm at `overview` and `vista`. proof: `measure-steady-state-fps`, paired arms, the numbers in this box
  - reading (2026-11-10, after the crown regrade, crown base and flowers; GPU ms, two middle windows of four, Fab -> procedural): overview 34.6 -> 53.7, vista 40.0 -> 37.6. The vista passes; the overview does not: the procedural crowns' large cards overdraw from above.

## Acceptance Criteria

- [ ] AC-1 [local]: A fresh read-only judge finds `?fab=off` CLOSE to the Fab arm on all four views, with no species ranked far. proof: the final sheets and verdict on the PR
- [ ] AC-2 [local]: The procedural set ships no licensed byte: every new asset is generated by a script in this repo or comes from a CC0 source named in `CREDITS.md`. proof: `git ls-files examples/strata-terrain-preview` lists no Fab file

## Decisions

- 2026-11-10 (executor): the `player` pose cannot judge the procedural spruce: its camera stands 24 m up and about 51 m behind the spawn (`spawn.cameraOffset` [28, 24, 42]), inside the canopy of the tall procedural trees, where the Fab arm frames a clearing. A clearing at the camera is placement work, not this PRD's look work; until then the spruce is judged at `meadow-close`.

- 2026-11-09: the procedural set stays game source in `src/render/` and `scripts/` (it decides how things look), not `packages/` (AGENTS.md, "Never own the look").
