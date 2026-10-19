---
prd_contract: v1
---

# PRD-453 — Streamed worlds stop pinning every instance to LOD0

**Status:** PROPOSED — filed 2026-09-26.  
**Priority:** P1 — Its own note calls it quick win #1; WorldCells still pins placements to LOD0.
**Complexity:** 5 → MEDIUM. Existing world packages already contain LOD files and the runtime already batches instances; the missing work is selection, shared loading and lifecycle.  
**Depends on:** [PRD-448 WorldCells](../done/unreal-like-features/PRD-448-world-cells-blender-export-and-streaming.md). Reuse, do not duplicate, [PRD-377 AutoLOD](../assets/PRD-377-auto-lod-is-on-by-default.md).

## Problem

This is **not an AutoLOD-generation PRD**. ThreeNative already has automatic discrete model LOD in
`packages/assets/src/lod/` and `packages/core/src/model-lod.ts`, and PRD-377 owns its default-on
qualification.

The remaining streamed-world gap is narrower and visible in the current source. A world package
already declares `assets[id].lods[]` as `{ glb, distance }`, and the committed world fixture
already contains `pine_lod1.glb`, `rock_lod1.glb` and `ground_cover_lod1.glb`. But
`WorldCells.#buildBatch()` extracts one geometry/material from `asset.glb` and builds one
`InstancedBatch`. The source explicitly records the consequence: **LOD0 only; package LODs are not
consumed**.

That means an exported forest can stream by cell while every visible tree inside those cells keeps
the full-detail geometry.

## Outcome

When a world asset has package LODs, `WorldCells` selects the appropriate authored/cooked rung for
each placement and renders one instanced batch per active rung. A game does not write a second LOD
loop, and an asset without package LODs behaves exactly as it does today.

This PRD consumes the world package's existing rungs. It does **not** generate a new LOD chain,
change PRD-377's model policy, build HLOD proxies, invent cross-fades, or make appearance decisions.

## Decisions

- **One owner per world placement.** A `WorldCells` placement whose package asset declares
  `lods[]` is selected by the world-batch path. Do not layer a second per-mesh AutoLOD controller
  inside the same instanced placement.
- **Keep instancing.** LOD selection partitions placement records into a small number of
  `InstancedBatch` objects. It must not expand a forest into one `Mesh` per tree.
- **Use the package contract already shipped.** `IWorldAssetLod.distance` is the boundary for v1.
  Do not add a second world-LOD config surface.
- **Share each rung by asset identity.** One loaded LOD geometry/material is shared by every
  resident cell that uses it, with the same refcounted teardown discipline as LOD0.
- **No pop-hiding effect in core.** Cross-fade/dither is a look decision and is out of scope.
  Selection hysteresis may prevent churn, but it must not alter material output.

## Integration ledger

| Existing surface | Change |
| --- | --- |
| `packages/core/src/world-package.ts` | Keep the v1 `IWorldAsset.lods[]` contract; strengthen validation only if a malformed ordering is currently accepted. |
| `packages/core/src/world-cells.ts` | Replace the LOD0-only asset state with shared rung states and distance-partitioned batches. |
| `packages/core/__tests__/world-cells.spec.ts` | Prove selection, sharing, eviction and no-regression for assets without LODs. |
| `packages/core/__tests__/fixtures/world-v1/` | Use the already committed LOD fixture; do not invent a toy format. |

## Phase 1 — Make the existing package LODs reachable

- [ ] Validate and normalize each asset's base rung plus ordered `lods[]`; malformed or non-monotonic boundaries fail with a named world-package error rather than silently picking a rung. **proof:** focused `world-package.spec.ts` malformed-LOD cases pass and a mutation that reverses two distances is rejected.
- [ ] Load an LOD GLB only when a resident placement can select it, and share that loaded rung across cells by asset+rung identity. **proof:** `world-cells.spec.ts` admits multiple cells using the same rung and observes one loader call and one shared teardown after the last reference leaves.

## Phase 2 — Partition placements without giving up instancing

- [ ] A mixed-distance asset run renders the expected placements in base/LOD batches, with the sum of instance counts equal to the admitted visible placements and no per-placement `Mesh` objects. **proof:** `world-cells.spec.ts` asserts rung batch counts before and after a scripted follow-path crossing the package's 60 m boundary.
- [ ] Boundary movement is stable: a small camera/follow oscillation cannot rebuild the same run every frame, while crossing far enough does switch rungs. **proof:** a deterministic oscillation fixture records bounded rebuilds, then a boundary-crossing movement changes the active rung.

## Phase 3 — Prove the quick win on the paths that already ship

- [ ] The committed world fixture runs on browser WebGPU and desktop native with matching active-rung/instance counts and zero failed loads. **proof:** the existing WorldCells scenario records rung stats on both lanes; the same assertion set passes on each.
- [ ] A representative scattered-world capture submits materially fewer far triangles than forced-LOD0 without increasing draw count beyond the number of active asset rungs. **proof:** paired fixed-route report records triangles, draws and render p50/p95 for automatic vs forced-LOD0; if the far route does not reduce submitted triangles, this PRD does not claim a performance win.

## Acceptance criteria

The feature is complete when a normal exported world that already contains LOD files gets cheaper
with distance **without game-owned LOD code**, keeps batching, shares loaded rung resources across
cells, tears them down once, and preserves current behavior for assets with no `lods[]`.

A result that merely loads `*_lod1.glb` but still draws LOD0, duplicates one model per placement,
or keeps every rung resident forever does not satisfy this PRD.
