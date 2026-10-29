# PRD-766 — Unreal-default foliage rendering for a large forest

**Status:** NOT STARTED
**Priority:** P1 — AC-4 is open: the Wildwood forest stage walks at about 23 fps, so the large-world forest is not playable.
**Complexity:** 4 (MEDIUM)
**Owner:** João
**Depends on:** None (builds on branch `fix/pr483-audit-findings`, PR #483 follow-up)

## Context

Owner request (2026-10-29): "double check how worldstream/LOD/etc works on Unreal codebase, tune us to
behave like they do, theyre probably optimized."

`?world=forest&stage=wildwood` in `examples/strata-terrain-preview` is a 2 km map with about 53k trees
and 1.67M ground-cover placements from the owner's Landscape Pro assets (local-only, gitignored arm
`local-assets/forest-stage/wildwood/`). It walks at about 23 fps on the RTX 2080 (WebGPU, 1880x880).
Measured with Chrome DevTools MCP at the walking pose after commit `c6e2a14c4`:

| Cost | GPU ms | Method |
| --- | --- | --- |
| Whole frame | 40 to 47 | `renderer.gpuFrameMs` median over 3 s |
| Far tree impostors (`tn-far:` trees) | about 16 | hide and time |
| Near tree leaves (alpha-tested) | about 15 to 18 | hide and time |
| Far ground cover (`tn-far:` grass, ferns, nettles, bush) | about 1.5 to 3 | hide and time |

Ruled out by measurement: impostor march steps 32 to 8 (0 ms), nearest-first far order (1 ms), far tree
shadow casting (0 ms), shadow receive, alpha-to-coverage and envMap (1 to 3 ms each). Far cost scales
with pixel count. An unlit-material swap test was invalid (the swapped leaves did not draw).

Files inspected: `packages/core/src/world-cell-impostors.ts` (`#buildFar`, `#newFarMesh`,
`cullDistance`), `packages/core/src/render/world-impostor-surface.ts` (march, `mipThresholdNode`).

## Solution

Port three Unreal 5.8.3 defaults, one per phase, each measured on the Wildwood walking pose. A source
agent read these lines; re-check each cited line before building on it (licence rule in
`docs/PRDs/Unreal/README.md`: borrow algorithm and defaults, never code).

- Grass has no far representation; it ends at `EndCullDistance` (default 10000 cm).
  UE 5.8.3: Engine/Source/Runtime/Landscape/Classes/LandscapeGrassType.h:43-45.
- Desktop early depth pass: `r.EarlyZPass=3`, masked materials force a full prepass and the base pass
  reads depth. UE 5.8.3: Engine/Source/Runtime/Renderer/Private/RendererScene.cpp:137-152;
  Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp:681-700. Mobile default is off
  (`r.Mobile.EarlyZPass=0`, RendererScene.cpp:154-162).
- Far trees are HLOD rings, not one whole-map impostor draw: HLOD layer cell 25600 uu, loading range
  51200 uu, each level doubles. UE 5.8.3: Engine/Source/Runtime/Engine/Private/WorldPartition/HLOD/HLODLayer.cpp:38-39;
  WorldPartitionRuntimeHashSet.cpp:288-290.

Consumer flow: player walks the staged forest → `addForest` (kit) → core world cells, far aggregate,
render passes → `TN_FRAME_BUDGET` GPU frame and the presented frame time.

Risks: a prepass doubles vertex work for dense instancing; the ring change must not pop or thin the
horizon (visual judge per phase). Each default carries a named override on the same object and the
override is reported (`/AGENTS.md` conventions rule).

## Acceptance Criteria

- AC-1 [local]: an asset whose `maxDistance` ends inside the near ring builds no `tn-far:` mesh. proof: `pnpm exec vitest run packages/core/__tests__/world-impostors.spec.ts` — Evidence: pending.
- AC-2 [local]: desktop draws alpha-tested meshes through a depth prepass, and the named override turns it off and is reported. proof: unit test in `packages/core/__tests__/` named in phase 2 — Evidence: pending.
- AC-3 [local]: far trees past the first ring draw from their ring representation, with no whole-map impostor draw for trees. proof: `pnpm exec vitest run packages/core/__tests__/world-impostors.spec.ts` — Evidence: pending.
- AC-4 [local]: Wildwood walking pose presented p95 at or under 33 ms on the RTX 2080, 2 runs, with no console errors in a 10 s walk. proof: Chrome DevTools MCP walk on `http://127.0.0.1:5174/?world=forest&stage=wildwood` — Evidence: pending.
- AC-5 [local]: visual judge NEUTRAL or IMPROVEMENT at the walking pose and the floor view (V), 2 runs per arm. proof: fresh judge subagent on before/after captures — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| No far aggregate for short-range assets | `addForest` → `WorldCellImpostors.#buildFar` | whole-map far mesh for those assets is not built | AC-1 |
| Masked depth prepass | game render loop → core renderer main pass | single main pass on desktop; mobile unchanged | AC-2 |
| Far tree rings | `addForest` → world cells far representation | whole-map tree impostor draw | AC-3 |

## Execution Phases

#### Phase 1: Short-range assets get no far aggregate
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cell-impostors.ts`, `packages/core/__tests__/world-impostors.spec.ts`
**Implementation:** in `#buildFar`, skip an asset whose `cullDistance(maxDistance)` is inside the near
ring's guaranteed radius. Red test first.
**Verification:** AC-1; Wildwood walking pose GPU before and after (2 runs each); AC-5 judge for this phase.
- [ ] AC-1: an asset whose `maxDistance` ends inside the near ring builds no `tn-far:` mesh. proof: `pnpm exec vitest run packages/core/__tests__/world-impostors.spec.ts` — Evidence: pending.
- [ ] Phase 1 visual judge NEUTRAL or IMPROVEMENT at the walking pose. proof: fresh judge subagent, 2 runs per arm — Evidence: pending.

#### Phase 2: Masked depth prepass on desktop
**Status:** NOT STARTED
**Files:** core renderer main-pass owner (found in the phase's exploration step), one spec.
**Implementation:** depth-only pass for opaque and alpha-tested meshes, then the main pass reads depth.
Default on for desktop, off for mobile, named override reported.
**Verification:** AC-2; Wildwood walking pose GPU (2 runs per arm); AC-5 judge.
- [ ] AC-2: desktop draws alpha-tested meshes through a depth prepass, and the named override turns it off and is reported. proof: unit test in `packages/core/__tests__/` named in phase 2 — Evidence: pending.
- [ ] Phase 2 visual judge NEUTRAL or IMPROVEMENT at the walking pose. proof: fresh judge subagent, 2 runs per arm — Evidence: pending.

#### Phase 3: Far trees as HLOD rings
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cell-impostors.ts`, `packages/core/src/render/world-impostor-surface.ts`, spec.
**Implementation:** first profile the far impostor fragment with a Chrome DevTools trace. Then draw the
cooked far mesh LOD out to the first ring and impostors only past it.
**Verification:** AC-3, AC-4, AC-5.
- [ ] AC-3: far trees past the first ring draw from their ring representation, with no whole-map impostor draw for trees. proof: `pnpm exec vitest run packages/core/__tests__/world-impostors.spec.ts` — Evidence: pending.
- [ ] AC-4: Wildwood walking pose presented p95 at or under 33 ms on the RTX 2080, 2 runs, with no console errors in a 10 s walk. proof: Chrome DevTools MCP walk on `http://127.0.0.1:5174/?world=forest&stage=wildwood` — Evidence: pending.
- [ ] AC-5: visual judge NEUTRAL or IMPROVEMENT at the walking pose and the floor view (V), 2 runs per arm. proof: fresh judge subagent on before/after captures — Evidence: pending.
