---
prd_contract: v1
---

# PRD-635 — Ambient occlusion darkens only the light that comes from around

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: the templates multiply the whole lit frame by GTAO, so a sunlit crease turns grey, which Unreal's default never does.
**Complexity:** 5 (MEDIUM) — template post source in 10 templates (+2), a depth-normal prepass that changes the frame cost (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-631](PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 3 (the L6 row). Comes before the GI work in [PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md), which needs the same prepass.

## Context

**ThreeNative today:** GTAO runs at `high` (16 samples) and `medium` (8 samples), radius 0.35 m, with
a depth- and normal-aware denoise. It is on in 10 of 13 templates. The final AO **multiplies the
composed colour** (`packages/create-threenative/templates/starter/src/render/worldEnvironment.ts:768-811`),
so it darkens direct sunlight as much as sky light. The scene materials assign no AO map, so the
specular occlusion path in the native standard shader (`packages/runtime-native/src/engine/shader/standard.cpp:1110`)
never runs.

**Unreal 5.8.3** applies ambient occlusion to indirect light only (source read 2026-10-19):

| Behaviour | Default | Source |
| --- | --- | --- |
| Lumen short-range AO | On, applied to indirect diffuse | `Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeGather.cpp:299` |
| Multi-bounce AO | Albedo-dependent: bright surfaces lose less light; Lumen caps the bounce albedo at 0.5 | `Engine/Shaders/Private/DeferredShadingCommon.ush:1364`; `Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenSpaceBentNormal.cpp:56` |
| Sky specular occlusion | Strength 1: AO, roughness and view angle attenuate the sky reflection | `Engine/Source/Runtime/Renderer/Private/IndirectLightRendering.cpp:130`; `Engine/Shaders/Private/ReflectionEnvironmentShared.ush:131` |
| Without Lumen | SSAO at intensity 0.5, applied to the indirect term | `Engine/Source/Runtime/Engine/Private/Scene.cpp:567` |

**three.js r185 already has the hook.** `builtinAOContext(aoNode)`
(`three/src/nodes/core/ContextNode.js:244`) feeds a screen-space AO value into the material's ambient
occlusion. `PhysicalLightingModel` then applies it to indirect diffuse and indirect specular, and it
leaves direct light alone. Using it needs the AO before the beauty pass: a depth-normal prepass, then
GTAO, then the scene pass reading the AO. three.js r185 also already applies GGX multi-scatter energy
compensation to direct and image-based light (`three/src/nodes/functions/PhysicalLightingModel.js:570-626`),
so the surface BRDF itself needs no change.

## Solution

1. **AO enters the lighting, not the composite.** The template chain renders a depth-normal
   prepass, computes GTAO from it, and installs the result through `builtinAOContext` on the scene
   pass. The composite multiply is removed. Where to apply AO decides the look, so this change
   goes in the template's `worldEnvironment.ts`.
2. **Multi-bounce.** The AO value passes through the albedo-dependent multi-bounce fit before it
   reaches the material: Jimenez et al. 2016, cited from the paper and not from Unreal code.
3. **Pay for the prepass, or reuse one.** The velocity and normal targets of
   [PRD-269](../../done/PRD-269-motion-vectors-or-the-temporal-filters-lie.md) and the SSGI plan
   may already render depth and normals. Phase 1 measures whether the prepass can share an
   existing target before it adds one. The added cost is recorded against the `high` budget.

## Acceptance Criteria

- [ ] AC-1 [local]: The starter L6 cells match the Unreal L6 cells within the PRD-631 thresholds in all 12 poses. The lit floor at the foot of the sunlit wall must not darken. proof: `pnpm unreal-look:compare --layer L6` — Evidence: pending.
- [ ] AC-2 [local]: The `high` frame cost of AO, prepass included, is no more than 0.3 ms above today's GTAO on the RTX 2080 browser lane. proof: `node packages/playtest/dist/runner/cli.js perf`, new chain against old — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| AO on indirect light | `templates/*/src/render/worldEnvironment.ts` → `scenePass.contextNode = builtinAOContext(ao)` | Replaces the composite multiply at `worldEnvironment.ts:811` | Phase 2 |
| Multi-bounce AO | same file, before `builtinAOContext` | New | Phase 2 |

## Execution Phases

#### Phase 1: The prepass and its cost
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/starter/src/render/worldEnvironment.ts`
- [ ] The prepass shares an existing depth-normal target, or its added cost is measured and recorded under `## Decisions`. proof: `node packages/playtest/dist/runner/cli.js perf` on the starter.

#### Phase 2: The starter matches L6
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/starter/src/render/{worldEnvironment,quality}.ts`
- [ ] GTAO reaches the lighting through `builtinAOContext` with multi-bounce, and the composite multiply is gone. proof: `pnpm unreal-look:compare --layer L6`.
- [ ] A visual judge subagent returns IMPROVEMENT against the current starter on the sunlit-crease and room-interior cells. proof: judge verdict recorded here.

- [x] The floor under a sphere keeps a soft contact gradient at L9: the SSGI-over-cache correction takes the contact occlusion's factor, so GTAO and the gather no longer subtract the same light twice. proof: `TN_UNREAL_LOOK_WORK=<dir> pnpm unreal-look:capture --engine threenative --layers L9 --cells sun15/spheres,sun60/spheres`, two runs per arm. sun15 chrome-sphere foot (900..1040 x 478..502 px): clipped pixels 50.6 % -> 0.0 %, mean luma 19.2 -> 38.2 (Unreal 40.3), darkest row 4.3 -> 26.6 (Unreal 32.5). Whole-frame MAE to Unreal, 12 L9 cells: unchanged (noise floor 0.2), interior sun60 10.14 -> 9.64. Judge verdict (fresh read-only Sonnet): IMPROVEMENT overall; chrome foot IMPROVEMENT, the other rows NEUTRAL (comment on PR #541, commit d8da3737d).

#### Phase 3: Every AO template, native included
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/worldEnvironment.ts`, `packages/runtime-native/conformance/scenes/shared/ao-indirect-only.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The native engine applies AO to indirect light only, within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests ao-indirect-only`.
- [ ] The 10 GTAO templates use the new path, and the template gate passes. proof: `pnpm test:templates`.
- [ ] Every affected template's `AGENTS.md` (and mirror) states AO on indirect light only, and how a game returns to the composite multiply, so a new project's agent knows the default and how to override it. proof: `rg -l 'builtinAOContext' packages/create-threenative/templates/*/AGENTS.md` lists every affected template, and `pnpm sync:agents --check` exits 0.

#### Phase 4: Emitted light is not occluded
**Status:** IN PROGRESS
**Files:** `packages/runtime-native/src/engine/`, `packages/three-native/`, `scripts/unreal-look/scaffold/render/worldEnvironment.ts`
Emission is light a surface gives off, not light it receives. AO must not darken it. The underside of an emitter (L8 `spheres`) reads 0.899 of Unreal today, and 0.997 is the target.
- [x] Post consumers can request an `emissive` MRT target, and unknown MRT names still fail. proof: `pnpm exec vitest run packages/three-native/__tests__/pass-node.spec.ts` — 16 passed (red before: 1 failed, 15 passed, `TN_NATIVE_MRT_UNSUPPORTED: emissive`).
- [x] The shader variants keep the lit layout for all four lit material kinds, including mapped and node emission. proof: `tn-native-engine-material-test emissive_output` — passed on native and Wasm.
- [x] The native engine test targets and the Wasm core tests and web engine build. proof: `cmake --build packages/runtime-native/build/tn-engine --target tn-native-engine-tests` exit 0; Emscripten build of `tn-native-engine-core-tests tn-native-engine-web` exit 0.
- [ ] The native engine emits (4, 2, 0) for an emitter, and zero for non-emissive and unlit draws. proof: `native_engine_renderer_emissive_target` — open: the coordinator sandbox had no Vulkan driver, and the test rejects Dawn Null.
- [x] The GTAO and SSGI stages keep emission out of the occlusion: `input * ao + emissive * (1 - ao)`. proof: L8 `spheres` capture before and after, emitter underside 0.899 to about 0.997 of Unreal — Evidence: 2026-10-21, `sun60/spheres`, two runs per arm, bottom fifth of `Sphere_Emissive` (ID mask) as a share of Unreal's mean sRGB value: before 0.944 (both runs), after 0.999 (both runs). The cause was the alpha channel: both stages did `input.mul(occlusion.r)`, which scales alpha with the colour, and they now scale the colour only (commit on `lane/gi`, `worldEnvironment.ts`). An arm with the emissive target removed (emitted radiance 0) also reads 0.999, so the emission exemption has no measured effect on this scene; it stays because Unreal's AO keeps emission. Whole-frame mean absolute difference to Unreal 7.34 to 7.05; fresh read-only Sonnet judge verdict IMPROVEMENT (PR #541 comment 6325089174, BEFORE / AFTER / Unreal 5.8.3).

## Decisions

- 2026-10-19: No BRDF PRD is filed. three.js r185 and the native standard shader both already
  compensate GGX multi-scatter. Both use Lambert diffuse and F0 = 0.04 for dielectrics, as
  Unreal's default lit does (`Engine/Shaders/Private/ShadingCommon.ush:122`;
  `Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp:2147`).
- 2026-10-19 (external visual review, checked): Unreal's interior is cool and darker toward the back
  because Lumen occludes the sky inside the room (layer L7). Before the GI PRDs land, the installed
  `ProbeVolume` (static bake) is the candidate for interior sky occlusion; the AO change in this PRD
  only stops AO from darkening direct light.
- 2026-10-20 (GI set for PR #541): with dynamic GI on (L7 and up), Unreal replaces SSAO with Lumen Short Range AO. That AO is [PRD-640](../gi/PRD-640-pixels-gather-bounce-light-from-screen-probes-and-the-radiance-cache-answers-the-rest.md) Phase 3 (`ShortRangeAO`). GTAO on indirect light, from this PRD, stays the AO of the `low` tier ([PRD-644](../gi/PRD-644-the-gi-tier-follows-unreal-quality-levels-and-the-measured-gpu-time.md)).
- 2026-10-20 (emissive MRT, folded from a coordinator note): the first native pixel run used Dawn Null, so its pixel failure is not a valid radiance red. A control that omitted only the new pass calls failed the post consumer with `TN_POST_INPUT_MISSING: emissive`, and `emissive_validation` passed after the calls returned. That test checks target creation, post binding and readback completion on Null. It makes no pixel claim on that backend. A native label run reached 305 of 438 passed on a host with no Vulkan driver, so no native pixel claim stands.
- 2026-10-20 (reflection capture, folded from a coordinator note; blocked on a GPU and browser capture): smooth metal meshes capture the scene once from their own position through the existing `probes::captureFace` on both hosts, and the six HDR faces convert to an equirectangular texture for the existing PMREM. The consumer path is `Reference.enter` after the GI cache completes, then `material.envMap`, then the SSR miss fallback. The face size is 256 texels (about 0.35 degrees at the face centre, six 256 squared HDR faces per mesh), which bounds the static startup cost. There is no parallax correction and no dynamic recapture. `CubeCamera` stays unsupported because `render-target.ts` rejects nonzero faces. Proof so far: `sphere-reflection-capture.spec.ts` 3 passed (red on the missing module first), `unreal-look-reflection-capture.spec.ts` 2 passed. The native case `native_engine_probe_capture_environment` fails on the Null backend, and the unchanged HEAD fails the same assertions. Open: the L8 and L9 captures of `sun60/spheres` and `sun15/spheres`, a fresh visual judge, and the startup receipt (the hold includes capture and material PMREM preparation). Unreal source: `Engine/Source/Runtime/Engine/Classes/Engine/SphereReflectionCapture.h:12-17` and `Engine/Source/Runtime/Renderer/Private/ReflectionEnvironmentCapture.cpp:2311-2324,2473`. No Unreal code was copied.
- 2026-10-21 (look lane, spheres): the ring of black under each sphere at L9 was a stacking bug, not a GTAO radius. The chain runs the contact stage first, then the SSGI gather over the cache, whose correction `albedo * (hit - cache)` is added unscaled. Ablation at sun15, chrome foot, floor luma: GTAO only 13 to 19, SSGI only no ring, both 0 (50.6 % clipped), both with the correction clamped at 0 or scaled by the contact term 11 to 20 (Unreal 11 to 17). The harness `worldEnvironment.ts` now scales the correction by the contact term. This is a stopgap inside the composite multiply: Phase 2 moves GTAO onto indirect light, which removes the stacking at its root.
- 2026-10-21 (gi2 lane, emitter spill; measured, no render change): on the reference scene at L7 (`sun04/exterior`, floor 0.5 to 1 m from the emissive sphere, red channel above the generic level) the physical spill is 0.38, the cache alone gives 0.37, the cache plus the screen gather gives 0.66, and Unreal gives 0.20. The sphere's own radiance already matches Unreal (green 7.07 against 7.12, blue 3.54 against 3.57). The extra 0.29 is the gather's estimator. `packages/three-native/src/addons/screen-space.ts:518` reads the fallback at the pixel, and line 561 adds `hit - fallback` for every ray that hits. The fallback holds the analytic emitter share S, so the rays that miss keep S and the rays that hit the sphere add its radiance again. The bias is P(miss) x S x albedo, 0.7 x 2.2 x 0.18 = 0.28. An attempt to cancel it in `giCache.irradiance` (the emitter's radiance for a hit on the emitter) had no effect: BEFORE 0.701 and AFTER 0.705 at 0.5 to 1 m, run 1 of each arm, because the gather passes the pixel's position, not the hit's. It is reverted. The next step is in the gather: take the frame without the analytic emitters' emission and the fallback without their share, or subtract per ray. A wide emitter that the rays carry (a panel wider than a cell) keeps its emission. Unreal then still reads 0.5 of physical within 1 m, which is the Short Range AO of PRD-640 Phase 3. The Phase 4 box on `native_engine_renderer_emissive_target` stays open.
