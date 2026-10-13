# PRD-601 — Far clusters keep the shading of the source mesh

**Status:** NOT STARTED
**Priority:** P2 — The bake simplifies by position alone, and the margin over a plain decimated mesh stays at 1.7 points of changed pixels (PRD-282's own table). Phase 1 and the new defaults are both unbuilt.
**Complexity:** 4 (MEDIUM) — 1–5 implementation files (+1), the bake output changes and the compile cache version moves (+1), a visual judge is needed (+1), a measured sweep decides the defaults (+1); risk override: none
**Owner:** unassigned
**Depends on:** None. Respects the virtual geometry batch's decisions 3 and 6 ([README](../../done/nanite-like/README.md): a port of the partitioner, and a comparison at equal quality only).

## Context

The cluster DAG bake is `buildClusterDag` in `packages/assets/src/virtual/dag.ts`. It simplifies each group of clusters with `MeshoptSimplifier.simplify` (`dag.ts:453`). That call reads positions and nothing else. It keeps seams by reading the index buffer, and it locks the rim of each group (`lockFlags`, `dag.ts:257`). It never sees a normal, a tangent, a UV or a vertex color.

The consequence is on record. PRD-282 measured the quarry route against the `dense` reference. The `virtual` arm changed 40.46% of pixels and the 5%-decimated arm changed 42.18% ([PRD-282's file](../../../verification/prd-282-the-cpu-cut-2026-08-30.md)). The file names the reason: a one-pixel budget at 7.4 m allows about 8 mm of positional error, and 8 mm on a surface with centimeter grain rewrites the normals even where the silhouette holds. The same file says "a bake that weights normals through `simplifyWithAttributes`" is where more margin would come from, and the batch README lists it as open item 3 ("Weight normals in the bake"). No PRD owns it.

The repository already does this elsewhere. The discrete LOD generator packs normals, tangents, UVs and colors, and calls `simplifyWithAttributes` (`packages/assets/src/lod/generate.ts:592`, `:665`). Its packer gives every channel weight 1. The DAG bake does not use it.

Two more bake settings have never been swept. The group size is 4 (`DEFAULT_GROUP_SIZE`, `dag.ts:136`). It was chosen from a diagram, and PRD-281 recorded no measurement. A smaller group means more locked rim per group. A locked rim cannot simplify until a later level, so the cut spends triangles on seams. The option `groupSize` exists in `IModelVirtualOptions` and `partitionClusters` takes it as `targetSize` (`dag.ts:403`), so a sweep needs no new code. The simplify ratio per level is 0.5 and the cluster size is 96 to 128 triangles.

### What Unreal does (UE 5.8.3, read 2026-10-12; clean-room summary, no code copied)

- **Attributes weigh into every collapse.** The simplifier gets a weight per attribute channel. Normals weigh 1.0 on all three components. Tangents weigh 0.0625 and the tangent sign weighs 0.5. Vertex colors weigh 0.0625. UE 5.8.3: `Engine/Source/Developer/NaniteBuilder/Private/Cluster.cpp:963-992`, `:1042`.
- **UV weight follows the UV density.** Each UV channel weighs one over 128 times the average UV triangle size, so a densely mapped mesh protects its UVs more than a sparse one. Unreal can turn UV interpolation off for a mesh. UE 5.8.3: `Cluster.cpp:994-1003`.
- **Mirrored UVs are hard seams.** The builder marks a UV mirror edge as an attribute discontinuity, because the quadric cannot hold it with a sane weight. UE 5.8.3: `Cluster.cpp:938-941`.
- **Positions are rescaled before simplification.** The mesh is scaled so the average triangle edge is near 0.25 units, by changing the float exponent only. This makes the attribute weights mean the same thing on a small prop and on a cliff. UE 5.8.3: `Cluster.cpp:945-962`.
- **Attribute change enters the collapse error.** Each collapse picks a new vertex position from the edge quadric. Each wedge then adds its own attribute error to the same total. The total is the error the DAG records. UE 5.8.3: `Engine/Source/Developer/MeshSimplifier/Private/MeshSimplify.cpp:472-537`.
- **The builder sets an edge weight of 2.0, a maximum edge length factor and an attribute correction function** (for example, to renormalize normals after a collapse). UE 5.8.3: `Cluster.cpp:1043-1045`. ThreeNative cannot copy the vertex placement. Its DAG indexes one shared vertex buffer, so a collapse can only remove a vertex (`dag.ts:15-18`).
- **Groups are large.** A group holds 8 to 32 clusters. The cluster size is 128 triangles, and a merged group splits into clusters of 124 to 128 triangles. UE 5.8.3: `Engine/Source/Developer/NaniteBuilder/Private/ClusterDAG.cpp:727-728`, `:1354`, and `Cluster.h:269`.
- **Each level halves the triangles.** The number of parent clusters is the group's triangle count divided by twice the cluster size, rounded up. UE 5.8.3: `ClusterDAG.cpp:730-747`. ThreeNative's 0.5 ratio matches this.
- **The error never falls up the DAG.** A group's parent error is the larger of its children's errors and the simplifier's error. UE 5.8.3: `ClusterDAG.cpp:1441`, `:1587-1593`. ThreeNative's `parentError = max(...)` rule (`dag.ts:9`) matches this.
- **A fallback mesh exists for platforms without Nanite.** It has its own triangle percentage and relative error, defaulting to a relative error of 1.0. UE 5.8.3: `NaniteBuilder.cpp:36-41`, `:779-787`. ThreeNative has no such platform, because every host runs the cut. A fallback mesh is out of scope.

## Solution

1. **Measure first (Phase 1).** The quarry `bake` script gets flags for group size and for attribute weights. It bakes six variants of the quarry bodies:

   | Variant | Group size | Attributes |
   | --- | --- | --- |
   | A (today) | 4 | positions only |
   | B | 8 | positions only |
   | C | 16 | positions only |
   | D | 32 | positions only |
   | E | 4 | normals, weight 1 |
   | F | best of B to D | normals, weight 1 |

   For each variant the sweep records the bake summary (`bakeSeconds`, `clusters`, `levels`, `payloadBytes`, `stopReason`), the route triangles and `gpuMs` from `measure`, and the mean changed-pixel ratio against `dense` from `compare`. The quarry bodies carry normals but no UVs, so UV weights stay untested here (see Blocked on). A second spec checks whether the error that `simplifyWithAttributes` returns includes the attribute change. **Gate:** continue only if some variant lowers the mean changed-pixel ratio by at least 5% of itself (40.46% to 38.4% or lower) with route triangles no more than 10% above variant A, or lowers route triangles by at least 10% with the changed-pixel ratio no more than 0.5 points above variant A. The winner must also bake in no more than twice variant A's bake time. Otherwise record the decline under `## Decisions` and delete Phase 2 (R4).
2. **Move the defaults to the winner (Phase 2).** `buildClusterDag` takes the packed attributes and calls `simplifyWithAttributes`. The packer is `packAttributes` in `lod/generate.ts`. It is module-private today, so the change exports it and writes no second packer. The weights and the group size come from the winning variant. A game can set `groupSize` and a new `attributes: false` override on `assets.models.virtual`, and the bake summary reports an override. `VIRTUAL_BAKE_VERSION` moves from 4 to 5, so the compile cache cannot serve an old bake (`bake.ts:74`). The runtime classes do not change. The extension layout does not change.

**Consumer flow.** The game sets nothing. The model pass bakes during `threenative build`. The loader returns the same `ClusteredMesh`. The observable result is a closer match to the source mesh at the same pixel budget.

**Look is untouched.** The bake decides which triangles survive. It does not decide any material, color or light. The work stays in `packages/assets`, which already carries `meshoptimizer`.

**Risks:**

- **Position error rises.** Attribute weights trade some position accuracy for shading accuracy. If the returned error is position-only, the cut under-reports the shading loss, and the sweep's pixel ratio is the only honest judge.
- **Bake time.** Larger groups and attributes slow the bake. The quarry bake takes about 25 s today, and the gate caps the winner at twice that.
- **Payload.** A different group size changes the number of clusters and groups. The payload size is recorded in the sweep.

**Left out on purpose:** moving or interpolating vertices (`simplifyWithUpdate`), because it breaks the shared vertex buffer rule and grows the payload, and a fallback mesh, because no host lacks the cut.

## Blocked on

- A textured dense body of 65,536 triangles or more, with UVs, to test UV weights. None is tracked in the repository. The owner or a sandbox build supplies one. Until then UV weights stay at the `lod/generate.ts` default and the PRD makes no claim about UV stretch.

## Acceptance Criteria

- [ ] AC-1 [local]: On a seeded body with a crease and varied normals, the weighted bake's third-level mean normal deviation is below the position-only bake's. proof: red-green `pnpm exec vitest run packages/assets/__tests__/virtual-dag.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: On the quarry route at 1080p on a named WebGPU adapter, the `virtual` arm's mean changed-pixel ratio against `dense` falls below PRD-282's 40.46%, with route triangles no more than 10% above the old bake's. proof: `pnpm --filter quarry bake && pnpm --filter quarry compare -- --reference artifacts/quarry/dense --candidate artifacts/quarry/virtual` — Evidence: pending.
- [ ] AC-3 [local]: The cut leaves 0 open interior edges at every threshold of the sweep, on a connected body and on a body of disconnected shells, with the new defaults. proof: `pnpm exec vitest run packages/assets/__tests__/virtual-dag.spec.ts packages/assets/__tests__/virtual-pass.spec.ts` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Attribute-aware group simplification | `modelPass` calls `bakeVirtualGeometry` during `threenative build` (`packages/assets/src/passes/model.ts:991`) | The position-only `MeshoptSimplifier.simplify` call in `dag.ts` is replaced | AC-1, AC-2 |
| Group size from the sweep | The same bake, through `assets.models.virtual.groupSize` | The fixed default of 4 moves to the winner and stays overridable | AC-2, AC-3 |
| Bake version 5 | The compile cache key | Version 4 entries stop being served | AC-3 |

## Execution Phases

#### Phase 1: Sweep the bake settings on the quarry
**Status:** NOT STARTED
**Files:** `examples/quarry/scripts/bake.ts`, `packages/assets/__tests__/virtual-dag.spec.ts`
**Implementation:** flags for group size and attribute weights on the quarry bake, six baked arms, and a spec on the returned error. The sweep table and the gate verdict go under `## Decisions`.
- [ ] The six variants are baked and measured, and the table of bake summary, route triangles, `gpuMs` and changed-pixel ratio is recorded here. proof: `pnpm --filter quarry bake`, `pnpm --filter quarry measure -- --arm virtual --url http://127.0.0.1:5191` and `pnpm --filter quarry compare -- --reference artifacts/quarry/dense --candidate artifacts/quarry/virtual`, once per variant
- [ ] The spec states whether the returned simplify error includes attribute change. proof: `pnpm exec vitest run packages/assets/__tests__/virtual-dag.spec.ts`

#### Phase 2: The winning settings become the defaults
**Status:** NOT STARTED
**Files:** `packages/assets/src/virtual/dag.ts`, `packages/assets/src/virtual/bake.ts`, `packages/assets/src/lod/generate.ts`, `packages/assets/__tests__/virtual-dag.spec.ts`, `packages/assets/__tests__/virtual-pass.spec.ts`
**Implementation:** pack attributes, call `simplifyWithAttributes`, set the winning group size, add the `attributes: false` override with its report line, and bump `VIRTUAL_BAKE_VERSION` to 5.
**Verification:** AC-1, AC-2 and AC-3 close this phase. The visual judge from the root `AGENTS.md` compares the six route frames before and after, with at least two runs per arm.
- [ ] The new defaults bake, the report names an override when one is set, and a version 4 cache entry is not served. proof: `pnpm exec vitest run packages/assets/__tests__/virtual-pass.spec.ts`
- [ ] The rebaked quarry runs its route on the desktop host with no frame-op replay error. proof: `pnpm --filter quarry build:desktop && pnpm --filter quarry pack:native && pnpm --filter quarry measure -- --arm virtual --target desktop`
