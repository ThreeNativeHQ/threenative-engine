---
prd_contract: v1
---

# PRD-456 — Distant world cells stay visible after their detailed cells unload

**Status:** PROPOSED — filed 2026-09-26.  
**Priority:** P1 — Declared required by P1 PRD-458, which owns only what its prerequisites leave out; 6 open boxes, proxy cooking unbuilt.
**Complexity:** 8 → HIGH. Build-time proxy generation, package schema, two residency rings and cross-fade-free handoff must agree across web/native.  
**Related:** [PRD-253 content residency/HLOD](../BLOCKED/requires-portable-native-residency-consumer/PRD-253-content-residency-and-screen-space-hlod.md) is an older blocked proposal whose residency assumptions predate shipped WorldCells and AutoLOD. This PRD supersedes **only its distant-cell HLOD/proxy portion**; it does not duplicate its historical Phase-0 evidence.

## Problem

`WorldCells` solved near-world residency: cells enter around the followed position, build instanced
asset batches/chunks, and leave beyond the hysteresis ring. But once a detailed cell leaves, its
content disappears completely.

For a large exterior world that means the streaming radius is also the horizon. Raising the ring
pushes memory, draw and load cost back toward “keep the world resident”, which defeats the point of
cell streaming.

ThreeNative already has the ingredients this work should reuse: model compaction, AutoLOD,
world-package export/cook, bounds, shared asset identity, and the runtime cell residency state.
The missing piece is a **cell-level distant representation**.

## Outcome

The build/export path may emit one bounded proxy artifact per populated cell (or explicitly decline
one with a reason). `WorldCells` keeps detailed cells in the existing inner ring and much cheaper
proxy cells in a larger outer ring. Moving inward replaces a proxy with detailed content; moving
outward does the reverse. At no point should a cell be absent merely because its detailed form was
evicted while its proxy is in range.

V1 proxies are ordinary geometry/material data. No impostor shader, virtual texture system or
billboard appearance is introduced here.

## Decisions

- **Reuse existing model passes.** Proxy generation composes lossless flatten/join plus bounded
  simplification where eligible; it does not create a second mesh optimizer.
- **Preserve authored materials.** V1 may reduce geometry/draw topology but does not bake a new
  appearance atlas. A cell that cannot be represented safely is declined.
- **Two explicit residency classes.** Detailed and proxy residency have separate counts/bytes in
  stats and budgets. A proxy is not smuggled into the near-cell accounting.
- **No duplicate visibility during handoff.** The runtime makes one representation visible before
  retiring the other, without depending on a material cross-fade.
- **Gameplay stays on detailed content.** Proxies do not create colliders, picking targets, AI
  entities or authoritative object identity.

## Integration ledger

| Existing surface | Change |
| --- | --- |
| World export/cook | Emit optional per-cell proxy GLBs plus measured source/proxy triangle and draw counts. |
| `packages/core/src/world-package.ts` | Version the optional proxy record without invalidating v1 worlds that have none. |
| `packages/core/src/world-cells.ts` | Add outer proxy residency and deterministic detailed↔proxy handoff. |
| Asset/LOD tooling | Reuse compaction/simplification eligibility and diagnostics; do not invent a parallel reducer. |

## Phase 1 — Generate only proxies that are demonstrably cheaper

- [ ] A representative populated cell can be compiled to a proxy whose output preserves supported material boundaries/bounds and records source vs proxy triangles/draws/bytes; ineligible cells are declined with a stable reason. **proof:** asset/world fixture table includes successful and refused cells, and round-trip validation checks bounds/material identity plus the recorded reductions.
- [ ] Proxy generation is deterministic and does not add gameplay/collision/picking data. **proof:** two clean cooks hash-identically, and the proxy GLB/package record contains no collider/entity contract while the detailed cell still supplies the original gameplay objects.

## Phase 2 — Add an outer residency ring without holes or doubles

- [ ] A scripted path shows exactly one visible representation for each in-range cell: detail inside the inner ring, proxy in the outer ring, neither outside both; transitions never produce a zero-representation frame. **proof:** `world-cells.spec.ts` records per-cell representation state on both transition directions and a mutation that evicts-before-attaches fails.
- [ ] Proxy resources have independent bounded residency/refcounts and are released when they leave the outer ring. **proof:** repeated out-and-back route returns proxy/detail resource counts to baseline and never grows the asset cache with each cycle.

## Phase 3 — Prove horizon value on a real world

- [ ] A long exterior route keeps distant landmarks/world mass visible beyond the detailed ring while reducing resident detailed cells and submitted far triangles versus a large-detail-ring control. **proof:** paired route records visible proxy cells, detailed cells, triangles, draws, resident bytes and captures at fixed landmarks.
- [ ] Browser WebGPU and desktop native execute the same package and agree on cell representation states, with no failed loads and no worse hitch p95 than the large-detail-ring control. **proof:** both lane reports carry the same transition assertions plus load/hitch measurements.

## Acceptance criteria

A world can have a horizon larger than its expensive detailed-residency radius. The proxy must be
materially cheaper, lifecycle-safe and visually present when detail is absent.

If proxy generation does not reduce the representative cell's measured cost, that cell keeps the
existing WorldCells behavior; this PRD never forces an HLOD merely to claim feature parity.
