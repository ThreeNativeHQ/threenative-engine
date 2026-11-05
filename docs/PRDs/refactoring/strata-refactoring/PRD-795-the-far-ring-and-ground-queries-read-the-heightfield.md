# PRD-795 — The far ring and ground queries read the heightfield, not world names

**Status:** PARTIAL — the exact ground half of Phase 2 landed: `Heightfield.surfaceAt` ships in
`@threenative/core/world` and the example's sampler delegates to it. The far ring (`HeightfieldCollar`)
and the game's ring/band wiring are open, as are the playtest and judge boxes.
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

- [ ] AC-1 [local]: `surfaceAt` equals the collider height to 1 mm at 10 000 seeded points, including outside the resident region. proof: `packages/core/__tests__/world-heightfield-surface.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: The player still climbs past the square and meets no wall. proof: `playtests/edge.playtest.json` (`edgeOvershoot` ≥ 20) and `walk.playtest.json` — Evidence: pending.
- [ ] AC-3 [local]: The horizon keeps its look in all five worlds. proof: `capture-strata-worlds` vista pose before and after, two runs per arm, fresh judge NEUTRAL or IMPROVEMENT — Evidence: pending.

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
  - Ran all three on today's code (HEAD 474bcab64) with `TN_PLAYTEST_HOST_DISPLAY=1`, `--browser-recipe webgpu`, `adapter.info` = nvidia/turing (RTX 2080, not SwiftShader), dev server on port 5196. **edge** exit 1: `travel` 106.23 m, `edgeOvershoot` 68.28 m, `grounded` true — every resource assertion passes; red only on `noConsoleErrors` (374). **walk** exit 2: `TN_PLAYTEST_OBSERVATION_UNAVAILABLE`, `GameState.travel` 40.75 m against the scenario's 50 m wait. **vista** exit 1: `coverNearEye` 8 681 and `currentViewWindows` 3 pass, capture `TN_CAPTURE_BLANK` (one colour), 1 972 console errors and 1 runtime diagnostic.
  - Open: all three are red on today's code for a reason this PRD does not touch — the ground material binds 24 fragment-stage samplers and this adapter allows 16 (`The number of samplers (24) in the Fragment stage exceeds the maximum per-stage limit (16)`), so three's pipelines are invalid and the frame draws no ground. The numbers above are the baseline the after arm is compared with; the scenarios cannot go green on this machine until the sampler budget fits 16 or the adapter reports more.

#### Phase 2: move into core/world
**Status:** PARTIAL
**Files:** `packages/core/src/world.ts` (or `world-heightfield.ts` after PRD-797), `packages/core/src/world-collar.ts` (new), example `render/{horizon,groundSampler,terrain}.ts` — after PRD-797 the field lives in `packages/core/src/world-heightfield.ts`, which is where `surfaceAt` was added; `world.ts` re-exports it, so `@threenative/core/world` exposes it as before.
- [ ] `surfaceAt` and `HeightfieldCollar` ship; the example calls them. proof: AC-1 plus `rg -n 'waterLevel !== null' examples/strata-terrain-preview/src/render/horizon.ts` prints nothing
  - `Heightfield.surfaceAt` landed: the triangle plane `toGeometry` emits, answered from the canonical samples, so a caller needs neither the geometry nor a matrix. It fails closed outside the field with `heightAt`'s own message. Proof: `packages/core/__tests__/world-heightfield-surface.spec.ts` 3/3 — 10 000 seeded points against a stock `Raycaster` on `toGeometry` (all 10 000 compared, and the bilinear `heightAt` differs at more than 1 000 of them, so the pin bites), every cell corner and the shared diagonal, the field's own boundary, and the two fail-closed cases (outside, non-finite).
  - The example's `render/groundSampler.ts` now delegates to it: the duplicated triangulation is gone, and the file keeps only the mesh-transform wrapper the game draws under (world → field space, `null` outside, `null` for a rotated or non-uniformly scaled mesh). Its own spec is the referee and stays green (5/5), with one tolerance change: the reference is the drawn mesh's float32 positions while `surfaceAt` answers the canonical float64 triangle, so the two agree to float32 precision (~5e-7 m) rather than to 1e-6.
  - Open in this box: `HeightfieldCollar` and the game's ring/band wiring. `horizon.ts` still derives a world from the water level, so its `rg` proof still prints a match.

#### Phase 3: prove the game
**Status:** NOT STARTED
**Files:** none
- [ ] Edge and walk playtests stay green. proof: AC-2
- [ ] Fresh visual judge passes. proof: AC-3
