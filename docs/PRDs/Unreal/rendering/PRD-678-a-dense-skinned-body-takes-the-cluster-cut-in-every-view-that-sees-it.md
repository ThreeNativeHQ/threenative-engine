---
prd_contract: v1
---

# PRD-678 — A dense skinned body takes the cluster cut in every view that sees it

**Status:** NOT STARTED
**Priority:** P3 — AC-1 to AC-3 are open: a skinned primitive above 65,536 triangles skips the bake and draws every triangle at every distance. Phase 1 has not counted which games carry such a body.
**Complexity:** 6 (MEDIUM) — 1–5 implementation files (+1), the bake output and the extension layout change (+2), posed cluster bounds are a new mechanism (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-486](../../open-world/PRD-486-characters-get-a-lod-chain.md) (optional: its discrete chain is the baseline Phase 1 measures against. Without it, Phase 1 compares against LOD0 and says so). Coordinate with [PRD-570](../../done/PRD-570-a-character-costs-what-the-camera-sees-of-it.md), which owns how often a rig animates, and with [PRD-600](PRD-600-a-clustered-mesh-submits-only-the-clusters-the-view-holds.md), whose view-pruned walk this cut reuses when it lands.

## Context

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

Unreal size for this topic: 1,129 lines (feature map, Nanite "Visibility, skinning, ownership" row).
It holds three separate mechanisms.

- **Material visibility.** A CPU pre-pass tests each Nanite primitive's world box against every view
  frustum. A raster bin or shading bin that no visible primitive uses is skipped. The switch
  `r.Nanite.MaterialVisibility` defaults to 0 (off). Per-instance tests default to off too.
  `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Nanite/NaniteVisibility.cpp:9-50`, `:222-262`.
- **Ownership visibility.** A primitive can be hidden from its owner's view (owner-no-see) or shown
  only in its owner's view (only-owner-see). A scene extension tracks only the Nanite primitives
  with either flag (`NaniteOwnershipVisibilitySceneExtension.cpp:29`). Each frame it builds one bit
  per primitive per view, and editor views never hide anything (`:95-117`). Instance culling reads
  the bit and drops the instance in that view only.
  `UE 5.8.3: Engine/Shaders/Private/Nanite/NaniteInstanceCulling.usf:330-336`.
- **Skinned clusters.** Support is compiled in by default (`r.Nanite.AllowSkinnedMeshes` = 1,
  `Engine/Source/Runtime/Engine/Private/Rendering/NaniteResources.cpp:105-109`). Each mesh asset
  still opts in, because Nanite settings default to off
  (`Engine/Source/Runtime/Engine/Classes/Engine/EngineTypes.h:3284-3286`, `:3388-3389`).
  - Each cluster stores up to 16 bone influences, and each hierarchy node stores up to 16 bones.
    `UE 5.8.3: Engine/Shaders/Shared/NaniteDefinitions.h:33-34`.
  - A skinned cluster's culling box is the union of its bind box moved by each influencing bone.
    `UE 5.8.3: Engine/Shaders/Private/Nanite/NaniteVertexDeformation.ush:255-278`. A hierarchy node
    does the same with its own bone list, and a cluster with no influences takes the instance box.
    `Engine/Shaders/Private/Nanite/NaniteClusterCulling.usf:171-226`.
  - Per view, an instance deforms only while its projected size is at least a minimum screen size.
    The default is 0.1 (`r.Skinning.DefaultAnimationMinScreenSize`). A negative value deforms in
    every view. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Skinning/SkinningSceneExtension.cpp:113-119`
    and `Engine/Shaders/Private/Nanite/NaniteSkinningUpdateViewData.usf:144-176`.

### What ThreeNative does today

- **Material visibility ships by construction.** three draws each mesh as its own draw call, and the
  renderer frustum-culls each object before it submits it. There are no shared material bins to
  skip, so the Unreal pre-pass has no work to do here.
- **Ownership visibility ships through `Object3D.layers`.** A camera draws only objects that share a
  layer bit with it. The virtual shadow map already uses this to give shadow levels their own
  casters (`packages/core/src/render/virtual-shadow.ts:1943-1959`). The native host tests the same
  mask (`packages/runtime-native/src/engine/scene/object3d.h:127`, and per shadow caster in
  `packages/runtime-native/src/engine/renderer/renderer.cpp:2266-2269`). No test proves that a
  `ClusteredMesh` keeps this rule after a re-cut.
- **Skinned clusters do not exist.** The bake skips any primitive with `JOINTS_0`, because the
  loader's clustered mesh is a plain `Mesh` and would lose its skin
  (`packages/assets/src/virtual/bake.ts:172-181`). The loader also skips a `SkinnedMesh` baked by an
  older bake (`packages/core/src/clustered-mesh.ts:468-470`). So a skinned body at or above 65,536
  triangles draws every triangle at every distance.

The subject on record is the licensed MetaHuman specimen at 101,518 triangles
(`../sandbox/metahuman-lab/content/specimen.glb`, local only, from PRD-486's table). The shipped
mannequin has 13,744 triangles, under the threshold. PRD-486 gives skinned bodies a discrete LOD
chain. A cluster cut can beat a chain only on a body large enough that one part is near and another
part is far, such as a large creature, or on a body above the threshold.

## Solution

1. **Measure first (Phase 1).** Count skinned primitives at or above 65,536 triangles in templates,
   examples and the sandbox games. Bake the specimen with a test-only flag that admits skinned
   primitives, and select a bind-pose cut at 2, 10 and 40 m. Record its triangles beside LOD0 and
   beside the PRD-486 chain level picked at the same distance, if that chain has landed. Prove the
   layer rule for a `ClusteredMesh` on web and native. **Gate:** continue only if the cut submits at
   least 25% fewer triangles than the baseline at one distance or more, and a game in the repository
   or the sandbox ships a skinned body above the threshold. Otherwise record the result under
   `## Decisions`, delete Phases 2 and 3 (R4), and keep the revisit condition below.
2. **Bake and load skinned cuts (Phase 2).** The bake admits skinned primitives. Levels are
   index-only views over the source vertices, so `JOINTS_0` and `WEIGHTS_0` stay valid at every
   level. Each cluster also stores its bone list, at most 16 bones as in Unreal. A cluster with more
   bones falls back to the mesh bounds and the bake summary counts it. `VIRTUAL_BAKE_VERSION` moves
   up one, so the compile cache cannot serve an old bake. The loader keeps the `SkinnedMesh` with
   its skeleton and bind matrix, and gives its geometry a cut through the existing `withOwnCut`
   helper (`clustered-mesh.ts:332`).
3. **Posed cluster bounds (Phase 2).** At each re-cut, a skinned cluster's sphere is the union of
   its bind sphere moved by each bone in its list. The existing own-error and parent-error tests
   then run unchanged. The work is proportional to the drawn clusters times their bones, and it runs
   only on a re-cut.

**Consumer flow.** The game sets nothing. `threenative build` bakes the body, `ctx.assets.model()`
returns the `SkinnedMesh` with a cut, and `updateClusteredMeshes`
(`packages/core/src/game.ts:1829`) re-cuts it each frame it needs one. The observable result is a
lower `drawnTriangles` for a far skinned body, with the same pose on screen.

**Look is untouched.** The cut decides which triangles draw, not how they look. The work lives in
`packages/assets/src/virtual/` and `packages/core/src/clustered-mesh.ts`.

**Risks:**

- **A stale pose between re-cuts.** A limb that moves without a camera move keeps the old cut. The
  error is bounded by the pixel threshold of the clusters it already holds. The judge checks a fast
  clip.
- **The skinned palette batch.** `SkinnedBatch` (`packages/core/src/projection-skinned.ts`) shares
  one geometry across rigs. A per-rig cut cannot join that batch. A rig with a cut draws alone, and
  the report says so.

**Left out on purpose:** the material-visibility pre-pass (three has no material bins), a second
ownership mechanism (`Object3D.layers` is the mechanism), and voxel skinning.

## Acceptance Criteria

- [ ] AC-1 [local]: The specimen at 40 m submits at least 25% fewer triangles than the baseline, with no visible loss judged at 2, 10 and 40 m. proof: `pnpm visuals:ab --before <baseline> --after <skinned cut> --raters 3` plus a fresh judge subagent on the same poses — Evidence: pending.
- [ ] AC-2 [local]: A skinned cut under a fast clip shows no missing triangles across 200 seeded poses. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts` — Evidence: pending.
- [ ] AC-3 [local]: The desktop native host draws the skinned cut within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests clustered-skinned` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Layer rule on a cut | camera and shadow-level `layers` → three render list → `ClusteredMesh` | Unchanged mechanism, now proven | Phase 1 |
| Skinned bake | `threenative build` → `bakeVirtualGeometry` | Removes the `JOINTS_0` skip at `bake.ts:172-181` | Phase 2 |
| Skinned cut at load | `VirtualGeometryPlugin` → `SkinnedMesh` with a cut | Removes the skinned skip at `clustered-mesh.ts:468-470` | Phase 2, AC-2 |

## Decisions

- 2026-10-21 (filing): Unreal's per-view minimum animation screen size (0.1) belongs to PRD-570, which owns how often a rig animates. PRD-570 picks update rates by screen size today but has no rule that stops deforming below a size. That is a gap for PRD-570, not a box here.
- 2026-10-21 (filing): revisit condition if the Phase 1 gate fails. A game ships a skinned body at or above 65,536 triangles, or PRD-486's chain leaves a measured triangle gap on a large creature.
- 2026-10-21 (filing): port size estimate. About 300 TypeScript lines for the bake, the loader and the posed bounds, 200 lines of specs, and one native conformance scene.

## Execution Phases

#### Phase 1: Count the bodies and measure the cut
**Status:** NOT STARTED
**Files:** `packages/assets/__tests__/virtual-pass.spec.ts`, `packages/runtime-native/conformance/scenes/shared/clustered-layers.js` (new), `packages/runtime-native/conformance/registry.json`
**Implementation:** the census, the test-only skinned bake of the specimen, the three-distance triangle table and the gate verdict under `## Decisions`.
- [ ] The census of skinned primitives at or above 65,536 triangles is recorded under `## Decisions`. proof: `pnpm exec vitest run packages/assets/__tests__/virtual-pass.spec.ts -t "skinned census"`
- [ ] The specimen's bind-pose cut, LOD0 and the baseline chain level are recorded in triangles at 2, 10 and 40 m. proof: `pnpm exec vitest run packages/assets/__tests__/virtual-pass.spec.ts -t "skinned cut"` with `TN_SPECIMEN` set to the local file
- [ ] A `ClusteredMesh` on a layer the main camera lacks draws in a shadow level that enables the layer and not in the main pass, on the browser and on the desktop host. proof: `pnpm parity --target desktop --only-tests clustered-layers`

#### Phase 2: Bake and load skinned cuts with posed bounds
**Status:** NOT STARTED
**Files:** `packages/assets/src/virtual/bake.ts`, `packages/assets/src/virtual/dag.ts`, `packages/assets/src/virtual/extension.ts`, `packages/core/src/clustered-mesh.ts`, `packages/assets/__tests__/virtual-dag.spec.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`, `packages/core/__tests__/clustered-mesh-loader.spec.ts`
**Verification:** AC-2 closes this phase.
- [ ] A skinned primitive bakes with a bone list per cluster, every level shares `JOINTS_0` and `WEIGHTS_0`, and a cluster with more than 16 bones is counted in the summary. proof: red-green `pnpm exec vitest run packages/assets/__tests__/virtual-dag.spec.ts packages/assets/__tests__/virtual-pass.spec.ts`
- [ ] The loaded `SkinnedMesh` keeps its skeleton, and its posed cut matches an oracle that skins every vertex on 200 seeded poses. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts packages/core/__tests__/clustered-mesh-loader.spec.ts`

#### Phase 3: Judge and native
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/clustered-skinned.js` (new), `packages/runtime-native/conformance/registry.json`
**Verification:** AC-1 and AC-3 close this phase.
- [ ] The specimen at 2, 10 and 40 m shows no visible loss against the baseline, two runs per arm, judged by a fresh subagent. proof: `pnpm visuals:ab --before <baseline> --after <skinned cut> --raters 3`
- [ ] The desktop host draws the skinned cut fixture within tolerance of the browser reference. proof: `pnpm parity --target desktop --only-tests clustered-skinned`
