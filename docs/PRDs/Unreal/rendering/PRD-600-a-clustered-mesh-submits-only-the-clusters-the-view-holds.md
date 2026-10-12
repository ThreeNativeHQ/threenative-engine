# PRD-600 — A clustered mesh submits only the clusters the view holds

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 measurement gate, the view-pruned cut and the copy cull are all unbuilt, and the share of submitted triangles outside the view is unmeasured.
**Complexity:** 6 (MEDIUM) — 1–5 implementation files (+1), a hierarchical walk is a new mechanism (+2), a view-dependent cut adds recut and popping risk (+2), native proof on the owned host (+1); risk override: none
**Owner:** unassigned
**Depends on:** None. Respects [PRD-490](../../open-world/PRD-490-cluster-lod-wins-on-native.md) (draw count on native, a separate outcome), [PRD-489](../../done/PRD-489-gpu-scene-occlusion-culling.md) (occlusion culling stays declined) and the virtual geometry batch's rule 1 ([README](../../done/nanite-like/README.md): the game's material draws every cluster).

## Context

Virtual geometry is on by default for any primitive of 65,536 triangles or more. The cut has two parts. Both ignore the view.

- **The cut is a flat scan.** `selectClusterCut` (`packages/core/src/clustered-mesh.ts:113`) tests every cluster in the table, one after the other. Its cost follows the size of the asset, not the size of the cut. The quarry bakes 57,041 clusters over 16 levels. The walk costs about 0.7 ms on the browser and about 1.1 ms on the native host ([PRD-283's file](../../../verification/prd-283-native-and-the-kernel-2026-08-30.md)). A game asset ten times larger pays ten times more, even when the camera sees a corner of it.
- **The cut has no view volume.** `ClusteredMesh.update` re-cuts only when the camera moves more than `recutDistance` or the pixel scale changes (`clustered-mesh.ts:285`). A cluster behind the camera is submitted if its error projects to under one pixel. The table carries `bounds`, `cones` and `clusterGroups`. The loader reads `bounds` only to find the mesh radius (`clustered-mesh.ts:344`), reads `cones` into a field nothing uses, and does not read `clusterGroups` at all (`TABLE_FIELDS`, `clustered-mesh.ts:406`).
- **A batch draws every copy.** `ClusteredBatch` sets `mesh.frustumCulled = false` on every distance band (`packages/core/src/clustered-batch.ts:486`) and puts every placed copy in a band (`update`, `clustered-batch.ts:235`). `RenderCameraCull` skips any object with `frustumCulled = false` on purpose (`packages/core/src/render-camera-cull.ts:277`), so nothing else culls these copies. A copy behind the camera is drawn. It can also set the cut of its band, because each band is cut at its nearest member (`#drawGroup`, `clustered-batch.ts:347`). The quarry places 396 boulder copies.

The quarry is bound on vertex and raster work ([quarry README](../../../../examples/quarry/README.md)). The `virtual` arm submits 7.1 million triangles at 1.28 ms of GPU time on the browser. It costs 3.05 ms on native at 720p ([PRD-490](../../open-world/PRD-490-cluster-lod-wins-on-native.md)). No number says how many of those triangles lie outside the view. This PRD measures that number first.

The GPU scene already tests placements against the six frustum planes in one compute dispatch (`cameraPlanes`, `packages/core/src/world-gpu-scene.ts:1310`). Clustered meshes are not part of it. PRD-283 declined a GPU cut kernel because the CPU walk was not the cost that mattered. This PRD stays on the CPU. It changes what the CPU walk visits, not where it runs.

### What Unreal does (UE 5.8.3, read 2026-10-12; clean-room summary, no code copied)

- **Culling happens per node, and a failed node is never expanded.** The node pass builds the node box, rejects it by distance and global clip plane, tests the LOD rule, and only then tests the frustum (and the depth pyramid). A node that fails removes its whole subtree. UE 5.8.3: `Engine/Shaders/Private/Nanite/NaniteClusterCulling.usf:478-499`.
- **The LOD rule runs on nodes too.** A node is expanded only while the error of the parent group, scaled by the view, still projects to more than the threshold. This is the same idea as ThreeNative's `parentError` test, applied one level up so the walk skips whole branches. The test also writes a streaming priority equal to the threshold divided by the projected scale. UE 5.8.3: `NaniteClusterCulling.usf:258-285`.
- **The cluster test repeats both checks.** A cluster is drawn when it is small enough (`SmallEnoughToDraw`) and it passes its own frustum test. UE 5.8.3: `NaniteClusterCulling.usf:287-310`, `:806`, `:858`.
- **The frustum test is a box test with plane-crossing flags.** A box that crosses the near or far plane is marked as needing clipping. UE 5.8.3: `Engine/Shaders/Private/Nanite/NaniteCullingCommon.ush:527-533`.
- **The tree is a BVH of fan-out four.** UE 5.8.3: `Engine/Shaders/Shared/NaniteDefinitions.h:103-106`.
- **The default traversal walks one tree level per dispatch.** It reads the node count of each level from an indirect-argument buffer. UE 5.8.3: `Engine/Shaders/Private/Nanite/NaniteHierarchyTraversal.ush:368-411`.
- **The persistent-thread kernel is off by default.** The cvar text says it does not scale with GPU size, relies on scheduler behavior, and is not recommended for non-fixed hardware. UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp:322-328`. WebGPU gives no forward-progress guarantee between workgroups, so ThreeNative does not copy it.
- **Nanite does not cull clusters by normal cone.** The only cone code in the Nanite shaders bounds displacement (UE 5.8.3: `Engine/Shaders/Private/Nanite/NaniteSplit.usf:21-37`, `:183-188`). Back faces are rejected per triangle in the rasterizer (UE 5.8.3: `Engine/Shaders/Private/Nanite/NaniteRasterizer.ush:28-52`). ThreeNative's baked `cones` stay unused and this PRD does not add a cone test.
- **The pixel threshold matches ThreeNative's.** `r.Nanite.MaxPixelsPerEdge` defaults to 1.0 and sets the LOD scale from the view height. UE 5.8.3: `NaniteCullRaster.cpp:133-139` and `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShared.cpp:195-203`. There is no gap to close in `errorPixels`.

## Solution

The change has three steps. Step 1 decides whether steps 2 and 3 continue.

1. **Measure first (Phase 1).** Add read-only counters to `ClusteredMesh` and `ClusteredBatch`. They count the submitted triangles whose cluster bounds lie fully outside the camera frustum, and the batch copies outside it. Nothing is culled. The quarry `measure` script prints them next to `gpuMs`. A second case tiles the quarry cliff table to 1, 2, 4 and 8 times its size and times the flat scan, so the cost of asset size is a number. A third number is the cost of one re-cut: the `#compact` copy and the index upload (`clustered-mesh.ts:302`) in milliseconds and in megabytes per second along the route. **Gate:** continue only if the outside-view share of submitted triangles, times the route-median `virtual` `gpuMs`, plus the flat-scan milliseconds saved by a pruned walk, is at least 0.25 ms on the browser at 1080p or on native at 720p. Otherwise record the decline under `## Decisions` and delete Phases 2 and 3 (R4).
2. **Cull the copies of a batch (Phase 2).** `ClusteredBatch.update` tests each copy's bounding sphere against the camera frustum before it assigns a band. A copy outside the frustum joins no band and anchors no cut. The test uses three's `Frustum` (the same helper `RenderCameraCull` uses). It runs in `packages/core/src/clustered-batch.ts`. The recut trigger gains a rotation term, because turning the camera changes which copies are in view. A batch built with `castShadow: true` keeps every copy, because a copy outside the main view can still cast into it. The batch reports `viewCull: "off (castShadow)"` in that case.
3. **Prune the cut of a mesh by view (Phase 3).** The loader reads `clusterGroups`. For each cluster this gives the group that folded it (`group`) and the group that produced it (`sourceGroup`). Inverting `sourceGroup` once at load gives the children of every group. The new walk starts at the root clusters. For each cluster it applies the existing own-error and parent-error tests, then descends into the children of its `sourceGroup` only while the parent-error test still fails and the group sphere touches the widened frustum. A group sphere contains every descendant, so it is a safe subtree bound. Sibling parent clusters share one group, so a stamp visits each group once. `selectClusterCut` stays unchanged as the oracle that the new walk is graded against, as PRD-283 did for its kernel. The frustum is widened by a `viewMargin` so a small camera turn does not force a re-cut. The margin is the one constant this PRD admits. Phase 1 picks its default from the measured re-cut cost, the object reports it, and the game can override it. A mesh with `castShadow` keeps the unpruned cut until [PRD-602](PRD-602-a-clustered-shadow-caster-draws-what-its-shadow-texel-resolves.md) gives shadows their own cut.

**Consumer flow.** The game does nothing. The engine already calls `updateClusteredMeshes` before every render (`packages/core/src/game.ts:1749`). That call reaches `ClusteredMesh.update` and `ClusteredBatch.update`, which now prune by view. The observable result is a lower `drawnTriangles` and `drawnClusters` for a camera that sees part of a mesh, with the same pixels on screen.

**Look is untouched.** The game's material still draws every cluster. Nothing here decides how anything looks, so the work lives in `packages/core/src/` as mechanism.

**Risks:**

- **Popping.** A turn must never reveal a missing cluster. The margin plus the rotation re-cut term prevent it. The oracle spec checks it on 200 seeded poses.
- **Other cameras.** The engine cuts for the render camera only. A mirror or portal camera that sees a pruned mesh would show holes. A mesh can set `viewCull = false`, and the object reports the override. The guide `docs/guides/api.md` names this limit.
- **Native.** The change is plain TypeScript in `packages/core`, so the host runs it unchanged. The claim still needs its own native run.

**Left out on purpose:** persistent-thread culling (off by default in Unreal and unsafe on WebGPU), a normal-cone test (Unreal has none), and a depth-pyramid occlusion pass (PRD-284 and PRD-489 declined it on measurement).

## Acceptance Criteria

- [ ] AC-1 [local]: The pruned walk selects exactly the clusters the flat oracle selects that touch the widened frustum, with 0 differences over 200 seeded camera poses, and a stationary camera turned by less than the margin keeps its cut. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts packages/core/__tests__/clustered-batch.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: On the quarry route at 1080p on a named WebGPU adapter, the `virtual` arm submits at least half of the outside-view share of triangles fewer than before (share recorded by Phase 1), `gpuMs` does not rise, and 0 console errors occur. proof: `pnpm --filter quarry measure -- --arm virtual --url http://127.0.0.1:5191`, compared with the Phase 1 numbers — Evidence: pending.
- [ ] AC-3 [local]: The same route on the desktop host shows fewer submitted triangles with no frame-op replay error. proof: `pnpm --filter quarry build:desktop && pnpm --filter quarry pack:native && pnpm --filter quarry measure -- --arm virtual --target desktop` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Copy cull in `ClusteredBatch` | `updateClusteredMeshes` (`game.ts:1749`) calls `ClusteredBatch.update` every frame | The "draw every copy" path stays only behind `castShadow` and `viewCull = false` | AC-2, AC-3 |
| View-pruned hierarchical cut | The same call reaches `ClusteredMesh.update` | `selectClusterCut` stays as the oracle and as the path for `viewCull = false` | AC-1, AC-2 |
| `clusterGroups` read at load | `GLTFLoader` plugin reading `TN_virtual_geometry` | The baked but unread accessor gets its first reader | AC-1 |

## Execution Phases

#### Phase 1: Measure what the view holds
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-mesh.ts`, `packages/core/src/clustered-batch.ts`, `examples/quarry/scripts/measure.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`
**Implementation:** read-only counters for outside-view triangles and copies, the tiled-table scan timing, and the re-cut cost in milliseconds and megabytes per second. The gate verdict goes under `## Decisions`.
- [ ] The quarry route reports the outside-view share of submitted triangles (single meshes and batch copies apart) and the re-cut cost on the browser and on native. proof: `pnpm --filter quarry measure -- --arm virtual --url http://127.0.0.1:5191` and the same command with `--target desktop`
- [ ] The flat-scan time is recorded for the quarry cliff table at 1, 2, 4 and 8 times its size. proof: `TN_BENCH=1 pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts`

#### Phase 2: A batch skips the copies the camera cannot see
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-batch.ts`, `packages/core/__tests__/clustered-batch.spec.ts`
**Implementation:** the per-copy sphere test, the rotation term in the recut trigger, and the `castShadow` guard with its report.
**Verification:** AC-1 (batch half) and AC-2 close this phase. The visual judge from the root `AGENTS.md` compares route frames before and after.
- [ ] A copy behind the camera is not drawn and does not set its band's cut. A `castShadow` batch keeps every copy and reports it. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-batch.spec.ts`

#### Phase 3: A mesh walks its hierarchy and prunes by view
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-mesh.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`, `packages/core/__tests__/clustered-mesh-loader.spec.ts`, `docs/guides/api.md`
**Implementation:** the loader reads `clusterGroups` and builds child lists. The pruned walk, the widened frustum, the rotation re-cut and the `viewCull` override with its report follow. The guide states the margin and the mirror-camera limit.
**Verification:** AC-1 and AC-3 close this phase. The visual judge compares route frames, with a camera turn mid-route.
- [ ] The pruned walk matches the oracle on 200 seeded poses and a turn inside the margin does not re-cut. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts`
- [ ] The quarry cliff walk time falls with the share of the view it sees, and the desktop route shows the same selection. proof: `pnpm --filter quarry measure -- --arm virtual --target desktop`
