---
prd_contract: v1
---

# PRD-668 — A displaced surface changes its silhouette near the camera

**Status:** Phase 1 DONE, gate FAILED (2026-11-14). Phases 2 and 3 are deferred.
**Priority:** P3 — Phase 1 is an unbuilt cost gate. No game or template asks for displacement today, and a fresh Unreal project leaves it off on every material.
**Complexity:** 7 (HIGH) — 1–5 implementation files (+1), a compute dice pass that feeds an indirect draw is a new mechanism (+2), crack-free edges between triangles of different density (+2), a visual judge (+1), native proof on the owned host (+1); risk override: none
**Owner:** João
**Depends on:** None. Uses [PRD-600](../../done/PRD-600-a-clustered-mesh-submits-only-the-clusters-the-view-holds.md)'s view-pruned cut when it has shipped, and the flat cut when it has not. Respects [PRD-601](PRD-601-far-clusters-keep-the-shading-of-the-source-mesh.md) (the bake keeps the source UVs that displacement samples) and [PRD-602](PRD-602-a-clustered-shadow-caster-draws-what-its-shadow-texel-resolves.md), which left displacement in shadows to this PRD.

## Context

**Unreal size.** Tessellation and displacement live inside Nanite (55,672 lines in the feature map).
The four files that own them hold about 2,000 lines: `NaniteTessellation.ush`, `NaniteDice.ush`,
`NaniteSplit.usf` and `TessellationTable.cpp`. A ThreeNative port is about 700 TypeScript lines
plus about 300 C++ lines for the owned host.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **The runtime switch is on, but each material opts in.** `r.Nanite.Tessellation` defaults to 1
  (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp:93-102`). It works
  only with the programmable and compute rasterizers
  (`Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp:1411-1423`). A material must set
  `bEnableTessellation`, which is the flag that displacement needs
  (`Engine/Source/Runtime/Engine/Public/Materials/Material.h:585-587`). So a fresh project
  displaces nothing until an artist ticks that box.
- **Displacement is a scalar with a magnitude and a center.** The defaults are a magnitude of 4
  (centimetres) and a center of 0.5, so a texel of 0.5 does not move the surface
  (`Engine/Source/Runtime/Engine/Classes/Engine/EngineTypes.h:3446-3458`).
- **The dice target is 2 pixels per micro-triangle edge.** `r.Nanite.DicingRate` defaults to 2.0
  (`NaniteCullRaster.cpp:147-152`).
- **Each triangle gets one factor per edge.** The factor is the edge length divided by the nearer
  view depth of its two ends, scaled by the view LOD scale and divided by the dice rate. Past a
  fade distance, the factor drops to a quarter
  (`Engine/Shaders/Private/Nanite/NaniteTessellation.ush:62-101`).
- **Displacement fades out by its projected size.** The fade starts when the largest displacement
  projects to 4 pixels and ends at 1 pixel (`EngineTypes.h:3480-3504`). The fade distance solves
  for the view depth where the largest displacement equals that size
  (`NaniteTessellation.ush:49-59`).
- **A precomputed table holds every pattern.** The table covers edge-factor triples up to 14 and
  stores the barycentric vertices and triangles of each pattern
  (`Engine/Shaders/Shared/NaniteDefinitions.h:125`, `Engine/Source/Runtime/Renderer/Private/Nanite/TessellationTable.cpp:25-125`).
  A larger factor splits the triangle into sub-patches first (`NaniteTessellation.ush:103-106`).
  Shared edges snap their vertices, so two triangles with the same edge factor meet without a crack
  (`TessellationTable.cpp:184-205`).
- **Bounds grow by the displacement range.** Culling widens each box along the normal cone by the
  smallest and largest displacement before the test
  (`Engine/Shaders/Private/Nanite/NaniteSplit.usf:21-37`).
- **The work queue is bounded.** At most 5 patches go to one rasterizer group
  (`NaniteCullRaster.cpp:154-158`).

### ThreeNative today

- three.js applies `displacementMap` per vertex. It cannot add vertices, so a coarse mesh moves
  only at its existing vertices. WebGPU has no tessellation stage.
- `ClusteredMesh` cuts a baked cluster DAG on the CPU into one index buffer over the source
  vertices (`packages/core/src/clustered-mesh.ts:113`, `:158`). The source UVs stay available.
- `projection-plan.ts:132-148` and `projection-skinned.ts:93-95` treat a material with a
  `displacementMap` or a `positionNode` as one that moves its own vertices. No package code adds
  vertices for displacement.
- No template or example uses `displacementMap` (`rg displacementMap packages/create-threenative/templates examples`, 2026-10-21).

## Solution

**Dice in compute, rasterize in hardware.** WebGPU lacks the 64-bit image atomics that Unreal's
software rasterizer needs. So the dice pass writes micro-triangles into a storage buffer, and one
indirect draw rasterizes them with the hardware rasterizer.

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Pattern table (`TessellationTable.cpp`) | `packages/core/src/displaced-surface.ts` builds the table once at load, edge factors 1 to 14 | core mechanism |
| Edge factors and fade (`NaniteTessellation.ush`) | a compute pass per frame: edge factors from view depth, dice rate 2 px, fade by projected displacement | core mechanism |
| Split and dice queues (`NaniteSplit.usf`, `NaniteDice.ush`) | the same compute pass appends patch records with a 32-bit atomic counter, capped by a patch budget | core mechanism |
| Displaced bounds (`NaniteSplit.usf:21-37`) | the mesh bounding sphere grows by the displacement range, so `RenderCameraCull` stays correct | core mechanism |
| Material displacement, magnitude, center | a TSL height node, magnitude and center from the game, in the game's `src/render/` | template look |

- **Auto by default.** The dice rate, the edge factors, the fade distance and the patch budget come
  from the view and the mesh. The game sets only the height node, the magnitude and the center,
  because those decide the look. `TN_DISPLACED_SURFACE` reports the patch count, the micro-triangle
  count, the fade distance and whether the budget clipped the frame.
- **The game owns the look.** The vertex stage interpolates the source attributes at each
  micro-vertex and calls the game's height node. The game's material shades the result unchanged.
- **Shadows.** In this PRD, the shadow pass draws the undisplaced base mesh. The report names it
  (`shadow: "base"`). A displaced shadow is a revisit item under `## Decisions`.

Risks:

- Cracks between triangles of different factors. Shared edges must use the same edge factor and
  the same snapped vertices. Phase 2 tests this on a seam fixture.
- The micro-triangle buffer can outgrow memory at 4K. The patch budget clips the farthest patches
  first and reports it.

## Acceptance Criteria

- [ ] AC-1 [local]: A displaced quarry rock pose is judged an IMPROVEMENT over the same pose with a normal map only, with the silhouette change named by the judge. proof: headed `--browser-recipe webgpu` captures, before and after, two runs each, fresh visual-judge subagent — Evidence: pending.
- [ ] AC-2 [local]: The dice pass and the displaced draw add at most 1.0 ms GPU at 1080p on the RTX 2080 browser WebGPU lane. proof: `node packages/playtest/dist/runner/cli.js perf`, displacement on against off — Evidence: pending.
- [ ] AC-3 [local]: The desktop native host draws the same displaced fixture within the conformance tolerance. proof: `pnpm parity --target desktop --only-tests displaced-surface` — Evidence: pending.

## Blocked on

- A game or template that asks for displacement. Until one does, the quarry example is the only consumer, and Phase 1 decides whether Phases 2 and 3 run.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `DisplacedSurface` | `examples/quarry/src/render/look.ts` → `new DisplacedSurface(rockMesh, { height, magnitude, center })` → compute dice + indirect draw | New. No existing code adds vertices for displacement | Phase 2, AC-1 |

## Decisions

- 2026-10-21 (filing): Deferred, not declined, under the owner rule of 2026-10-21. A fresh Unreal 5.8.3 project ships no material with `bEnableTessellation`. The revisit condition is a game or template that asks for a silhouette a normal map cannot carry (rock, cobblestone, close terrain), or a Phase 1 result inside its threshold.
- 2026-10-21 (filing): The first slice keeps shadows on the base mesh. Unreal fades displacement in shadow levels as well. That waits for PRD-602's per-level shadow cut.
- 2026-11-14 (Phase 1 gate): **FAIL. Phases 2 and 3 stay deferred.** The added micro-triangles exceed the submitted triangles in all 5 quarry poses, by 1.02x to 1.74x.
  - Command: `pnpm --filter quarry bake && pnpm --filter quarry measure -- --displacement-probe`. It writes `artifacts/quarry/displacement-probe.json` (untracked).
  - Method: the `virtual` arm, offline. The probe loads the baked `.glb` files and assembles the scene of `src/game.ts`. It runs the same core cut at 1920x1080 with a 60 degree lens, near 0.08 and far 420.
  - Pricing: `priceDisplacedSurface` (`packages/core/src/displaced-surface.ts`) uses a 2 px dice rate and a 4 cm magnitude about a 0.5 center. The fade is off, which is the Unreal stock material. Unreal's edge factors and split rules are cited in the file header.
  - Culling: each patch is culled by the frustum and by a conservative occlusion buffer at 480x270, the stand-in for Unreal's HZB. Back faces are diced, because Unreal's patch back-face cull is compiled out (`NaniteSplit.usf:196-202`).
  - Scope: the floor, the cliff and the boulders are priced. The gantry and the grating are submitted but not priced.

  | Pose | Submitted | Diced | Patches | Micro-triangles | Added | Added / submitted | Added, fade on (1 px) | Added, no occlusion |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | rim (120) | 4,827,754 | 367,459 | 387,489 | 5,877,579 | 5,510,120 | 1.141 | 4,854,627 | 12,833,989 |
  | switchback (620) | 4,867,096 | 286,735 | 305,701 | 5,330,244 | 5,043,509 | 1.036 | 4,585,278 | 19,858,570 |
  | floor (1120) | 4,279,681 | 211,921 | 230,371 | 4,592,752 | 4,380,831 | 1.024 | 4,193,504 | 19,581,414 |
  | approach (1500) | 2,918,342 | 136,493 | 148,390 | 3,632,320 | 3,495,827 | 1.198 | 2,478,617 | 19,502,531 |
  | contact (1740) | 1,744,636 | 51,120 | 64,346 | 3,081,780 | 3,030,660 | 1.737 | 3,030,660 | 11,988,226 |

  - Where the added triangles come from: at rim, the floor 3.52 M and the boulders 1.69 M. At contact, the cliff 1.69 M.
  - Fade on (1 px fade-out, which is not the stock setting): 3 of 5 poses pass. Rim (1.006) and contact (1.737) still fail.
  - The margin is thin. Three poses sit within 20% of the line, and the estimate has known error in both directions:
    - Non-uniform patterns use an Euler estimate, not Unreal's remeshed table counts.
    - Split children use a uniform grid.
    - The occlusion buffer is coarser than Unreal's HZB.
    - The screen alone holds about 1.2 M micro-triangles of 2 px.
  - Revisit when a game or template asks for displacement. Then measure again with Unreal's baked pattern counts and a GPU HZB before Phase 2 starts.
- 2026-11-14 (Phase 1, forest row): Not priced. The forest kit's ground (`examples/strata-terrain-preview`) is built at run time by streamed tiles with per-ring LOD (`src/world/streamedGround.ts`), from a bake that this probe cannot load offline. To price it, the probe must run in the page (a core export and a kit hook), or it must rebuild the streamed ring in node. Neither is a small addition, so the row waits for Phase 2 to open.

## Execution Phases

#### Phase 1: Price the dice before building it
**Status:** DONE (2026-11-14). Gate FAILED, so Phases 2 and 3 are deferred.
**Files:** `examples/quarry/scripts/measure.ts`, `packages/core/src/displaced-surface.ts` (counter only), `packages/core/__tests__/displaced-surface.spec.ts`
- [x] A read-only counter reports, for each quarry pose at 1080p, the patches and micro-triangles that a 2 px dice rate and a 4 cm magnitude would produce, next to the triangles the cut already submits. proof: `pnpm --filter quarry measure -- --displacement-probe` reports 5 poses, 1.74 M to 4.87 M submitted triangles. The math is locked by `pnpm exec vitest run packages/core/__tests__/displaced-surface.spec.ts` (18 passed, red first).
- [x] The gate verdict is written under `## Decisions`: continue only if the added micro-triangles stay at or below the submitted triangles in every pose. proof: the Phase 1 table under `## Decisions` (2026-11-14). FAIL in 5 of 5 poses, with added / submitted from 1.02 to 1.74.

#### Phase 2: The dice pass on the web
**Status:** DEFERRED (Phase 1 gate failed, 2026-11-14)
**Files:** `packages/core/src/displaced-surface.ts`, `packages/core/src/index.ts`, `packages/core/__tests__/displaced-surface.spec.ts`, `examples/quarry/src/render/look.ts`
- [ ] The pattern table covers edge factors 1 to 14, and two triangles that share an edge with equal factors share every snapped edge vertex. proof: `pnpm exec vitest run packages/core/__tests__/displaced-surface.spec.ts`.
- [ ] Edge factors fall to a quarter past the fade distance, and the fade distance follows the 4 px to 1 px rule. proof: `pnpm exec vitest run packages/core/__tests__/displaced-surface.spec.ts`.
- [ ] The quarry rock renders displaced on browser WebGPU, and `TN_DISPLACED_SURFACE` reports its counts. proof: AC-1 visual judge and AC-2 perf run.

#### Phase 3: The owned host
**Status:** DEFERRED (Phase 1 gate failed, 2026-11-14)
**Files:** `packages/runtime-native/conformance/scenes/shared/displaced-surface.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The desktop host runs the dice compute and the indirect draw and matches the browser reference. proof: `pnpm parity --target desktop --only-tests displaced-surface`.
