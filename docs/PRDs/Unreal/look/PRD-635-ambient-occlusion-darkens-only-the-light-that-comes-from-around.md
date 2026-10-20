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

#### Phase 3: Every AO template, native included
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/worldEnvironment.ts`, `packages/runtime-native/conformance/scenes/shared/ao-indirect-only.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The native engine applies AO to indirect light only, within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests ao-indirect-only`.
- [ ] The 10 GTAO templates use the new path, and the template gate passes. proof: `pnpm test:templates`.
- [ ] Every affected template's `AGENTS.md` (and mirror) states AO on indirect light only, and how a game returns to the composite multiply, so a new project's agent knows the default and how to override it. proof: `rg -l 'builtinAOContext' packages/create-threenative/templates/*/AGENTS.md` lists every affected template, and `pnpm sync:agents --check` exits 0.

## Decisions

- 2026-10-19: No BRDF PRD is filed. three.js r185 and the native standard shader both already
  compensate GGX multi-scatter. Both use Lambert diffuse and F0 = 0.04 for dielectrics, as
  Unreal's default lit does (`Engine/Shaders/Private/ShadingCommon.ush:122`;
  `Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp:2147`).
- 2026-10-19 (external visual review, checked): Unreal's interior is cool and darker toward the back
  because Lumen occludes the sky inside the room (layer L7). Before the GI PRDs land, the installed
  `ProbeVolume` (static bake) is the candidate for interior sky occlusion; the AO change in this PRD
  only stops AO from darkening direct light.
