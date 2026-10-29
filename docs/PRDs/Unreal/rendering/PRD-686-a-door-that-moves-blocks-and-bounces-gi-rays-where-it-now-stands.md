---
prd_contract: v1
---

# PRD-686 — A door that moves blocks and bounces GI rays where it now stands

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 is open: the traced scene is a snapshot that changes only on `rebuild()`, so a moved door, platform or crate keeps shadowing and bouncing GI rays from where it stood, and no measurement says what a rebuild costs.
**Complexity:** 6 (MEDIUM) — 4–6 files: change detection, the update path, specs, one conformance scene (+1), state across frames: tracked transforms and a pending-update set (+2), two traced packs to keep in step (+1), native proof (+1), frame cost on frames with motion (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-603](PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 (the probe trace that reads the scene). Builds on the shipped `GPUSceneBVH` ([PRD-244](../../done/PRD-244-the-scenes-bvh-reaches-the-gpu.md), `packages/core/src/gpu-scene-bvh.ts`) and the owned-engine scene pack of PRD-642 D2 (`docs/PRDs/Unreal/gi/PRD-642-glossy-surfaces-reflect-what-the-camera-cannot-see.md`, on `feat/unreal-look-epic`). Coordinates with [PRD-dynamic-path-tracing-scene](../../path-tracing/PRD-dynamic-path-tracing-scene.md) Phase 1, which needs the same rigid update for the path tracer, and with [PRD-VQ-09](../../rendering/PRD-VQ-09-incremental-diffuse-relighting.md), which owns the dirty regions that a move feeds.

## Context

**Unreal LOC:** 3,982 lines for Lumen scene data and primitive updates (`LumenScene.cpp` add, update
and remove, `LumenSceneData.h`, `LumenSceneGPUDrivenUpdate.cpp`, `LumenSparseSpanArray.h` and the
update tasks in `LumenSceneRendering.cpp`). The global distance field's partial update lives outside
the Lumen folder (`GlobalDistanceField.cpp`). **Port estimate:** about 150 to 400 ThreeNative lines.
The low end is an automatic rebuild on change. The high end is a two-level structure that moves an
instance without touching its triangles.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **A moved primitive keeps its surface cache.** A transform change queues an update
  (`Engine/Source/Runtime/Renderer/Private/Lumen/LumenScene.cpp:926-943`). The update moves the
  primitive's cards to the new transform and does not capture them again
  (`LumenScene.cpp:1427-1476`). A recapture happens only through a separate invalidation call
  (`LumenScene.cpp:946-965`, `:1494-1514`).
- **The traced field follows the move.** Mesh distance fields are stored in object space, so a
  rigid move changes only the instance transform. The global distance field is updated only inside
  the bounds that moved primitives touched, and the mostly static part is cached apart
  (`Engine/Source/Runtime/Renderer/Private/GlobalDistanceField.cpp:108`, `:114-117`, `:1185-1218`).
- **Skinned meshes are not in the software trace.** Only opaque static meshes with a valid distance
  field get a distance field representation
  (`Engine/Source/Runtime/Engine/Private/StaticMeshSceneProxy.cpp:340`). Spline meshes and Nanite set
  the same flag, and no skinned proxy does. A skinned character therefore shows in Lumen's screen
  traces only.

### ThreeNative today

- `GPUSceneBVH` packs world-space triangles once. Its own comment says "The snapshot is static by
  default. A game changes it only by calling rebuild()" (`packages/core/src/gpu-scene-bvh.ts`,
  `rebuild`). A rebuild flattens every instance and builds a new CPU SAH tree.
- `packScene` takes every visible `Mesh`, so a `SkinnedMesh` enters the pack in its bind pose
  (`gpu-scene-bvh.ts`, `packScene`). A character then shadows GI rays where its bind pose stands.
- PRD-603 declares the limit: "Objects outside the BVH neither bounce nor shadow." Nothing says
  what happens to an object that is in the BVH and then moves.
- PRD-dynamic-path-tracing-scene asks for the same rigid update for the path tracer (its Phase 1). A
  shared mechanism in `packages/core` serves both.

## Solution

**The gate first (Phase 1).** Add a door to the probe example: a slab that swings shut between the
emitter and the dark room. Measure two things. First, the probe error after the door closes with
today's snapshot (light through the closed door) against a manual `rebuild()`. Second, the time of
one `GPUSceneBVH.rebuild()` on the `cornell`, `sunlit-room` and `neon-corridor` scenes and on the
starter template's scene. **Gate:** continue only if the snapshot error on the dark side of the door
is above the PRD-604 leak target of 0.02. If a rebuild of a scene of 100,000 triangles or fewer costs
1 ms or less, Phase 2 builds the automatic rebuild only. Otherwise it builds the two-level path.

**Phase 2, the trace follows rigid motion.**

- **Change detection.** The pack keeps the world matrix of each traced mesh and instance. Each frame
  it compares them. A change marks the pack dirty and records the old and the new world bounds.
- **The update.** The cheap path rebuilds the pack once per frame at most, inside a time budget, and
  keeps the old pack readable until the new one is complete. The two-level path keeps each mesh's
  triangles in object space under its own tree, and a top tree over instance bounds. A move then
  rewrites one transform and the top tree.
- **Skinned meshes stay out by default, as in Unreal.** The pack skips `SkinnedMesh` unless the
  game's `include` callback asks for it, and the report counts the skipped meshes.
- **The probes hear about it.** The old and the new bounds of a moved object go to the dirty-region
  input of PRD-VQ-09, so the probes around the door refresh first.

**Names and override.** The option is `updates: "auto" | "manual"`. `"auto"` is the default, as Unreal
updates moved primitives every frame. `"manual"` keeps today's behaviour: the pack changes only on
`rebuild()`. `TN_SCENE_TRACE` reports the path that ran (rebuild or two-level), the updates in the
last second, the last update time and the skipped skinned meshes. The manifest entry gains
`@alias lumen scene update` and `@alias global distance field partial update`.

**Where it lives.** Change detection and the update are mechanism in `packages/core/src/gpu-scene-bvh.ts`
and in the owned-engine pack beside it. They decide no colour and no material.

## Acceptance Criteria

- [ ] AC-1 [local]: After the door closes, the dark room's probe irradiance returns to the closed-door full-rebuild reference within 60 frames, on a named WebGPU adapter. proof: `node packages/playtest/dist/runner/cli.js examples/prd268-probe-volume/playtests/door.playtest.json --url 'http://127.0.0.1:5184/?scene=door&update=trace' --server-command 'pnpm --filter prd268-probe-volume dev --host 127.0.0.1 --port 5184 --strictPort' --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-2 [local]: On frames where nothing moves, the pack does no work, and on a frame where one object moves, the update stays inside its budget. proof: the AC-1 playtest, `TN_SCENE_TRACE` per frame — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The conformance row `scene-trace-door` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests scene-trace-door` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Automatic pack update on rigid motion | Every traced GI ray (PRD-603, PRD-640, PRD-642) | Replaces the static snapshot; `updates: "manual"` keeps it | AC-1 |
| Skinned meshes left out of the trace | `GPUSceneBVH` and the owned-engine pack | Replaces bind-pose triangles in the trace | Phase 2 |
| Moved bounds as dirty regions | PRD-VQ-09 dirty-region input | New feed | AC-1 |

## Execution Phases

#### Phase 1: What a stale snapshot costs, and what a rebuild costs
**Status:** NOT STARTED
**Files:** `examples/prd268-probe-volume/src/game.ts`, `examples/prd268-probe-volume/playtests/door.playtest.json` (new)
- [ ] The dark-side probe error with the stale snapshot, against a manual `rebuild()`, is recorded under `## Decisions`. proof: the AC-1 playtest command with `update=trace&rebuild=manual`.
- [ ] The `rebuild()` time on the three calibration scenes and the starter scene is recorded with the gate verdict and the chosen path. proof: the AC-1 playtest command with `&rebuildCost`, and the same timer in the harness capture log.

#### Phase 2: The pack follows the door
**Status:** NOT STARTED
**Files:** `packages/core/src/gpu-scene-bvh.ts`, `packages/core/__tests__/gpu-scene-bvh.spec.ts`, the owned-engine scene pack, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] A moved mesh changes the first hit of a ray through its old and new places in the next update, an unmoved scene does no work, and a `SkinnedMesh` is skipped and counted. proof: `pnpm exec vitest run packages/core/__tests__/gpu-scene-bvh.spec.ts`.
- [ ] A capability search for "lumen scene update" returns `GPUSceneBVH`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: Judge and native
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/scene-trace-door.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A fresh visual judge on the door fixture (BEFORE the stale snapshot, AFTER the automatic update, a manual full rebuild as the target) returns IMPROVEMENT with no REGRESSION frame, including one frame mid-swing. proof: headed `--browser-recipe webgpu` captures, 2 runs per arm, judged by a fresh read-only subagent.
- [ ] The conformance row `scene-trace-door` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests scene-trace-door`.
**Verification:** AC-1 to AC-3.
