---
prd_contract: v1
---

# PRD-677 — A dense glass or water mesh takes the cluster cut and blends like the source mesh

**Status:** NOT STARTED
**Priority:** P3 — AC-1 and AC-2 are open: no test proves that a translucent primitive keeps its blend state through the cut, and no shipped asset has been counted that needs it. Unreal ships this path off by default.
**Complexity:** 3 (LOW) — 1–5 implementation files (+1), a back-to-front cluster order in the existing compaction, gated by Phase 1 (+1), native proof (+1); risk override: none
**Owner:** João
**Depends on:** None. Builds on the cluster cut of the virtual geometry batch ([README](../../done/nanite-like/README.md)). Composes with [PRD-600](PRD-600-a-clustered-mesh-submits-only-the-clusters-the-view-holds.md): a view-pruned cut changes which clusters this PRD orders, not how it orders them.

## Context

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

Unreal size for this topic: 1,189 lines (feature map, Nanite "Translucency" row).

- **The path is off by default and marked as research.** `r.Nanite.AllowTranslucency` defaults to 0,
  and its help text calls it heavy work in progress.
  `UE 5.8.3: Engine/Source/Runtime/Engine/Private/Rendering/NaniteResources.cpp:111-115`.
- **Without it, translucency on a Nanite mesh is an error.** Only opaque and masked blend modes are
  supported (`NaniteResources.cpp:3392-3397`). The material audit marks any other blend mode as an
  error, picks the default surface material as the fallback, and logs a warning that names the
  material and the mesh.
  `UE 5.8.3: Engine/Source/Runtime/Engine/Public/Rendering/NaniteResourcesHelper.h:309-335`.
- **With it on, translucent clusters reuse the opaque culling.** A raster pass whose material is
  translucent also registers a translucency bin. The bin keeps the raster bin, the raster group and
  the offset of its indirect arguments.
  `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp:5955-5964`.
- **Each bin is one indirect hardware draw in the translucent base pass.** The draw tests depth
  (near or equal) and does not write it. It takes the material's translucent blend state and the
  responsive anti-aliasing stencil bit. There is one draw per material, with no per-cluster sort.
  `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Nanite/NaniteTranslucency.cpp:213-216`, `:326-344`, `:349-465`.
- **The visibility buffer cannot hold translucency.** That is why Unreal needs a second, hardware
  path: its main Nanite raster writes one cluster and triangle per pixel.

### What ThreeNative does today

ThreeNative has no visibility buffer. A `ClusteredMesh` is a plain three `Mesh`. Its cut is one
compacted index range drawn with the game's own material
(`#compact`, `packages/core/src/clustered-mesh.ts:302-322`). So a translucent material goes through
three's normal forward transparent pass, sorted per object like any other mesh. The Unreal problem
does not exist here by construction.

Three things are unproven:

- **The bake does not look at the material.** `bakeVirtualGeometry` skips a primitive that is not
  triangles, is skinned or is below 65,536 triangles. It never reads `alphaMode` or transmission
  (`packages/assets/src/virtual/bake.ts:167-200`). A BLEND primitive above the threshold is baked.
  No test covers it.
- **The loader swap may drop blend state.** `VirtualGeometryPlugin` builds the `ClusteredMesh` from
  `plain.material` (`clustered-mesh.ts:477-480`). No test checks that `transparent`, `depthWrite`
  and `transmission` survive the swap.
- **The cluster order inside the mesh is the table order.** The dense mesh draws its triangles in
  source order. The cut draws them in selection order. A concave translucent mesh, such as a glass
  sculpture, can blend in a different order after a re-cut. No capture has measured whether this
  is visible.

## Solution

1. **Measure first (Phase 1).** Two fixtures above the threshold: a concave glass shape
   (`alphaMode: BLEND`, double-sided) and a flat water sheet with transmission. Each bakes and
   renders as `virtual` and as `dense` at three distances. The capture records the changed-pixel
   ratio between the two arms and the triangles each arm submits. A census counts BLEND and
   transmission primitives at or above 65,536 triangles in every template and example asset.
   **Gate:** continue to Phase 2 only if the judge marks a blend-order artifact on the glass shape.
   Otherwise record "translucency works through the forward path" under `## Decisions` and delete
   the Phase 2 box (R4). The guard spec and the native box stay.
2. **Order translucent clusters back to front (Phase 2).** When `material.transparent` is true,
   `#compact` writes the selected clusters in order of decreasing distance from the camera to the
   cluster sphere centre. The camera position is already local (`#cameraLocal`), and the cut
   already re-runs when the camera moves past `recutDistance`. So the order follows the existing
   re-cut and adds no trigger. Opaque meshes keep the table order. A `sortClusters` override on the
   mesh turns the sort off, and the mesh reports the override.

**Consumer flow.** The game sets nothing. `threenative build` bakes the primitive, the loader
returns a `ClusteredMesh` with the game's material, and `updateClusteredMeshes`
(`packages/core/src/game.ts:1829`) re-cuts it. The observable result is fewer triangles for a far
translucent mesh, blended like the source mesh.

**Look is untouched.** The game's material still decides colour, opacity and transmission. The
order of clusters is mechanism, so the work lives in `packages/core/src/clustered-mesh.ts`.

**Risks:**

- A sort per re-cut costs CPU time in proportion to the drawn clusters. Phase 1 records the re-cut
  time, and the sort runs only for translucent meshes.
- Cluster order cannot fix triangles that interpenetrate inside one cluster. The dense mesh has the
  same limit.

**Left out on purpose:** a second hardware path (ThreeNative draws clusters through the forward
renderer already), per-triangle sorting, and order-independent transparency (a look decision for
the template).

## Acceptance Criteria

- [ ] AC-1 [local]: The glass and water fixtures render as `virtual` within the judged tolerance of `dense` at three distances, and the far distance submits at least 30% fewer triangles. proof: `pnpm visuals:ab --before <dense> --after <virtual> --raters 3` plus a fresh judge subagent on the same poses — Evidence: pending.
- [ ] AC-2 [local]: The desktop native host draws the translucent cut without a frame-op replay error and matches the browser within tolerance. proof: `pnpm parity --target desktop --only-tests clustered-translucent` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Translucent primitive in the cut | `threenative build` → `bakeVirtualGeometry` → `VirtualGeometryPlugin` | Unchanged path, now proven by spec | Phase 1 |
| Back-to-front cluster order | `updateClusteredMeshes` → `ClusteredMesh.update` → `#compact` | Table order stays for opaque meshes and behind `sortClusters = false` | Phase 2, AC-1 |

## Decisions

- 2026-10-21 (filing): Unreal ships this path off and calls it research. This PRD is filed as deferred work with a gate, not declined. Revisit the Phase 2 sort when a game ships a concave translucent mesh above 65,536 triangles, or when the Phase 1 judge marks an artifact.
- 2026-10-21 (filing): port size estimate. About 60 TypeScript lines for the sort and its override, 150 lines of specs and fixtures, and one native conformance scene.

## Execution Phases

#### Phase 1: Prove the forward path and measure the order
**Status:** NOT STARTED
**Files:** `packages/assets/__tests__/virtual-pass.spec.ts`, `packages/core/__tests__/clustered-mesh-loader.spec.ts`, `examples/quarry/scripts/measure.ts`
**Implementation:** the two fixtures, the census, the `virtual` against `dense` capture and the gate verdict under `## Decisions`.
- [ ] A BLEND primitive and a transmission primitive above the threshold bake, and the loaded `ClusteredMesh` keeps `transparent`, `depthWrite = false` and `transmission`. proof: red-green `pnpm exec vitest run packages/assets/__tests__/virtual-pass.spec.ts packages/core/__tests__/clustered-mesh-loader.spec.ts`
- [ ] The census of BLEND and transmission primitives at or above 65,536 triangles in templates and examples is recorded under `## Decisions`. proof: `pnpm exec vitest run packages/assets/__tests__/virtual-pass.spec.ts -t census`
- [ ] The glass and water fixtures are captured as `virtual` and `dense` at three distances, two runs per arm, with the judge verdict under `## Decisions`. proof: `pnpm --filter quarry measure -- --arm virtual --url http://127.0.0.1:5191 --fixture translucent` and a fresh judge subagent

#### Phase 2: Translucent clusters draw back to front
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-mesh.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`
**Verification:** AC-1 closes this phase.
- [ ] A translucent mesh compacts its cut far to near from the camera, an opaque mesh keeps table order, and `sortClusters = false` restores table order and is reported. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts`

#### Phase 3: Native
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/clustered-translucent.js` (new), `packages/runtime-native/conformance/registry.json`
**Verification:** AC-2 closes this phase.
- [ ] The desktop host draws the translucent glass fixture within tolerance of the browser reference. proof: `pnpm parity --target desktop --only-tests clustered-translucent`
