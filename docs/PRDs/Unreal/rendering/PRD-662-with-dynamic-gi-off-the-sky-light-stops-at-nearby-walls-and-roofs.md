---
prd_contract: v1
---

# PRD-662 — With dynamic GI off, the sky light stops at nearby walls and roofs

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: Unreal runs distance field AO only when Lumen is off, so a fresh Epic project never shows it, and the gate decides if a GPU path pays.
**Complexity:** 6 (MEDIUM) — 4–6 files: the trace pass, upsample, specs, conformance (+1), new module `sky-light-occlusion.ts` (+2), state across frames: a short visibility history (+1), native proof (+1), changes the frame cost of tiers without dynamic GI (+1); risk override: none
**Owner:** João
**Depends on:** PRD-644 (`docs/PRDs/Unreal/gi/PRD-644-the-gi-tier-follows-unreal-quality-levels-and-the-measured-gpu-time.md`, on `feat/unreal-look-epic`): its `distanceFieldAO` tier field is the switch. PRD-631 (`docs/PRDs/Unreal/look/PRD-631-an-unreal-reference-scene-measures-the-default-look.md`, same branch) supplies the L6 thresholds. Builds on the shipped `GPUSceneBVH` (`packages/core/src/gpu-scene-bvh.ts`).

## Context

**Unreal LOC:** 17,059 for global and mesh distance fields (10,870 C++, 6,189 shader), from the
feature map. The AO consumer alone is about 3,100 lines (`DistanceFieldAmbientOcclusion.cpp`,
`DistanceFieldScreenGridLighting.cpp`, `DistanceFieldLightingPost.cpp` and their shaders). **Port
estimate:** about 500 to 700 ThreeNative lines, because the trace already exists in `GPUSceneBVH`.
This PRD builds no distance field.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **It runs only without Lumen.** The renderer allows distance field AO only for a view whose
  diffuse indirect method is not Lumen
  (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/DeferredShadingRenderer.h:468-480`), and only for
  a movable sky light that casts shadows
  (`Engine/Source/Runtime/Renderer/Private/DistanceFieldAmbientOcclusion.cpp:725-738`). With Lumen on,
  Lumen occludes the sky itself.
- **The tiers.** `r.DistanceFieldAO` is 1 and `r.AOQuality` is 2 by default
  (`DistanceFieldAmbientOcclusion.cpp:26, 50`). GI quality Low turns both off and scales the sky
  light by 0.8 (`Engine/Config/BaseScalability.ini:318-323`). Medium turns them on at quality 1
  (`BaseScalability.ini:327-330`). Mobile is off (`DistanceFieldAmbientOcclusion.cpp:34`).
- **The sky light's own values.** Occlusion reaches 10 m (`OcclusionMaxDistance` 1000 cm),
  `MinOcclusion` is 0 and `OcclusionExponent` is 1
  (`Engine/Source/Runtime/Engine/Private/Components/SkyLightComponent.cpp:316-318`).
- **The trace.** Each pixel of a half-resolution screen grid
  (`Engine/Source/Runtime/Renderer/Private/DistanceFieldAmbientOcclusion.h:27`) traces 9 cones
  (`Engine/Source/Runtime/Renderer/Private/DistanceFieldScreenGridLighting.cpp:35`). The cone half
  angle comes from the 9 spaced directions (`DistanceFieldAmbientOcclusion.cpp:277`). The result is a
  visibility and a bent normal. AO stops at 200 m from the camera (`DistanceFieldAmbientOcclusion.cpp:85`).
- **The field it traces.** Near cones read mesh distance fields. Far cones read a global distance
  field of 4 clipmaps (`Engine/Source/Runtime/Renderer/Private/GlobalDistanceField.cpp:82`) at 128³
  each (`GlobalDistanceField.cpp:162`).

So in Unreal the outcome exists only in projects that turn Lumen off but keep GI quality Medium or
higher: for example a stylised game, or a mid-range target that drops Lumen.

### ThreeNative today

- **The reference harness** (`scripts/unreal-look/scaffold/render/giCache.ts`, on `feat/unreal-look-epic`)
  already copies the outcome on the CPU for layers L2 to L6. Its `skyShadowDistance` option bakes the
  open fraction of each probe's hemisphere up to 10 m into the 1 m probe field. `Reference.ts.in`
  sets 0 m at the `low` tier, as Unreal Low does. This is a probe bake, not a per-pixel term, so
  contact-scale sky occlusion under a table or at a wall foot is lost between probes.
- **Runtime:** no package samples sky visibility per pixel. GTAO in the templates is screen-space only
  (PRD-635 moves it onto indirect light). `ProbeVolume` (`packages/core/src/render/probe-volume.ts`)
  is a static bake.
- **The trace:** `GPUSceneBVH` gives a first-hit ray query in TSL. The feature map records that it
  gives the trace in place of distance fields.

## Solution

**The gate first (Phase 1).** On the PRD-631 interior pose and the `sunlit-room` and `cornell`
calibration scenes at L6 (no dynamic GI), measure the per-region error of the CPU probe bake against
Unreal. Measure the GPU time of a test pass that traces 9 rays per half-resolution pixel through
`GPUSceneBVH` to 10 m. **Continue only if** the probe bake misses the PRD-631 L6 threshold in a
region where contact-scale sky occlusion dominates, and the test pass costs at most 1 ms at
1920 × 1080 on the RTX 2080. Otherwise record the result under `## Decisions` and delete Phases 2
and 3 (R4).

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Mesh and global distance fields | `GPUSceneBVH`, no new field | core, shipped |
| Screen grid at half resolution, 9 cones | `packages/core/src/render/sky-light-occlusion.ts` (new): 9 rays per half-res pixel, a first hit within `occlusionMaxDistance` counts as blocked | core mechanism |
| Visibility and bent normal | the same module, one `rgba16float` target | core mechanism |
| Upsample and temporal filter | the same module, a depth-aware upsample and a short history on the velocity target | core mechanism |
| Sky light multiplier, `minOcclusion`, `occlusionExponent` | the template's `src/render/worldEnvironment.ts` and `quality.ts` | generated template source |

- **Name.** `SkyLightOcclusion`, with `@alias distance field ambient occlusion`, `@alias dfao` and
  `@alias sky occlusion`. Options use Unreal's sky light names in camelCase:
  `occlusionMaxDistance` (metres, default 10), `minOcclusion` (0), `occlusionExponent` (1).
- **Auto by default.** It runs when the tier sets `distanceFieldAO` and no dynamic GI runs, as in
  Unreal. A game that turns it off is reported as overridden in `TN_GI`.
- **The look stays the game's.** The module returns visibility only. How visibility scales the sky
  term is template source.
- **Deferred, not built:** global and mesh distance fields themselves. Revisit when a measured scene
  shows `GPUSceneBVH` tracing too slow for this pass or for PRD-603, or when a consumer needs a
  distance query (soft shadows from a field, particle collision) that a BVH first hit cannot answer.

**Revisit condition if the gate defers the build:** a game or template ships with dynamic GI off
and an interior lit by the sky, or the PRD-631 L6 error stays above threshold after the other L6
work lands.

## Acceptance Criteria

- [ ] AC-1 [local]: The L6 cells of the interior pose and of `sunlit-room` match Unreal within the PRD-631 thresholds with `SkyLightOcclusion` on. proof: `pnpm unreal-look:compare --layer L6` and `pnpm unreal-look:compare --scene gi:sunlit-room --layer L6` — Evidence: pending.
- [ ] AC-2 [local]: The pass costs at most 1 ms GPU at 1920 × 1080 on the RTX 2080. proof: `node packages/playtest/dist/runner/cli.js perf`, on against off — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `SkyLightOcclusion` | harness `worldEnvironment.ts` when the tier sets `distanceFieldAO` and `finalGatherMethod` is `"none"` | Replaces the `skyShadowDistance` probe bake as the L2 to L6 sky occlusion; the bake stays for the radiance cache | AC-1 |

## Execution Phases

#### Phase 1: Does the probe bake miss contact-scale sky occlusion?
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/worldEnvironment.ts` (measurement only)
- [ ] The L6 per-region error of the probe bake against Unreal is recorded under `## Decisions` for the interior pose, `sunlit-room` and `cornell`. proof: `pnpm unreal-look:compare --layer L6`.
- [ ] The GPU time of a 9-ray half-resolution `GPUSceneBVH` test pass is recorded with the gate verdict. proof: the frame budget's `gpuMs` at 1920 × 1080, test pass on against off.

#### Phase 2: The occlusion pass
**Status:** NOT STARTED
**Files:** `packages/core/src/render/sky-light-occlusion.ts` (new), `packages/core/src/index.ts`, `packages/core/__tests__/sky-light-occlusion.spec.ts` (new), `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] A point under a slab 2 m above returns visibility near 0.5 or lower, the same point with the slab 12 m above returns 1, and the bent normal points toward the open side. proof: `pnpm exec vitest run packages/core/__tests__/sky-light-occlusion.spec.ts`.
- [ ] A capability search for "distance field ambient occlusion" returns `SkyLightOcclusion`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: Judge and native
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `packages/runtime-native/conformance/scenes/shared/sky-light-occlusion.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A fresh visual judge on the L6 interior pose (BEFORE the probe bake, AFTER `SkyLightOcclusion`, Unreal L6 as the target) returns IMPROVEMENT with no REGRESSION frame. proof: headed `--browser-recipe webgpu` captures, 2 runs per arm, judged by a fresh read-only subagent.
- [ ] The conformance row `sky-light-occlusion` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests sky-light-occlusion`.
**Verification:** AC-1 and AC-2.
