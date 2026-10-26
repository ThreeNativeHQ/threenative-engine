---
prd_contract: v1
---

# PRD-746 — The shooter starter kit uses the engine it ships with

**Status:** PARTIAL — Phase 2 town merge landed; Phase 1 (engine velocity) in progress
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


- [x] The town merges through `mergeByMaterial` (clone `templates/platformer/src/scenes/Play.ts:394-415`) instead of the hand-rolled merge, and the unmerged solids join it. proof: draw count before and after. Done 2026-10-26 (8b72dd182 + 1b311ba5a, from lane-shooter): `collapseTown` in `src/townBatch.ts`, called from `Play.ts` after `buildTown` (render source stays portable); solids, crates, barrels, decks, posts and the van join the merge, grouped by hittable, shadow flags and surface; the rocking boat stays out. Draws 375/432 -> 178/209 (2 runs each, headed WebGPU nvidia/turing, Xvfb), triangles 424.7k -> 426.9k (merged meshes are culled as one), CPU p95 14.5/14.8 -> 11.0/11.7 ms. Fresh Opus judge NEUTRAL on 7 poses, 2 runs per arm (`~/Downloads/pr574-prd746-shooter/`).
- [ ] `performance.playtest.json` bounds sit at the measured numbers plus a stated margin. proof: the scenario passes on the PR head. Partial 2026-10-26 (0521fe7c4, 271b6af81): `maxDrawCalls` 1300 -> 320 (measured 184-276 across 5 runs, the maximum rises with host load), `maxTriangles` 500000 -> 470000 (measured 426k). The frame bound is the harness default 16.7 ms (`template.spec.ts:287` forbids a per-kit pin). Open: `maxFrameMsP95` reads GPU 25 ms on desktop Xvfb before and after (P5 clocks), so the pass needs a 60 Hz real display.

### Phase 3 — The look

- [ ] Each of the three exposure overrides is kept only if a judge frame shows why. proof: the judge verdict per override.
- [ ] The town's plaster, stone, wood, metal and ground take tiling surfaces generated through OpenRouter (`agent-files/scripts/reference.mjs`, a cheap image model), at most 8 images of 512 px WebP and 1 MB in total, applied through the `surfaced()` pattern of `templates/adventure/src/render/surface.ts`, licence and prompts in `assets/tex-PROVENANCE.md`. Geometry stays procedural. proof: the byte total and the `survives` scenario.
- [ ] Unreal-grade polish on procedural geometry only (owner, 2026-10-26: "polish visuals also as if its a unreal game, procedural only"): material response per surface, trims, edge wear and contact shading, judged against the Phase 3 BEFORE set. proof: the judge verdict below.
- [ ] Fresh judge against BEFORE captures taken at the PR #574 head before Phase 2 (headed WebGPU, nvidia/turing, two runs per arm): IMPROVEMENT overall, the weapon sharp while turning and strafing, no REGRESSION. proof: the verdict and the sheets on the PR.

## Acceptance criteria

- [ ] A turning or strafing first-person weapon stays sharp in the shooter, as in Unreal. proof: Phase 1 test and Phase 3 judge frame.
- [ ] The shooter calls `mergeByMaterial`, `markStatic` and `InstancedBatch` where Phase 2 measured a gain, and its performance scenario bounds are the measured numbers. proof: Phase 2 boxes.
- [ ] `TN_TEMPLATE_ONLY=shooter pnpm test:templates` passes and the scaffold hash is re-pinned. proof: the run on the PR head.

## Decisions

- 2026-10-26 (lead, measured): `markStatic` on the town is dropped. Three alternating pairs gave CPU p95 11.4/11.4/14.5 ms with it against 11.2/11.2/11.8 without, so no gain; `?tnRenderListValidate=1` showed 0 divergences over 660 frames while it was on.
- 2026-10-26 (lead, measured): palms stay on `InstancedMesh`. `InstancedBatch` was neutral (same draws and triangles) and calling it from `src/render/palm.ts` breaks the render portability check (`scripts/check-core-boundary.ts`); reverted in 390696886.

- 2026-10-26: world streaming and virtual shadow maps stay out (see Context). Revisit when the map
  grows past one fitted shadow map (about 200 m).
