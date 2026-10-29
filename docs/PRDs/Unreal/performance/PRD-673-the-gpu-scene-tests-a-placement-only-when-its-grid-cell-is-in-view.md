---
prd_contract: v1
---

# PRD-673 — The GPU scene tests a placement only when its grid cell is in view

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: the flat per-placement cull ships and works, and no measurement yet says its cost or its empty indirect draws matter on a real walk.
**Complexity:** 6 (MEDIUM) — 6–10 files: kernel, reference, specs, native kernel, conformance (+2), a persistent chunk table that follows residency changes (+2), a second dispatch with an indirect size (+1), native proof (+1); risk override: none
**Owner:** João
**Depends on:** None. Builds on the shipped `WorldGpuScene` (`packages/core/src/world-gpu-scene.ts`, [PRD-473](../../done/PRD-473-open-worlds-hold-120-fps-gpu-driven.md)). Composes with [PRD-489](../../done/PRD-489-gpu-scene-occlusion-culling.md): its depth-pyramid test can run per chunk later, but this PRD does not reopen occlusion.

## Context

**Unreal LOC:** 14,439 for "GPU scene and instance culling" in the feature map (12,019 C++, 2,420
shader). The part this PRD ports is smaller: `Renderer/Private/SceneCulling/` is 4,923 lines, plus
`NaniteInstanceHierarchyCulling.usf` (366) and `SceneCulling/*.usf|ush` (501), about 5,800 lines.
**Port estimate:** about 700 to 1,000 ThreeNative lines: about 450 of TSL kernel and reference in
`packages/core/`, about 200 of specs, and about 250 of C++ in the native cull kernel.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Instances live in a hierarchical spatial hash.** Each level doubles the cell size. An instance
  goes to the level whose cell is at least the diameter of its bounding sphere, so it overlaps at
  most 2×2×2 cells. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/SceneCulling/HierarchicalSpatialHashGrid.h:297-300, 340-353`.
- **The smallest cell is 4,096 units (about 41 m).** Smaller objects clamp up to that level. Objects
  larger than the largest cell are "uncullable" and skip the hierarchy: the GPU tests them one by
  one. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/SceneCulling/SceneCulling.cpp:131-144`.
- **Cells group into 8×8×8 blocks** in a hash map keyed by block coordinate and level.
  `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/SceneCulling/SceneCulling.h:160`.
- **A cell holds chunks of at most 64 instances.** A cell header packs the chunk offset and separate
  counts of static and dynamic chunks, so static chunks can stay cached.
  `UE 5.8.3: Engine/Shaders/Shared/SceneCullingDefinitions.h:10-13` and
  `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/SceneCulling/SceneCulling.cpp:414-432`.
- **Chunk bounds are built on the GPU** from the instance bounds, and stored quantized relative to
  the cell. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/SceneCulling/SceneCulling.cpp:667-705`.
- **The GPU culls chunks first.** One thread loads a chunk's box and tests it against every active
  view: frustum, draw distance, and the hierarchical-depth test. A surviving chunk appends one
  64-thread instance-cull work group, with a mask of the views that kept it. The instance pass then
  runs only for those groups.
  `UE 5.8.3: Engine/Shaders/Private/Nanite/NaniteInstanceHierarchyCulling.usf:52-76, 106-203` and
  `UE 5.8.3: Engine/Shaders/Shared/SceneCullingDefinitions.h:69-77`.
- **The CPU can use the same hierarchy** for instanced primitives with precomputed bounds. It is on by
  default. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/SceneCulling/SceneCulling.cpp:172-186`.

### ThreeNative today

- `WorldGpuScene` runs one compute dispatch over every resident placement. Each thread tests one
  bounding sphere against six planes, picks a level by distance, and appends survivors
  (`world-gpu-scene.ts:45-57`, reference `cullAndSelect` at `world-gpu-scene.ts:499`). A placement
  record is 24 words (`world-gpu-scene.ts:60`).
- The shadow levels run the same test per level when `shadowGpuKeys` is on
  (`cullAndSelectShadow`, `world-gpu-scene.ts:511`), so the thread count grows with the view count.
- A GPU-scene key with zero visible instances still submits its indirect draw. PRD-489 recorded this
  as CPU cost that occlusion does not remove.
- `WorldCells` already streams by grid cell, so each placement has a cell. The kernel does not use it.
- The native engine mirrors the kernel in `packages/runtime-native/src/engine/world/gpu_scene/cull_kernel.cpp`.
- The capability manifest has no spatial-hash or chunk cull (`rg -i "spatial hash|chunk cull"
  packages/create-threenative/capabilities.json`, 2026-10-21).

## Solution

**This is mechanism only.** It decides nothing about the look, so all of it goes in
`packages/core/src/world-gpu-scene.ts` and its native mirror.

| Unreal piece | ThreeNative module | Layer |
| --- | --- | --- |
| Hierarchical spatial hash, levels by size | One level: the `WorldCells` streaming cell. A placement whose sphere is larger than half a cell goes to an `uncullable` list, as Unreal does past its largest cell | `packages/core/src/world-gpu-scene.ts` |
| Chunks of at most 64 instances, static and dynamic counts | A chunk table: up to 64 placements of one cell, with a bounding sphere, rebuilt only when residency changes | `world-gpu-scene.ts`, written where the placement buffer is written today |
| Chunk cull, then instance work groups | Pass 1: one thread per chunk tests the sphere against the main frustum and each shadow level, and appends `(chunk, view mask)`. Pass 2: an indirect dispatch of 64-thread groups runs today's per-placement test only for those chunks | `world-gpu-scene.ts` kernel and the `cullAndSelect` reference |
| CPU hierarchical cull | A key whose chunks all failed for the last landed dispatch skips its indirect draw submission. Phase 1 decides if this part is worth building | `world-gpu-scene.ts` |
| Native | The same two passes in the native shader IR | `packages/runtime-native/src/engine/world/gpu_scene/cull_kernel.cpp` |

**Auto by default:** the chunk size is the cell's, so a game sets no constant. The GPU-scene report
(`IWorldGpuSceneReport`, `world-gpu-scene.ts:1215`) gains the chunk count, the chunks that survived,
and the placements tested.

Risks:

- three's compute path must take an indirect dispatch size on WebGPU and on the native host. If it
  cannot, pass 2 dispatches the full chunk count and early-outs, which keeps most of the saving.
- The chunk table must never miss a placement. The existing `compareMeshDraws` check
  (`world-gpu-scene.ts:860`) proves the chunk path draws the same instances as the flat path.

## Acceptance Criteria

- [ ] AC-1 [local]: On the Phase 1 workload, the chunk path cuts the cull dispatches' GPU p95 by at least 50% against the flat path, with every shadow level the walk uses. proof: `node packages/playtest/dist/runner/cli.js perf` with `TN_FRAME_BUDGET`, chunk path on against off, 3 runs per arm — Evidence: pending.
- [ ] AC-2 [local]: The chunk path draws exactly the instances the flat path draws on every validated frame of the walk. proof: `?tnGpuSceneValidate=1` report with `verdict=ok` on every frame — Evidence: pending.

## Blocked on

- Machinefall `?scene=map-walk` lives in a separate checkout. The Phase 1 workload needs that checkout to pin current core (see `docs/PRDs/open-world/RUNBOOK-machinefall-120fps-with-fab-quality.md`). The in-repo fallback is `examples/strata-terrain-preview` prop streaming.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Chunk cull pass | Every `WorldCells` with `gpuScene` on (the default) → `WorldGpuScene` dispatch | Replaces the flat per-placement dispatch. The flat path stays as the `uncullable` list and as the validation reference | Phase 2, AC-1, AC-2 |
| Empty-key skip | `WorldCells` main batches → indirect draw submission | New. Built only when Phase 1 shows empty keys cost CPU time | Phase 1 decision |

## Execution Phases

#### Phase 1: Does the flat cull cost enough to matter?
**Status:** NOT STARTED
**Files:** `packages/core/src/world-gpu-scene.ts`, `packages/core/src/frame-budget.ts` (only if no ring isolates the cull dispatch)
- [ ] The cull dispatches' GPU p50 and p95 (main and every shadow level), the resident placement count, and the share of GPU-scene draws with zero instances are recorded under `## Decisions` for the walk on the RTX 2080 browser WebGPU lane. proof: `node packages/playtest/dist/runner/cli.js perf` with `TN_FRAME_BUDGET` and the GPU-scene report, 3 runs.
- [ ] The same numbers on the Intel laptop lane, with the gate verdict. Gate: continue when the cull dispatches cost at least 0.3 ms GPU p95 on either lane, or when empty keys are at least 25% of GPU-scene draws. Otherwise defer, and revisit when a scene holds more than 200,000 resident placements or `shadowGpuKeys` becomes the default. proof: `node packages/playtest/dist/runner/cli.js perf` on the laptop lane, 3 runs.

#### Phase 2: Chunks and the two-pass cull
**Status:** NOT STARTED
**Files:** `packages/core/src/world-gpu-scene.ts`, `packages/core/__tests__/world-gpu-scene.spec.ts`
- [ ] The chunk table holds every resident placement exactly once, at most 64 per chunk, and a placement larger than half a cell goes to the `uncullable` list. Residency changes rebuild only the chunks of the cells they touch. proof: `pnpm exec vitest run packages/core/__tests__/world-gpu-scene.spec.ts`.
- [ ] The two-pass reference returns the same survivors and levels as `cullAndSelect` and `cullAndSelectShadow` over randomized placements, cameras and shadow levels. proof: `pnpm exec vitest run packages/core/__tests__/world-gpu-scene.spec.ts`.
- [ ] The browser kernel matches the reference on the walk, and AC-2 holds. proof: `?tnGpuSceneValidate=1` through `node packages/playtest/dist/runner/cli.js` on the Phase 1 scenario.

#### Phase 3: Native and the cost claim
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/world/gpu_scene/cull_kernel.cpp`, `packages/runtime-native/src/engine/world/gpu_scene/cull_kernel.h`, `packages/runtime-native/conformance/registry.json`
- [ ] The desktop native host runs the two-pass cull and the `world-gpu-scene-readback` conformance row passes. proof: `pnpm parity --target desktop --only-tests world-gpu-scene-readback`.
- [ ] The AC-1 measurement is recorded. proof: the AC-1 perf runs.
**Verification:** AC-1 and AC-2.
