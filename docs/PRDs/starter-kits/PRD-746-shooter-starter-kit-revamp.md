---
prd_contract: v1
---

# PRD-746 — The shooter starter kit uses the engine it ships with

**Status:** OPEN — planned 2026-10-26
**Priority:** P1 — the owner called the shooter "an important starter kit" and saw a smeared weapon on 2026-10-26
**Complexity:** 5 (MEDIUM) — one engine fix in `packages/runtime-native` (+2), the shooter kit's render and scene source (+2), its playtest budgets (+1)
**Owner:** João
**Depends on:** none. Rides on PR #574 with [PRD-723](../Unreal/look/PRD-723-every-template-game-looks-like-unreal-on-the-engine-defaults.md). Temporal upsampling arrives with PRD-741 (#568) and needs no kit change.

## Context

The owner opened the shooter at the PR #574 head on 2026-10-26 and wrote: "there's an excessive
motion blur. is this unreal default really?", then "tweak our shooter sample, add latest performance
engine_capabilities where needed ... its an important starter kit, revamp it".

What the checks found:

1. The motion blur constants and formula match Unreal 5.8.3 (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/Scene.cpp:646-649`,
   `Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessMotionBlur.cpp:614-633`,
   `Engine/Source/Runtime/Renderer/Private/SceneVisibility.cpp:5620-5659`; core `packages/core/src/look/motion-blur.ts:5-11`).
2. The weapon smear is an engine bug. The owned engine's per-object velocity pass skips skinned,
   morphed and node-deformed draws (`packages/runtime-native/src/engine/renderer/renderer.cpp:3377-3386`),
   and the depth reprojection fill gives them the camera's motion (`traa.cpp:181-189`). The rifle and
   arms are skinned and parented to the camera (`templates/shooter/src/entities/Rifle.ts:201`), so a
   turn or a strafe smears them to the 2.5 %-per-side cap. Unreal keeps them sharp. Evidence:
   `~/Downloads/pr574-shooter-motion-blur/` (`1-still.png`, `2-strafe-right.png`, `4-turn.png`).
   Every kit with a skinned character has the same fault in a smaller form.
3. The post chain equals core's `qualityPreset(tier)` (`kit-look-defaults.spec.ts:191-215`). The kit
   overrides three exposure values (`templates/shooter/src/render/exposure.ts:8-15`): `key` 0.14
   against core's 0.36 (1.4 stops darker), `maxStops` 0.5 and `minStops` -2.
4. Survey of shipped capabilities the shooter does not call (2026-10-26, `capabilities.json` and
   `git log` since 2026-09-15): `mergeByMaterial` (the kit hand-rolls `mergeGeometries` in
   `src/render/facade.ts:48` and `town.ts:969`), `markStatic` (the town never moves),
   `InstancedBatch` (palms use raw `InstancedMesh`, `palm.ts:445`), `addInSlices` (the town builds
   synchronously at `src/scenes/Play.ts:197`). The performance scenario has no frame-time bound of its
   own and loose counts (`maxDrawCalls` 1300, `maxTriangles` 500000).

World streaming (`WorldCells`, `TerrainTiles`) was considered and is out of scope: the town is one
84 m block (`TOWN_HALF = 42`) that one fitted shadow map covers. `VirtualShadowNode` stays declined
for the reason in `src/render/lighting.ts:42-43` (cascade boundaries showed as sharp shadows).

## Solution

Fix the engine first, so every kit gains. Then measure the shooter, adopt the shipped mechanisms
that the measurement says pay, tighten the scenario to the measured numbers, and judge the look.

## Phases

### Phase 1 — A skinned draw writes its own velocity (engine)

- [ ] Skinned, morphed and node-deformed draws render in the velocity pass through their own vertex stage, with `previousClip = previousProjection * previousView * previousModel * currentDeformedLocal`. The camera-motion fill stays only for instanced, sprite and transparent draws. proof: a red-green case in `packages/runtime-native/tests/native-engine/renderer_test.cpp` (a skinned box under a camera, 5° yaw between two frames: box pixels read |v| < 1e-3 NDC, background reads the camera delta), and `TN_TRAA_VELOCITY_SKIPPED: skinned` no longer prints in the shooter.
- [ ] The renderer's frame delta advances once per presented frame, not in `compileAsync` (`renderer.cpp:2490-2493`). proof: a red-green renderer test.

### Phase 2 — Adopt what pays

Each box records draws, triangles and CPU/GPU p95 of `performance.playtest.json` before and after, with
`TN_FRAME_BUDGET`. Frame times on desktop Xvfb read 2-3x high (PRD-735 Decisions), so a frame-time
claim comes from a 60 Hz real display or is marked unverified.


- [ ] The town merges through `mergeByMaterial` (clone `templates/platformer/src/scenes/Play.ts:394-415`) instead of the hand-rolled merge, and the unmerged solids join it. proof: draw count before and after.
- [ ] The built town is `markStatic`, with `invalidateStatic` wherever a breakable or a decal writes into it. proof: a playtest scenario that breaks a crate and still passes.
- [ ] Palms draw through `InstancedBatch` (clone `templates/runner/src/track.ts:68`). proof: draws and a judge frame.
- [ ] `performance.playtest.json` bounds sit at the measured numbers plus a stated margin and carry `maxFrameMsP95`. proof: the scenario passes on the PR head.

### Phase 3 — The look

- [ ] Each of the three exposure overrides is kept only if a judge frame shows why. proof: the judge verdict per override.
- [ ] Fresh judge against BEFORE captures taken at the PR #574 head before Phase 2 (headed WebGPU, nvidia/turing, two runs per arm): IMPROVEMENT overall, the weapon sharp while turning and strafing, no REGRESSION. proof: the verdict and the sheets on the PR.

## Acceptance criteria

- [ ] A turning or strafing first-person weapon stays sharp in the shooter, as in Unreal. proof: Phase 1 test and Phase 3 judge frame.
- [ ] The shooter calls `mergeByMaterial`, `markStatic` and `InstancedBatch` where Phase 2 measured a gain, and its performance scenario bounds are the measured numbers. proof: Phase 2 boxes.
- [ ] `TN_TEMPLATE_ONLY=shooter pnpm test:templates` passes and the scaffold hash is re-pinned. proof: the run on the PR head.

## Decisions

- 2026-10-26: world streaming and virtual shadow maps stay out (see Context). Revisit when the map
  grows past one fitted shadow map (about 200 m).
