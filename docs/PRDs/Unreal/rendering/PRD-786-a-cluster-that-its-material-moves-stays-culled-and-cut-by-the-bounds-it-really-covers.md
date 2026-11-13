---
prd_contract: v1
---

# PRD-786 — A cluster that its material moves stays culled and cut by the bounds it really covers

**Status:** NOT STARTED
**Priority:** P2 — AC-1 to AC-3 are open: a clustered mesh whose material has a `positionNode` is still culled and cut by the bounds of the undeformed mesh. Phase 1 has not yet measured how often a real scene shows the error.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files (+1), a new declared-extent contract on materials (+2), the cut distance rule changes (+1), native proof on the owned host (+1); risk override: none
**Owner:** unassigned
**Depends on:** None. Coordinates with [PRD-600](../../done/PRD-600-a-clustered-mesh-submits-only-the-clusters-the-view-holds.md) (its last Phase 3 box proposed this gap; this PRD takes it, see `## Decisions`), [PRD-490](../../open-world/PRD-490-cluster-lod-wins-on-native.md) (one draw per material on native, a separate outcome), [PRD-668](PRD-668-a-displaced-surface-changes-its-silhouette-near-the-camera.md) (displacement adds vertices and owns its own bound) and [PRD-678](PRD-678-a-dense-skinned-body-takes-the-cluster-cut-in-every-view-that-sees-it.md) (posed bounds of skinned clusters).

## Context

Virtual geometry is on by default for any primitive of 65,536 triangles or more. The game's material draws every selected cluster. This is the rule that makes masked materials and world position offset work by construction. A `positionNode` can move a cluster far from where the bake put it. Three parts of the engine do not know this.

- **Three culls the whole mesh by the undeformed sphere.** `withOwnCut` copies the source `boundingSphere` into the clustered mesh (`packages/core/src/clustered-mesh.ts:336`). `frustumCulled` stays at its default of `true`, so three tests that sphere. A mesh that sways or slides past the sphere vanishes at the screen edge while part of it is still in view.
- **The engine cull uses the same sphere.** `boundsOf` in `packages/core/src/render-camera-cull.ts:926` returns the geometry sphere, or the instance sphere for an `InstancedMesh`. A clustered batch sets `frustumCulled = false` on every band (`clustered-batch.ts:486`), so `RenderCameraCull` skips it on purpose. Nothing in this file reads `positionNode`.
- **The cut measures the distance to the cluster where it was baked.** `projectedError` (`clustered-mesh.ts:100`) takes the camera distance to the baked cluster sphere. A cluster that the material moves toward the camera projects more pixels than the cut assumed. The cut is too coarse, and the next re-cut pops it.

The only code that knows about a moved vertex is `isMovingOwnVertices` in `packages/core/src/projection-plan.ts:144`. It exists to keep the projection path from stacking a second `positionNode`. It does not feed any bound.

PRD-600 listed this gap as one box in its Phase 3. That box sits behind the pruned walk, so it never reaches the two bugs above, which exist without any pruning. This PRD files the gap on its own.

### What Unreal does (UE 5.8.3, read 2026-11-02; clean-room summary, no code copied)

- **A material declares how far it can move a vertex.** The scene proxy takes the largest `GetMaxWorldPositionOffsetDisplacement()` of its sections. The Nanite resources keep it per material section, only when the section evaluates WPO. UE 5.8.3: `Engine/Source/Runtime/Engine/Private/StaticMeshSceneProxy.cpp:366`, `Engine/Source/Runtime/Engine/Private/Rendering/NaniteResources.cpp:758-764`.
- **Culling widens every box by that extent.** `GetLocalMaxWPOExtent` returns the extent, scaled by the inverse non-uniform instance scale, when WPO is enabled for the instance. It also returns it when any material ignores the enable flag. The cluster pass adds it to the box half-size before it tests the box. UE 5.8.3: `Engine/Shaders/Private/Nanite/NaniteSceneCommon.ush:56-60`, `Engine/Shaders/Private/Nanite/NaniteClusterCulling.usf:162-169`.
- **The node pass widens too.** A node expands its bounds when WPO is enabled. A shadow pass expands them even when WPO is distance-disabled, so the cache invalidates the whole region. UE 5.8.3: `NaniteClusterCulling.usf:459-468`.
- **WPO stops past a distance, and the raster bin changes.** A primitive can carry a WPO disable distance. Past it the instance has WPO off, and the cluster uses the fixed-function fallback bin when no pixel-programmable distance is set. UE 5.8.3: `Engine/Shaders/Private/Nanite/NaniteCullingCommon.ush:487-504`. The fallback pipeline drops to a non-programmable bin when the material has neither per-pixel evaluation nor displacement. UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShading.cpp:2635`, `:2668-2676`. The console switch `r.Nanite.Culling.WPODisableDistance` turns the rule off for testing. UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp:293-298`. The distance defaults to off in the main view.
- **Binning is a draw-count tool.** Unreal bins visible clusters by raster material so each bin runs one indirect dispatch. The bin registry allocates a bin per programmable pipeline. UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShared.h:659-690`, `:820-829`. ThreeNative has one three material per mesh, so each material is already its own pipeline. Draw count per material is PRD-490.

**Gap this PRD closes:** the declared extent. Unreal widens the box before any test. ThreeNative tests the undeformed sphere.

**Left out on purpose:** raster bins (by construction, PRD-490 owns draw count), the shared console variables and pass-driver glue of the cull and raster files (no ThreeNative equivalent), and a software rasterizer for small triangles (out of scope, see PRD-600's `## three.js 0.187.0 levers`).

## Solution

The change has three steps. Step 1 decides whether steps 2 and 3 continue.

1. **Measure first (Phase 1).** Build a sway arm of the quarry. The cliff mesh and the boulder batch get a `positionNode` that moves each vertex along a wind direction (the vegetation example's `wind.ts` is the model of a real node). Add read-only counters that compare the sphere three tests with the sphere that holds the moved cluster centres, and the camera distance to a cluster with and without the offset. A red test shows a cluster drawn too coarse and a mesh culled while one cluster is in view. A capture of the route shows the pop. Three.js 0.187.0 gives a second answer: its `MeshletDrawingPipeline` evaluates the `positionNode` on the GPU and widens the bound by a measured margin (`examples/jsm/pipelines/MeshletDrawingPipeline.js:409-470`). Run it as the reference arm on `engine: "threejs"`. **Gate:** continue only if the sway arm shows a wrongly culled mesh or a cut more than one level too coarse on the route. Otherwise record the decline under `## Decisions` and delete Phases 2 and 3 (R4).
2. **Declare the extent and widen the bounds (Phase 2).** A material that moves vertices names the farthest it can move one, in metres, as `material.userData.maxPositionOffset`. The clustered mesh and the clustered batch read it. Auto by default: with no `positionNode` the extent is 0 and nothing changes. With a declared extent, the engine widens the sphere that three and `RenderCameraCull` test by that extent, and it subtracts the extent from the camera distance in `projectedError`, so the cut stays fine enough for the cluster at its farthest move. A `positionNode` with no declared extent fails closed: the mesh sets `frustumCulled = false`, the batch keeps every copy, the cut uses the undeformed spheres, and the object reports `positionOffset: "unbounded"` and raises `TN_SCENE_WARNING` naming the mesh. The named override is the same property on the mesh, `maxPositionOffset`, which wins over the material. The extent scales with the mesh scale, as Unreal scales it by the inverse instance scale. Back-compat is exact: a mesh with no `positionNode` runs the same code path and returns the same cut.
3. **Prove it on both runtimes and teach the kits (Phase 3).** The vegetation `wind.ts` helper declares the extent from its own `amplitude`, so a game that uses it never sees the warning. The kit lint rule rejects a clustered mesh with a `positionNode` and no extent. The quarry sway route runs on the browser and on the desktop host. A visual judge compares frames before and after.

**Consumer flow.** The game builds its material with a `positionNode` and sets one number. The engine already calls `updateClusteredMeshes` before every render (`packages/core/src/game.ts:1749`). That call reaches `ClusteredMesh.update` and `ClusteredBatch.update`, which now read the extent. The observable result is a mesh that stays on screen while any moved part is in view, and a cut with no pop when the wind moves a cluster toward the camera.

**Look is untouched.** The game's material still draws every cluster and decides how it moves. The engine owns only a bound, so the work lives in `packages/core/src/` as mechanism. The wind helper stays in the example's `src/render/`.

**Risks:**

- **A declared extent that is too small.** The engine cannot see a node's range. The fail-closed report covers the missing value. A value that is wrong is the game's error. The sway arm checks the measured maximum against the declared value and the playtest fails when a vertex exceeds it.
- **A cut finer than needed.** Subtracting the extent from the distance adds triangles near a swaying mesh. Phase 1 records the cost, and Phase 3 holds `gpuMs` to the budget in AC-3.
- **Native.** The change is plain TypeScript in `packages/core`, so the host runs it unchanged. The claim still needs its own native run.

## Acceptance Criteria

- [ ] AC-1 [local]: With a declared extent, a clustered mesh and a batch copy stay drawn while any part of a moved cluster is inside the frustum, and the cut for a moved cluster equals the cut a flat oracle takes with the cluster at its nearest offset. Without a `positionNode`, the cut is identical to today's over 200 seeded poses. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts packages/core/__tests__/clustered-batch.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: A `positionNode` with no declared extent reports `positionOffset: "unbounded"`, raises `TN_SCENE_WARNING`, and is never culled. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts` — Evidence: pending.
- [ ] AC-3 [local]: On the quarry sway route at 1080p on a named WebGPU adapter, 0 frames show a mesh culled with a moved part in view, no cut pops, and `gpuMs` stays within the budget Phase 1 sets. proof: `pnpm --filter quarry measure -- --arm virtual-sway --url http://127.0.0.1:5191` and a visual judge verdict — Evidence: pending.
- [ ] AC-4 [local]: The same route on the desktop host shows the same drawn clusters with no frame-op replay error. proof: `pnpm --filter quarry build:desktop && pnpm --filter quarry pack:native && pnpm --filter quarry measure -- --arm virtual-sway --target desktop` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Declared extent on `ClusteredMesh` | `updateClusteredMeshes` (`game.ts:1749`) calls `ClusteredMesh.update` every frame | The undeformed sphere stays the bound only when the extent is 0 | AC-1, AC-3 |
| Declared extent on `ClusteredBatch` | The same call reaches `ClusteredBatch.update` | The copy sphere and the band cut distance gain the extent | AC-1, AC-3 |
| Fail-closed report | A mesh with a `positionNode` and no extent, seen by the loader and the scene warning | The silent wrong cull becomes a named warning | AC-2 |
| Wind helper declares its extent | `examples/integrations/vegetation/src/render/wind.ts` builds the node | The helper sets the number from its own `amplitude` | AC-3 |
| Kit lint rule | `packages/create-threenative/src/quality/` | A new game cannot ship the undeclared pattern | AC-2 |

## Execution Phases

#### Phase 1: Measure what a moved cluster costs
**Status:** NOT STARTED
**Files:** `examples/quarry/src/quarry/arm.ts`, `examples/quarry/src/render/` (the sway material), `examples/quarry/scripts/measure.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`
**Implementation:** the `virtual-sway` arm, counters for wrongly culled frames and cut levels off, and the three.js 0.187.0 reference arm. The gate verdict goes under `## Decisions`.
- [ ] A red test shows the three failures on a sway fixture: a mesh culled with a moved cluster in view, a batch copy culled the same way, and a cut one level too coarse for a cluster moved toward the camera. proof: `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts packages/core/__tests__/clustered-batch.spec.ts` (fails before Phase 2)
- [ ] The quarry sway route reports the count of wrongly culled frames and the cut-level error on the browser and on native, next to the three.js 0.187.0 reference arm's margin. proof: `pnpm --filter quarry measure -- --arm virtual-sway --url http://127.0.0.1:5191` and the same command with `--target desktop`

#### Phase 2: A declared extent widens the bound and the cut
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-mesh.ts`, `packages/core/src/clustered-batch.ts`, `packages/core/src/render-camera-cull.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`, `packages/core/__tests__/clustered-batch.spec.ts`
**Implementation:** read `userData.maxPositionOffset` and the `maxPositionOffset` override, widen the sphere three and `RenderCameraCull` test, subtract the extent in `projectedError`, and report `positionOffset` on the object. The fail-closed path sets `frustumCulled = false` and raises the warning.
**Verification:** AC-1 and AC-2 close this phase.
- [ ] A mesh and a batch copy with a declared extent stay drawn while any moved part is in view, and the cut uses the nearest offset. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts packages/core/__tests__/clustered-batch.spec.ts`
- [ ] A `positionNode` with no extent reports `unbounded`, raises `TN_SCENE_WARNING`, and is never culled. A mesh with no `positionNode` returns today's cut on 200 seeded poses. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts`

#### Phase 3: Teach the kits and prove it on both runtimes
**Status:** NOT STARTED
**Files:** `examples/integrations/vegetation/src/render/wind.ts`, `packages/create-threenative/src/quality/` (the lint rule and its spec), `docs/guides/api.md`, `examples/quarry/playtests/`
**Implementation:** the wind helper declares its extent. The lint rule rejects the undeclared pattern. The guide states the contract and the override. A playtest scenario sways the route and fails when a vertex exceeds the declared extent.
**Verification:** AC-3 and AC-4 close this phase. The visual judge from the root `AGENTS.md` compares route frames before and after, with a gust mid-route.
- [ ] The wind helper declares its extent from `amplitude`, and the kit lint rule rejects a clustered mesh with a `positionNode` and no extent. proof: red-green `pnpm exec vitest run packages/create-threenative/__tests__/quality` and `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts`
- [ ] The sway playtest passes on the browser and on the desktop host, and the visual judge returns NEUTRAL or IMPROVEMENT. proof: `node packages/playtest/dist/runner/cli.js examples/quarry/playtests/quarry-sway.playtest.json --url http://127.0.0.1:5191 --browser-recipe webgpu` and the same scenario with `--target desktop`

## Decisions

- 2026-11-02 (filing): PRD-600's last Phase 3 box ("a clustered mesh whose material has a `positionNode` widens each cluster's bounds ... or keeps view pruning off") moves here. It waited behind the pruned walk, so the whole-mesh cull and the cut distance stayed wrong in the meantime. The editor of PRD-600 strikes that box under its own R4 when this PRD starts. When PRD-600 Phase 3 lands, its pruned walk reads the extent this PRD defines, per cluster group.
- 2026-11-02 (filing): the engine does not evaluate the `positionNode`. A node can read time, textures and uniforms, so no single measure holds across frames. Unreal also declares the extent. Three.js 0.187.0 does evaluate it on the GPU at seven points and adds a curvature margin (`MeshletDrawingPipeline.js:409-470`). Phase 1 runs that as the reference arm. Revisit auto-measurement if the arm shows that games forget to declare the value.
- 2026-11-02 (filing): the WPO disable distance and the fixed-function fallback bin are deferred. Unreal defaults the main-view distance to off, and ThreeNative has no second material to switch to. Revisit condition: a template ships a dense swaying mesh whose Phase 1 `gpuMs` exceeds the budget with the wind on.
- 2026-11-02 (filing): raster binning stays "by construction" in `nanite.json`. Each three material is its own pipeline, and draw count per material is PRD-490.

## Blocked on

- PRD-600 Phase 3 (the pruned walk): the per-group widening in a pruned walk waits for it. This is a soft line. Every box above works without it.
