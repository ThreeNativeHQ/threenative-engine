# PRD-766 — Unreal-default foliage rendering for a large forest

**Status:** IN PROGRESS — phase 1 done
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

- Grass has no far representation; it ends at `EndCullDistance`. UE 5.8.3: the property and its
  "completely culled and not rendered at all" tooltip are
  Engine/Source/Runtime/Landscape/Classes/LandscapeGrassType.h:64-71, the default is
  `EndCullDistance(10000)` (100 m) in Engine/Source/Runtime/Landscape/Private/LandscapeGrass.cpp:1486-1489,
  and the component's own discard distance is the maximum over its varieties, LandscapeGrass.cpp:1266-1268.
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

- AC-1 [local]: an asset whose `maxDistance` ends inside the near ring builds no `tn-far:` mesh. proof: `pnpm exec vitest run packages/core/__tests__/world-impostors.spec.ts` — Evidence: **PASS** 49/49 on 2026-10-29 (`builds no far aggregate for an asset whose authored cull ends inside the near ring`, red first: `expected [ 'tn-far:ground_cover', …(2) ] to not include 'tn-far:ground_cover'`).
- AC-2 [local]: desktop draws alpha-tested meshes through a depth prepass, and the named override turns it off and is reported. proof: unit test in `packages/core/__tests__/` named in phase 2 — Evidence: pending.
- AC-3 [local]: far trees past the first ring draw from their ring representation, with no whole-map impostor draw for trees. proof: `pnpm exec vitest run packages/core/__tests__/world-impostors.spec.ts` — Evidence: pending.
- AC-4 [local]: Wildwood walking pose presented p95 at or under 33 ms on the RTX 2080, 2 runs, with no console errors in a 10 s walk. proof: Chrome DevTools MCP walk on `http://127.0.0.1:5174/?world=forest&stage=wildwood` — Evidence: pending.
- AC-5 [local]: visual judge NEUTRAL or IMPROVEMENT at the walking pose and the floor view (V), 2 runs per arm. proof: fresh judge subagent on before/after captures — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| No far aggregate for short-range assets | `addForest` → `WorldCells` load → `CellImpostors.#farReaches` | whole-map far mesh for those assets is not built, and their species is never loaded for the far half | AC-1 |
| Masked depth prepass | game render loop → core renderer main pass | single main pass on desktop; mobile unchanged | AC-2 |
| Far tree rings | `addForest` → world cells far representation | whole-map tree impostor draw | AC-3 |

## Execution Phases

#### Phase 1: Short-range assets get no far aggregate
**Status:** DONE
**Files:** `packages/core/src/world-cell-impostors.ts`, `packages/core/src/world-cells.ts`, `packages/core/src/world-cell-data.ts`, `packages/core/__tests__/world-impostors.spec.ts`
**Implementation:** `CellImpostors.#farReaches` skips an asset whose `cullDistance(maxDistance)` is
inside the near ring's guaranteed radius (`ring * cellSize`), in both `#buildFar` and the far-only
`pumpFarAcquisition`, so the species is neither drawn nor loaded nor baked. Named override
`impostorFar: "always"` on the load options keeps the aggregate and reports every asset it keeps as
`TN_WORLD_IMPOSTOR_FAR … reason=override override=impostorFar cull=… nearRingRadius=…`.
**Verification:** AC-1 green; Wildwood walking pose measured before and after (below); AC-5 judge
captures taken and left for the coordinator.

Wildwood, 1880x880, WebGPU (NVIDIA RTX 2080), walking pose after a 3.5 s W; each arm is one page
load, `renderer.gpuFrameMs()` median over 3 s plus the engine's own `TN_FRAME_BUDGET` windows. The
machines's GPU was saturated by other agents' runs throughout (100 % utilisation, 150-196 W), so the
absolute milliseconds are inflated and drifted between runs; the pair below is the two closest in
time (`before-b`/`before-c` then `after-a`/`after-b`).

Every arm was measured against a `packages/core/dist` rebuilt for that arm from the sources under
test — the dev server serves `dist`, never `src` — and fingerprinted afterwards: the before pair was
built at 13:38 with the fix stashed (`grep -c impostorFar dist/world.js` = 0), the after pair at
13:44 with it applied (12 matches). Two earlier runs measured before that rebuild and are discarded
as stale-dist.

| Run | `tn-far:` groups | Far instance capacity | Far bytes | Pose GPU ms | Hide-far GPU ms | Presented p95 ms | Main draws |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before-b | 17 | 1,629,200 | 110.8 MB | 70.07 | 42.98 | 83.4 | 64 |
| before-c | 17 | 1,629,200 | 110.8 MB | 59.85 | 38.13 | 100.1 | 60 |
| after-a | 8 | 38,200 | 2.6 MB | 66.08 | 41.89 | 83.4 | 47 |
| after-b | 8 | 38,200 | 2.6 MB | 69.30 | 44.53 | 83.4 | 51.3 |

- [x] AC-1: an asset whose `maxDistance` ends inside the near ring builds no `tn-far:` mesh. proof: `pnpm exec vitest run packages/core/__tests__/world-impostors.spec.ts` — Evidence: PASS 49/49, red first; three new cases (skip, `impostorFar: "always"` override + its report line, and no load at all for a species placed only outside the ring).
- [x] Phase 1 in the browser: 17 far aggregates became 8 (grass-a/b, fern-a/b, fern-group, nettle, bush, pine-young, pine-young-b gone), far instance capacity 1,629,200 -> 38,200 (-97.7 %, -108 MB of instance buffers, plus the ~25 MB of atlases and their source loads never taken), main-pass draws 64 -> 47. Frame cost of the removed species is 1-3 ms, as this PRD predicted (`before pose - hide-far` 27.1/21.7 ms is dominated by the tree impostors), so AC-4's 33 ms depends on phase 3, not here. proof: Chrome DevTools-protocol walk (`artifacts/prd766/measure.mjs`, 2 runs per arm), `TN_WORLD_IMPOSTOR_FAR` lines and `renderer.gpuFrameMs()`.
- [x] Phase 1 visual judge NEUTRAL or IMPROVEMENT at the walking pose. proof: fresh judge subagent, 2 runs per arm — Evidence: **NEUTRAL** on both after runs; the judge found no thinning and no hard ring edge, and the BEFORE runs differ from each other as much as from AFTER. Captures: `artifacts/prd766/before-pose-run{1,2}.png`, `artifacts/prd766/after-pose-run{1,2}.png`.

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
