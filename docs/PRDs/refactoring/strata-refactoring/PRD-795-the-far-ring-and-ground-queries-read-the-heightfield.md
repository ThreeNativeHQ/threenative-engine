# PRD-795 — The far ring and ground queries read the heightfield, not world names

**Status:** NOT STARTED
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
- [ ] Today's `groundSampler` matches the collider at 10 000 seeded points, inside and outside the region. Green on today's code. proof: `pnpm --filter strata-terrain-preview exec vitest run __tests__/groundSampler.spec.ts`
- [ ] Edge, vista and walk playtests are green on today's code and their numbers are recorded. proof: the three scenarios

#### Phase 2: move into core/world
**Status:** NOT STARTED
**Files:** `packages/core/src/world.ts` (or `world-heightfield.ts` after PRD-797), `packages/core/src/world-collar.ts` (new), example `render/{horizon,groundSampler,terrain}.ts`
- [ ] `surfaceAt` and `HeightfieldCollar` ship; the example calls them. proof: AC-1 plus `rg -n 'waterLevel !== null' examples/strata-terrain-preview/src/render/horizon.ts` prints nothing

#### Phase 3: prove the game
**Status:** NOT STARTED
**Files:** none
- [ ] Edge and walk playtests stay green. proof: AC-2
- [ ] Fresh visual judge passes. proof: AC-3
