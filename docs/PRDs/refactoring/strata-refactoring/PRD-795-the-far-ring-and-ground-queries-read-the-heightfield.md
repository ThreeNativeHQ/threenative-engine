# PRD-795 — The far ring and ground queries read the heightfield, not world names

**Status:** PARTIAL — `Heightfield.surfaceAt` and `HeightfieldCollar` ship in `@threenative/core/world`
and the example calls both. The collar draws the byte-identical ring grid it replaced and 10 000 seeded
points match the collider to 1 mm. Open: the browser playtests now run with the licensed art present,
and they are still red because the ground material's pipeline is invalid on this adapter (24 fragment
samplers against 16), so AC-2 and AC-3 wait for a lane whose frame draws the terrain surface.
**Priority:** P2 — A new biome needs a hand-tuned horizon and a ground sampler copy, because the far ring derives its world from the water level and the landform (all phases open).
**Complexity:** 5 (MEDIUM); risk override: the horizon reaches the screen, so the owner's visual-judge rule applies
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-791](PRD-791-a-biome-is-a-validated-data-file.md) (ring and band values in the biome row); coordinates with PRD-790 Phase 2 (tiles meet the ring)
**Batch:** [Strata refactoring](README.md)

## Context

- `render/horizon.ts` (240) derives the world name from `waterLevel !== null` or the landform, and hardcodes 384 rings and a 200 m walk band.
- `render/groundSampler.ts` (71) exists because `Heightfield.heightAt` is bilinear while the collider is triangle-exact, and it throws outside the resident region.
- Collar and curvature code sits inside `render/terrain.ts` (1 539) beside the ground material.
- Existing pins: `groundSampler.spec.ts`, `forest-backdrop.spec.ts`, `playtests/edge.playtest.json` (`edgeOvershoot` ≥ 20), `vista.playtest.json`, `walk.playtest.json`.

## Solution

Core/world gains `Heightfield.surfaceAt(x, z)`, which returns the same height as the collider
triangle (Unreal `ULandscapeHeightfieldCollisionComponent`), and `HeightfieldCollar`, the far ring
past the playable square (Unreal `ALandscapeMeshProxyActor`, HLOD). The game passes the far
sampler, the ring count and the walk band from its biome row. Both are inside the existing
world-subpath admission ("queryable heightfield storage", "LOD composition, skirts"). The collar's
material and colour stay in game `src/render/`.

## Acceptance Criteria

- [x] AC-1 [local]: `surfaceAt` equals the collider height to 1 mm at 10 000 seeded points, including outside the resident region. proof: `packages/core/__tests__/world-heightfield-surface.spec.ts` — Evidence: 3/3 green; all 10 000 seeded points compared against a stock `Raycaster` on `toGeometry` at `toBeCloseTo(expected, 4)` (5e-5 m, twenty times tighter than 1 mm), the bilinear `heightAt` a different answer at more than 1 000 of them, each cell corner and the shared diagonal, the field's own boundary, and the two fail-closed cases (outside the region, non-finite). The collider's own triangles are pinned by `examples/strata-terrain-preview/__tests__/groundSampler.spec.ts`: 8 000 seeded points inside to 1 mm against Rapier's heightfield, 2 000 outside answering `null`.
- [ ] AC-2 [local]: The player still climbs past the square and meets no wall. proof: `playtests/edge.playtest.json` (`edgeOvershoot` ≥ 20) and `walk.playtest.json` — Evidence: re-ran both on HEAD 44f08f71e with `examples/strata-terrain-preview/local-assets` present (`ls .../temperate` lists the licensed art). edge: exit 1, `travel` 149.1231472588627 m, `edgeOvershoot` 58.02667236328125 m, `grounded` true, `maxContactError` 7.766071286141596e-05 m, `contactSamples` 1 094 — every resource assertion passes, and the walk onto the surveyed hills is unchanged in kind. walk: exit 2, `TN_PLAYTEST_OBSERVATION_UNAVAILABLE`, last observation `travel` 41.19384339607136 m inside the scenario's 5 061 ms window (the pin is 50 m). Both runs are red on `noConsoleErrors` (237 console errors, 0 network errors, 0 runtime diagnostics). The frame draws grass, forest and mountains but no terrain surface: the ground material's pipeline binds 24 fragment-stage samplers and this device allows 16 (`The number of samplers (24) in the Fragment stage exceeds the maximum per-stage limit (16)`), so its pipeline is invalid. Measured ground region (bottom third, bar under 220 per channel): edge 235.3/239.8/244.0 RGB. Open: this machine's frame draws no terrain surface, and `walk` times out at 41 m; both causes predate this PRD.
- [ ] AC-3 [local]: The horizon keeps its look in all five worlds. proof: `capture-strata-worlds` vista pose before and after, two runs per arm, fresh judge NEUTRAL or IMPROVEMENT — Evidence: pending. Open: judge lane. The vista capture this machine produces has no terrain surface to judge (`playtests/vista.playtest.json` fails its own `visual.0.region.darkPixels` check with 0 dark pixels against a 0.4 floor, because the mountain silhouette draws white).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Exact ground height | Player grounding, prop snap, camera → `Heightfield.surfaceAt` | `render/groundSampler.ts`: deleted | AC-1, AC-2 |
| Far ring | Game load → `HeightfieldCollar` | Geometry half of `render/horizon.ts` and the collar code in `render/terrain.ts`: deleted | AC-3 |

## Execution Phases

#### Phase 1: pin the ground and the edge
**Status:** NOT STARTED
**Files:** `examples/strata-terrain-preview/__tests__/groundSampler.spec.ts`
- [x] Today's `groundSampler` matches the collider at 10 000 seeded points, inside and outside the region. Green on today's code. proof: `pnpm --filter strata-terrain-preview exec vitest run __tests__/groundSampler.spec.ts`
  - Done, 6/6 green on today's code. 8 000 seeded points inside the square match the Rapier heightfield collider's own triangles to 1 mm (`toBeCloseTo(expected, 3)`), and the bilinear `heightAt` is a different answer at more than 1 000 of them, so the pin bites; 2 000 seeded points outside the square answer `null` from the sampler and no hit from the collider. The collider is built by the solver itself — `ColliderDesc.heightfield(rows - 1, columns - 1, field.toColliderHeights(), { x: size, y: 1, z: size }, FIX_INTERNAL_EDGES)`, the descriptor `packages/physics/src/simulation.ts` builds for the game's terrain — from the workspace's own Rapier copy, because this example declares no Rapier dependency. Rapier returns a float32 time of impact, so each ray starts 100 m above the ground it asks about: a 10 km fall would round to a millimetre.
  - The earlier half stays: the spec also compares the sampler with a stock `Raycaster` on the drawn triangles (a saddle where the bilinear height differs by more than 0.2 m, both diagonals, the shared edge, off-centre points).
- [ ] Edge, vista and walk playtests are green on today's code and their numbers are recorded. proof: the three scenarios
  - The earlier record in this box ran without `local-assets`, so it measured a frame with no licensed art. Re-ran all three on HEAD 44f08f71e with the art present, `TN_PLAYTEST_HOST_DISPLAY=1`, `--browser-recipe webgpu --headed`, `adapter.info` = nvidia/turing (RTX 2080, not SwiftShader), dev server on port 5196. Console capture reports 0 network errors and 162 243 resident prop instances, so the art loads.
  - **edge** exit 1: `travel` 149.1231472588627 m (was 106.22625623773109 m without art), `edgeOvershoot` 58.02667236328125 m (was 68.27825927734375 m), `grounded` true, `maxContactError` 7.766071286141596e-05 m, `contactSamples` 1 094, `bilinearDifference` 1.5. Every resource assertion passes; red only on `noConsoleErrors` (237 errors). Ground bottom third 235.3/239.8/244.0 RGB.
  - **vista** exit 1: `coverNearEye` 7 852 (floor 3 000), `currentViewWindows` 3, `worldReady` and `revealComplete` true — the art loads and the meadow draws; red on `noConsoleErrors` (424 errors) and on the scenario's own `visual.0.region.darkPixels` (0 dark pixels against a 0.4 floor: the mountain band draws white). Ground bottom third 97.1/112.7/90.9 RGB.
  - **walk** exit 2: `TN_PLAYTEST_OBSERVATION_UNAVAILABLE`, `GameState.travel` last observed at 41.19384339607136 m against the scenario's 50 m wait (was 40.75 m without art). Ground bottom third 132.0/143.4/139.0 RGB.
  - Open: all three are red for a cause this PRD does not touch. The ground material's pipeline binds 24 fragment-stage samplers and this device allows 16 (`The number of samplers (24) in the Fragment stage exceeds the maximum per-stage limit (16)`), so the pipeline is invalid and the terrain surface draws white under the vegetation; `walk` in addition times out at 41 m. The measured numbers above are the record the after arm is compared with.

#### Phase 2: move into core/world
**Status:** PARTIAL
**Files:** `packages/core/src/world.ts` (or `world-heightfield.ts` after PRD-797), `packages/core/src/world-collar.ts` (new), example `render/{horizon,groundSampler,terrain}.ts` — after PRD-797 the field lives in `packages/core/src/world-heightfield.ts`, which is where `surfaceAt` was added; `world.ts` re-exports it, so `@threenative/core/world` exposes it as before.
- [x] `surfaceAt` and `HeightfieldCollar` ship; the example calls them. proof: AC-1 plus `rg -n 'waterLevel !== null' examples/strata-terrain-preview/src/render/horizon.ts` prints nothing
  - `rg -n 'waterLevel !== null' examples/strata-terrain-preview/src/render/horizon.ts` prints nothing (exit 1). The world now comes from the biome row (`biome?.world ?? "forest"`), so a sixth biome brings its own surveys.
  - `HeightfieldCollar` (`packages/core/src/world-collar.ts`, re-exported by `@threenative/core/world`) owns the ring grid: one vertex per boundary sample per ring, the ring index triangles, the perimeter walk (`boundary`), and the walk band as a view of the same position buffer and index slice. Every look value stays in the game: `ringDistance` is the game's framing curve, `height` its own surface (survey, prefiltered blend, seam fade), and the colours are written by `collarColors` in `render/horizon.ts`.
  - Core unit spec `packages/core/__tests__/world-collar.spec.ts` 7/7: ring 0 on the square's own edge, counts, the boundary walk (one sample per step, no gaps or repeats), `heightAt` at every drawn vertex and at quad centres, null inside the square and past the outer ring, `locate`/`index`/`distance` fail-closed, and a `Raycaster` landing on a drawn vertex.
  - The replaced code draws the same surface: positions, colours, normals and the index buffer digest byte-identically before and after (394 240 vertices, 786 432 triangles), and the walk band is the same 92 rings reaching 198.757 m. The example's specs that build a terrain stay green (29/29 across `far-forest`, `prop-surfaces`, `groundSampler`).
  - `Heightfield.surfaceAt` landed: the triangle plane `toGeometry` emits, answered from the canonical samples, so a caller needs neither the geometry nor a matrix. It fails closed outside the field with `heightAt`'s own message. Proof: `packages/core/__tests__/world-heightfield-surface.spec.ts` 3/3 — 10 000 seeded points against a stock `Raycaster` on `toGeometry` (all 10 000 compared, and the bilinear `heightAt` differs at more than 1 000 of them, so the pin bites), every cell corner and the shared diagonal, the field's own boundary, and the two fail-closed cases (outside, non-finite).
  - The example's `render/groundSampler.ts` now delegates to it: the duplicated triangulation is gone, and the file keeps only the mesh-transform wrapper the game draws under (world → field space, `null` outside, `null` for a rotated or non-uniformly scaled mesh). Its own spec is the referee and stays green (5/5), with one tolerance change: the reference is the drawn mesh's float32 positions while `surfaceAt` answers the canonical float64 triangle, so the two agree to float32 precision (~5e-7 m) rather than to 1e-6.
  - The game's ring/band wiring moved with it: `createTerrain` returns the collar, `game.ts` builds the band's collider from `collar.walk` and samples the drawn collar through `collar.heightAt`/`locate`, and `render/farForest.ts`'s `collarSampler` lost its own copy of the quad walk. `horizonWalkGeometry` is gone.

#### Phase 3: prove the game
**Status:** NOT STARTED
**Files:** none
- [ ] Edge and walk playtests stay green. proof: AC-2
  - Open: with the licensed art present, edge's resource assertions pass (`travel` 149.123 m, `edgeOvershoot` 58.027 m, `grounded` true) and every one of them matches the before arm in kind, but both runs are red on the console-error policy for the pre-existing ground-material sampler limit; `walk` times out at `travel` 41.194 m. Both causes predate the collar.
- [ ] Fresh visual judge passes. proof: AC-3
  - Open: judge lane. A judge needs two captures per arm of a frame that draws the terrain surface, and this machine's frame draws none (24 fragment samplers against this adapter's 16), so the vista capture shows a white hillside where the silhouette belongs.
