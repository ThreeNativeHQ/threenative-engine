---
prd_contract: v1
---

# PRD-VQ-09 — A door that opens and a lamp that switches change the bounce light

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: the traced radiance cache of PRD-603 reacts only to a global sun or sky step, and its BVH holds static triangles only, so a door, a lamp or a moved crate changes no bounce light.
**Complexity:** 7 (HIGH) — 1–5 files: dirty regions, a dynamic BVH part, specs, one conformance scene (+1), complex state: dirty bounds, a per-frame refit and probe generations (+2), changes the trace kernel's inputs (+2), native proof (+1), two prerequisite PRDs (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-603](../Unreal/rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 3 (the stale queue, generations and the lighting-step rule). [PRD-638](../done/PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phases 2 and 3 (`sunlit-room` and the motion pipeline), the `neon` run of [PRD-641](../Unreal/gi/PRD-641-bounce-light-holds-still-while-the-camera-moves-and-follows-a-light-that-changes.md), and [PRD-647](../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md). This PRD authors the `door` and `occluder` runs. Part of the GI set in [`../Unreal/gi/`](../Unreal/gi/) (PR #541).

## Context

**Re-scoped 2026-10-20.** This PRD was filed on 2026-10-01 against the cube-capture `ProbeVolume`,
before PRD-603 planned a traced refresh. No box was ticked and no code was written. The outcome is
the same: a local change updates the bounce light near it, and no reader sees a half-updated field.
The mechanism now follows PRD-603.

- PRD-603 gives the `RadianceCache` a stale queue, probe generations that publish only when complete,
  and a lighting-step rule. That rule reads the sun direction, the sun colour and the sky value. It
  does not see a local lamp, an emissive material that changes or a mesh that moves.
- `GPUSceneBVH` (`packages/core/src/gpu-scene-bvh.ts`) packs the static scene triangles once. A door
  that swings stays closed in the trace. The harness `giCache.ts` is a fixed-world bake: "move a wall
  and bake again".

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

- **A moved primitive invalidates its own data.** Its surface cache cards are captured again inside
  the per-frame capture budget (`r.LumenScene.SurfaceCache.CardCaptureEnableInvalidation=1`; UE 5.8.3:
  `Engine/Source/Runtime/Renderer/Private/Lumen/LumenSceneRendering.cpp`). The global distance field
  updates the regions of movable objects, 2 clipmaps per frame
  (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/GlobalDistanceField.cpp`).
- **Lights refresh the cache by budget.** Direct lighting of the surface cache refreshes atlas ÷ 32
  texels per frame at Epic, and the radiance cache traces its stalest used probes first
  (PRD-603 cites the files).
- **Skinned meshes are poor occluders in software tracing.** They have no mesh distance field and get
  cards from their bounds only, and Medium turns those off (`r.MeshCardRepresentation.SkeletalMesh=0`;
  UE 5.8.3: `Engine/Config/BaseScalability.ini`).
- **Each primitive can opt out.** "Affect Dynamic Indirect Lighting" (`bAffectDynamicIndirectLighting`)
  on a primitive removes it from Lumen (UE 5.8.3: `Engine/Source/Runtime/Engine/Classes/Components/PrimitiveComponent.h`).

## Solution

1. **Measure (Phase 1).** Run the `door` and `occluder` runs, which this PRD authors on `sunlit-room` with the PRD-638 pipeline, and the PRD-641 `neon` run, on the owned engine with
   PRD-603 as it lands: static BVH, a full re-trace on `requestBake`. Record response frames, the
   probes traced per change and the frame cost. Unreal Epic's response from the same runs is the
   target.
2. **Dirty regions (Phase 2).** A change marks a box stale, not the whole field:
   - a GI light whose position, range, colour or intensity changes marks its range;
   - an emissive material whose colour or intensity changes marks the bounds of its meshes;
   - a mesh whose world matrix changes marks its old and new bounds.
   Each box grows by the trace distance of the probes. The probes inside it move to the front of the
   PRD-603 queue, and the old values serve until each new generation is complete. A change smaller
   than the noise floor marks nothing.
3. **Moving meshes in the trace (Phase 3).** The trace reads two parts: the static `GPUSceneBVH` and
   a dynamic part for rigid meshes that moved. Each moved mesh keeps its own small BVH, and the
   kernel transforms the ray into that mesh's space, as a two-level ray tracing scene does. A frame
   updates only the transforms of moved meshes. Skinned meshes stay out of the trace, as in Unreal
   software tracing, and the report counts them.

**Names and manifest.** The per-object switch is `affectDynamicIndirectLighting` (default `true`),
Unreal's primitive property in camelCase. The manifest entry carries
`@alias affect dynamic indirect lighting` and `@alias lumen dynamic update`.

**Where each part lives.** Dirty regions and the dynamic BVH are mechanism in
`packages/core/src/render/` and `packages/core/src/gpu-scene-bvh.ts`. Which objects move, and which
lights change, is the game's. `TN_PROBE_VOLUME` adds the dirty boxes this frame, the probes they
marked, the moved meshes in the trace and the skinned meshes left out.

## Acceptance Criteria

- [ ] AC-1 [local]: In the `door` run on the owned engine, the lit floor of the second room reaches 90% of its settled value in no more frames than Unreal Epic's response. proof: `pnpm unreal-look:compare --scene gi --metric motion`, `door` run — Evidence: pending.
- [ ] AC-2 [local]: In the `neon` run, no probe outside the neon's dirty box is traced beyond the steady budget. proof: the `TN_PROBE_VOLUME` dirty-probe count in the same run — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The conformance row `radiance-cache-door` passes on the desktop lane: a moved box changes the irradiance behind it within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests radiance-cache-door` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Dirty regions | Any GI light, emissive material or mesh the game changes | Replaces a full `requestBake` for local changes; `requestBake` stays for a full refresh | AC-1, AC-2 |
| Moving rigid meshes in the trace | Meshes whose world matrix changes | Extends `GPUSceneBVH`; static scenes trace as before | AC-1, AC-3 |
| `affectDynamicIndirectLighting` | A per-object flag the game sets | New. Default `true` | Phase 2 |

## Execution Phases

#### Phase 1: How a local change behaves today
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/gi/sunlit-room/scene.py` (the `door` and `occluder` runs), `tools/unreal-reference/gi/scenes.json`
- [ ] The `door` and `occluder` runs render 180 frames in both engines with matching frame counts. proof: `pnpm unreal-look:capture --engine unreal --scene gi:sunlit-room --motion door,occluder` and `pnpm unreal-look:compare --scene gi:sunlit-room --metric motion`.
- [ ] Response frames, probes traced per change and frame cost for the three runs, with Unreal Epic's response, are recorded under `## Decisions`. proof: `pnpm unreal-look:compare --scene gi --metric motion`.

#### Phase 2: A change marks a box stale
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-volume.ts`, `packages/core/src/render/radiance-cache.ts`, `packages/core/__tests__/probe-volume.spec.ts`, `packages/core/src/index.ts`, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] A changed light, emissive material or moved mesh marks only the probes in its grown box, and a change below the noise floor marks none. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`.
- [ ] An object with `affectDynamicIndirectLighting: false` neither marks probes nor appears in the trace. proof: the same spec.

#### Phase 3: Moving meshes in the trace
**Status:** NOT STARTED
**Files:** `packages/core/src/gpu-scene-bvh.ts`, `packages/core/src/render/probe-trace.ts`, `packages/core/__tests__/gpu-scene-bvh.spec.ts`, `packages/runtime-native/conformance/scenes/shared/radiance-cache-door.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A ray against a moved rigid mesh hits it at its new transform, and a skinned mesh is skipped and counted. proof: `pnpm exec vitest run packages/core/__tests__/gpu-scene-bvh.spec.ts`.
**Verification:** AC-1 to AC-3. A PRD-647 round on the `door` run (frames 0, 30, 60, 90 and 179) at `high`, Unreal Epic as the target, must return IMPROVEMENT against the Phase 1 run.

## Decisions

- 2026-10-20 (GI set for PR #541): re-scoped from the cube-capture `ProbeVolume` to the traced
  `RadianceCache` of PRD-603. The 2026-10-01 text had no ticked box and no code. The old blocker,
  "PRD-268 qualification", is gone: PRD-268 was superseded into PRD-267 on 2026-10-03.
