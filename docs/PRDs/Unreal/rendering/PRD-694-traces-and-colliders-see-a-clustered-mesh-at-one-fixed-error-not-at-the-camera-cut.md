---
prd_contract: v1
---

# PRD-694 — Traces and colliders see a clustered mesh at one fixed error, not at the camera cut

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 is open: two red tests decide whether `GPUSceneBVH` and a static trimesh collider read the camera cut buffer of a `ClusteredMesh`, which the code read below suggests. If a collider of a dense body is empty before the first frame, raise this PRD to P1.
**Complexity:** 4 (MEDIUM) — 1–5 implementation files (+1), a view-independent cut is a small new mechanism that reuses the DAG invariant (+1), the change crosses `packages/core` and `packages/physics` (+1), native proof on the owned host (+1); risk override: none
**Owner:** João
**Depends on:** None. Builds on the shipped cluster DAG (`packages/assets/src/virtual/dag.ts`) and `ClusteredMesh` (`packages/core/src/clustered-mesh.ts`). Composes with [PRD-603](PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md), which traces `GPUSceneBVH`, and with [PRD-695](PRD-695-a-clustered-mesh-takes-its-own-cut-in-every-view-that-draws-it.md), which owns the views that rasterize.

## Context

**Unreal size.** The fallback mesh is about 230 lines of the Nanite builder
(`Engine/Source/Developer/NaniteBuilder/Private/NaniteBuilder.cpp`), plus 665 lines that stream
fallback meshes for ray tracing (`Engine/Source/Runtime/Engine/Private/Rendering/NaniteCoarseMeshStreamingManager.cpp`),
which this PRD does not port. **Port estimate:** about 150 TypeScript lines in `packages/core`, about
20 lines in `packages/physics`, and their specs.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Every Nanite mesh carries a fallback mesh.** It is a fixed cut of the cluster DAG, built at bake
  time. Consumers that do not run the Nanite cull use it. The ray tracing proxy adopts it when it
  has no data of its own (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/StaticMesh.cpp:1861-1862`).
- **The default target is a relative error of 1.0.** The settings default to `Auto`, 100% of the
  triangles and a relative error of 1.0
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Classes/Engine/EngineTypes.h:3346-3359`). The `Auto`
  value is a read-only cvar with the same 1.0 (`NaniteBuilder.cpp:36-42`). The ray tracing proxy
  uses a relative error of 2.0 (`EngineTypes.h:3534-3552`, `NaniteBuilder.cpp:44-50`).
- **The relative error is scaled by the mesh size.** The target world error is the relative error
  times 1% of the square root of the smaller of twice the surface area and the surface area of the
  bounding box (`NaniteBuilder.cpp:786-787`).
- **The fallback is a DAG cut, then a last simplify.** The builder finds the cut at the target
  error, keeps at least 64 triangles, merges the cut into one cluster and simplifies it once more to
  the same error (`NaniteBuilder.cpp:395-415`). Material sections are rebuilt from the merged cut
  (`NaniteBuilder.cpp:835-878`).
- **A mesh the builder does not reduce keeps its source as the fallback.** The fallback counts as
  reduced when any reduction setting is active, and the relative error of 1.0 is one
  (`NaniteBuilder.cpp:913-920`). The triangle threshold below which the source is used unchanged is
  0, read-only (`NaniteBuilder.cpp:30-34`).

### ThreeNative today

- **A clustered mesh owns one index buffer: the camera cut.** At load, `#load` replaces the index
  with a buffer sized for the finest cut, filled with zeros (`packages/core/src/clustered-mesh.ts:195-206`).
  Each frame `#compact` writes the camera cut into the start of it, sets `drawRange` to its length
  and hides the mesh when the cut is empty (`clustered-mesh.ts:302-322`).
- **`GPUSceneBVH` packs what the draw range holds.** `rangesFor` reads `drawRange`
  (`packages/core/src/gpu-scene-bvh.ts:139-147`), and the scene walk skips a mesh with
  `visible === false` (`gpu-scene-bvh.ts:297-300`). The snapshot is taken at construction and on
  `rebuild()` only (`gpu-scene-bvh.ts:425-445`). So the trace holds the camera cut of that moment.
  Before the first frame it holds every finest index as zero: millions of degenerate triangles.
  It also copies every source vertex, used or not.
- **A trimesh collider reads the whole index buffer.** `geometryIndices` copies `index.count`
  entries and ignores `drawRange` (`packages/physics/src/CollisionShape3D.ts:29-36`).
  `static-colliders.ts:89` builds trimesh bodies from authored meshes. A `ClusteredMesh` is a `Mesh`,
  so a collider built before the first render is all degenerate. A collider built later holds the
  current cut plus stale entries of older cuts.
- No test covers either path for a `ClusteredMesh`.

## Solution

**The gate first (Phase 1).** Two red specs prove or disprove the read above. Then a census counts
the clustered meshes that reach `GPUSceneBVH` or a trimesh collider in templates and examples.
**Continue** if either spec is red. If both are green, record why under `## Decisions` and delete
Phases 2 and 3 (R4).

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Fallback cut at a relative error (`NaniteBuilder.cpp:786-787`, `:395-415`) | `ClusteredMesh.fallbackGeometry()` in `packages/core/src/clustered-mesh.ts`: the cut where a cluster's own world error is at or below the target and its parent's is above. Built once, on first request | core mechanism |
| Relative error default 1.0 | `fallbackRelativeError` option on the mesh, default 1.0. The target world error follows Unreal's formula from the surface area and the bounds | core mechanism |
| At least 64 triangles | the cut steps down one level while it holds fewer than 64 triangles | core mechanism |
| Ray tracing proxy adopts the fallback | `GPUSceneBVH` packs `fallbackGeometry()` for a `ClusteredMesh`, whatever its camera cut | core mechanism |
| Collision from the fallback | `CollisionShape3D.fromMesh` reads `fallbackGeometry()` when the mesh has one, and honours `drawRange` for every other mesh | physics |

- **The cut is watertight for the same reason the camera cut is.** Parent error never falls below
  child error, and siblings share one parent error, so a fixed world error picks a crack-free cut
  without a camera.
- **The geometry is compact.** It holds only the vertices its cut uses, so the trace and the
  collider do not copy every source vertex.
- **No final simplify.** Unreal simplifies the merged cut once more. The ThreeNative DAG indexes one
  shared vertex buffer, so a collapse can only remove a vertex (`packages/assets/src/virtual/dag.ts:15-18`).
  This PRD stops at the DAG cut and reports its triangle count.
- **Auto by default.** The engine picks the fallback from the mesh size. `fallbackRelativeError` is
  the named override. The mesh reports the fallback triangle count and the override in
  `TN_VIRTUAL_GEOMETRY`.
- **The look is untouched.** No material, no colour and no light changes. The camera still draws its
  own cut.

**Left out on purpose:** streaming of fallback meshes (Unreal's coarse mesh streaming manager),
because PRD-285 defers all cluster streaming, and a separate ray tracing proxy at 2.0, because
ThreeNative has one trace consumer. Revisit the proxy if PRD-603 measures the trace cost of
fallback triangles as too high.

## Acceptance Criteria

- [ ] AC-1 [local]: A `GPUSceneBVH` built from a scene with a clustered mesh holds the same triangle count before the first frame and after two different camera cuts, and that count equals the fallback cut. proof: red-green `pnpm exec vitest run packages/core/__tests__/gpu-scene-bvh.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: A trimesh collider built from a clustered mesh before its first update stops a ray cast from above at the surface, and holds no degenerate triangle. proof: red-green `pnpm exec vitest run packages/physics/__tests__/collision.spec.ts` — Evidence: pending.
- [ ] AC-3 [local]: The desktop host builds the same BVH and collider from the conformance fixture with the same triangle counts as the browser. proof: `pnpm parity --target desktop --only-tests clustered-fallback` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `ClusteredMesh.fallbackGeometry()` | `GPUSceneBVH.rebuild()` and `CollisionShape3D.fromMesh` | New. The camera cut stops feeding the trace and the collider | AC-1, AC-2 |
| `drawRange` in `CollisionShape3D.fromMesh` | `static-colliders.ts` for every authored mesh | Fixes a read past the draw range for any mesh | AC-2 |

## Decisions

- 2026-10-21 (filing): Filed from the Nanite internals read. The feature map row "Data format,
  decode, streaming" named only PRD-285, and no PRD named the fallback mesh. PRD-601 lists the
  fallback mesh as out of scope for platforms without Nanite. This PRD files it for the consumers
  that need it, not for platforms.

## Execution Phases

#### Phase 1: Do the trace and the collider read the camera cut?
**Status:** NOT STARTED
**Files:** `packages/core/__tests__/gpu-scene-bvh.spec.ts`, `packages/physics/__tests__/collision.spec.ts`
- [ ] A spec builds a `GPUSceneBVH` over a small baked clustered mesh before any update and after two camera cuts, and records the three triangle counts. proof: `pnpm exec vitest run packages/core/__tests__/gpu-scene-bvh.spec.ts`
- [ ] A spec builds a trimesh collider from the same mesh before its first update and records its degenerate triangle count. proof: `pnpm exec vitest run packages/physics/__tests__/collision.spec.ts`
- [ ] The gate verdict is written under `## Decisions`, with the clustered meshes that reach either consumer in templates and examples. proof: the two Phase 1 specs above, red or green.

#### Phase 2: One fixed cut for every non-camera consumer
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-mesh.ts`, `packages/core/src/gpu-scene-bvh.ts`, `packages/physics/src/CollisionShape3D.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`
- [ ] The fallback cut at relative error 1.0 leaves 0 open interior edges on a connected body and on a body of disconnected shells, holds at least 64 triangles, and does not change when the camera moves. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts`
- [ ] `GPUSceneBVH` and `CollisionShape3D.fromMesh` read the fallback, and the Phase 1 specs turn green. proof: `pnpm exec vitest run packages/core/__tests__/gpu-scene-bvh.spec.ts packages/physics/__tests__/collision.spec.ts`
- [ ] `TN_VIRTUAL_GEOMETRY` reports the fallback triangle count and a `fallbackRelativeError` override. proof: `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts -t fallback`

#### Phase 3: The same counts on the owned host
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/clustered-fallback.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The desktop host builds the fixture's BVH and collider with the browser's triangle counts. proof: `pnpm parity --target desktop --only-tests clustered-fallback`
**Verification:** AC-1 to AC-3.
