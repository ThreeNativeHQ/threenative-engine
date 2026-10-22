---
prd_contract: v1
---

# PRD-634 — Sun shadows reach the horizon and soften with distance from the caster

**Status:** PARTIAL
**Priority:** P2 — template integration and native parity remain open: the starter's sun shadow ends 14 m from the player and has the same edge width everywhere, while Unreal's default shadows cover the view and widen with the gap between caster and receiver.
**Complexity:** 6 (MEDIUM) — a shadow-filter mechanism in core (+2), the shadow method choice across 13 templates (+2), native proof of both (+2); risk override: the templates already reverted a virtual-shadow default once (level-boundary artefacts), so Phase 1 measures before anything changes.
**Owner:** João
**Depends on:** [PRD-631](PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 3 (the L5 row). Coordinates with [PRD-457](../rendering/PRD-457-virtual-shadows-scale-by-measurement.md), which owns virtual-shadow page cost. Builds on [PRD-572](../../done/PRD-572-shadow-casters-sort-themselves-into-static-and-moving.md) and [PRD-538](../../done/PRD-538-shadow-maps-redraw-only-what-streamed-in.md).

## Context

**ThreeNative today:**

- The starter draws one `PCFSoftShadowMap` sun map: 4096² on desktop, 2048² on phones, with an
  orthographic half-extent of 14 m and near/far 1/80 m
  (`packages/create-threenative/templates/starter/src/render/lighting.ts:11-26`). Other templates
  widen the box to 22–42 m. Past that box, nothing casts a shadow.
- The authored `radius: 2` changes nothing on the native engine: its PCF-soft branch is a fixed 3×3
  footprint (`packages/runtime-native/src/engine/shader/standard.cpp:719`). So the edge width is
  one constant, whatever the gap between caster and receiver.
- Core ships `VirtualShadowNode`, camera-following clip levels with a page cache
  (`packages/core/src/render/virtual-shadow.ts:867`). The templates stopped using it after level
  boundaries showed as shadows that suddenly turned sharp (`minimal/src/render/lighting.ts`
  comment). The done PRD-470 still claims `minimal` uses it, which is stale.
- [PRD-561](../../done/PRD-561-contact-shadows-from-screen-depth.md) declined screen-space contact shadows on 2026-10-10. Unreal agrees by default: its light's contact-shadow length is 0.

**Unreal 5.8.3** (source read 2026-10-19):

| Setting | Default | Source |
| --- | --- | --- |
| Method | Virtual shadow maps, turned on by the project generator | `Engine/Source/Editor/GameProjectGeneration/Private/GameProjectUtils.cpp:136` |
| Clipmap | 128² pages, 16384² virtual resolution, directional levels 6 to 22 | `Engine/Shaders/Shared/VirtualShadowMapDefinitions.h:13-20`; `Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapClipmap.cpp:57-63` |
| Penumbra | Shadow-map ray tracing (SMRT): 8 rays × 4 samples at High and Epic, from the light's source angle | `Engine/Config/BaseScalability.ini:224,262` |
| Sun source angle | 0.5357° | `Engine/Source/Runtime/Engine/Private/Components/DirectionalLightComponent.cpp:1050` |
| Contact shadows | Off (length 0) | `Engine/Source/Runtime/Engine/Private/Components/LightComponent.cpp:470` |
| Fallback without VSM | 4 cascades to 400 m, distribution exponent 3 | `DirectionalLightComponent.cpp:1038-1055` |

At 0.5357°, the penumbra is about 0.94 cm wide for each metre between the caster and the receiver.
A capsule's feet stay sharp, and a shadow cast from 10 m up spreads to about 9 cm.

## Solution

1. **Phase 1 decides the method by measurement, on the L5 cells.** It compares three candidates
   against the Unreal frames and the `high` frame budget:
   - the current single map widened to the view
   - three.js cascades
   - `VirtualShadowNode` with the boundary artefact fixed

   The winner becomes the template default. The decision and its numbers go under `## Decisions`.
   Phase 1 also states the artefact's cause before it rules on virtual shadows.
2. **A source-angle soft filter in core.** It searches the shadow map for the average blocker depth
   and widens the filter by `gap × tan(sourceAngle)`, clamped to the map's texel size. The angle
   comes from the game, and the templates set Unreal's 0.5357°. The filter is a mechanism:
   - it does not decide the look, because the angle is a game value
   - it runs on any of the three methods

   It replaces the fixed 3×3 on the native engine as well.
3. **Contact shadows stay off**, as in Unreal (PRD-561 holds).

## Acceptance Criteria

- [ ] AC-1 [local]: The starter L5 cells match the Unreal L5 cells within the PRD-631 thresholds in all 12 poses, including the shadowed-floor region of the exterior wide pose. proof: `pnpm unreal-look:compare --layer L5` — Evidence: pending.
- [ ] AC-2 [local]: In the sphere-row pose at a 15° sun, the penumbra width of the 10 m wall shadow is within 25% of the Unreal width. proof: `pnpm unreal-look:compare --layer L5 --metric penumbra` — Evidence: pending.
- [ ] AC-3 [local]: The chosen method holds the `high` frame budget on the RTX 2080 browser lane. proof: `node packages/playtest/dist/runner/cli.js perf` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Source-angle soft filter | `templates/*/src/render/lighting.ts` → `sun.shadow.sourceAngle` | Replaces the fixed PCF footprint, web and native | Phase 2 |
| View-wide sun shadow | `lighting.ts`, with the method chosen in Phase 1 | Replaces the 14–42 m box | Phase 3 |

## Execution Phases

#### Phase 1: Choose the method on the reference
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/shadow-candidates.ts` (new)
- [ ] The three candidates are scored on the L5 cells and on `high` frame time, and the winner is recorded under `## Decisions`. proof: `pnpm unreal-look:compare --layer L5 --candidates single,cascades,virtual`.

#### Phase 2: The source-angle filter
**Status:** PARTIAL — core mechanism and CPU checks only; GPU rendering, native parity and starter integration unverified.
**Files:** `packages/core/src/render/soft-shadow.ts` (new), `packages/core/__tests__/soft-shadow.spec.ts`, `packages/runtime-native/src/engine/shader/standard.cpp`
- [x] The filter width grows linearly with the caster gap, and is clamped at one texel for a gap of 0. proof: `pnpm exec vitest run packages/core/__tests__/soft-shadow.spec.ts` — 2026-10-19: 4 tests pass, exit 0; invalid inputs and GPU-free factory/node creation covered. `pnpm exec biome check packages/core/src/render/soft-shadow.ts packages/core/__tests__/soft-shadow.spec.ts packages/core/src/index.ts` and `pnpm --filter @threenative/core exec tsc --noEmit` both exit 0. Game supplies `sourceAngleRad`; `shadow.filterNode` uses blocker search and variable-radius PCF. GPU/visual results unverified.
- [ ] The native engine applies the same filter within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests soft-shadow-source-angle`.
- [ ] AC-2 passes on the starter. proof: `pnpm unreal-look:compare --layer L5 --metric penumbra`.

- [x] The harness tuned arm shadows the sun with `VirtualShadowNode` and the source-angle filter on the owned C++ Wasm engine, and the GPU render is clean. proof: `pnpm exec tsx scripts/unreal-look/capture.ts --engine threenative --layers L5` (RTX 2080, fresh scaffold) — 2026-10-20: 12 of 12 L5 cells render, no `TN_VIRTUAL_SHADOW_UNSUPPORTED`, `TN_NATIVE_*` or pipeline error. Four clip levels (scene radius / 4 to its diameter), 2048 texels, 512 mover maps: the native atlas is one square texture, so levels times pages must fit the 8192 limit (the default 4096 map and a 4096 mover map exceeded it and lost the renderer). Two engine faults found and fixed: a PCF radius of 2 was refused at the `shadowNode` setter although the filter replaces it (red `vsm_atlas_test`, green; the five `native_engine_vsm_*` tests pass), and the filter compared taps with the receiver depth, so a floor at a 15 degree sun shadowed itself in rings (acne metric 0.0303 to 0.0000, Unreal 0.0033). Harness: `sourceAngleShadowFilter` takes the angular radius, so the tuned arm passes half of Unreal's 0.7357 degree apex angle. Desktop V8 and cost unmeasured.
- [ ] AC-2 numbers on the starter template (not the harness): the harness reading is TN / UE edge width 1.51 in the sphere-row pose at a 15 degree sun, so AC-2 (within 25 percent) is still open. proof: `pnpm unreal-look:compare --layer L5 --threenative <dir> --metric penumbra` — 2026-10-20, engine-shadow4: exterior 1.06 / 1.07 / 1.03 (sun 60 / 15 / 4), spheres 1.75 / 1.51 / 1.60, interior 1.22 / 1.33 (sun 15 / 4), backlit 1.20 / 1.32 / 1.20; absolute median widths 1.9 to 7.2 px against Unreal's 1.9 to 5.9 px. The finest level's texel (7 mm, 1.5 px at the sphere pose) bounds the contact width; a fifth, finer level (scene radius / 8) cut the sun-60 sphere ratio to 1.31 but cut a notch out of a sphere shadow at a level boundary, so it stays out until that is understood. Round 2 (tolerance set first: every cell at or under 1.25, exterior and backlit stay 1.0 to 1.3): bilinear contact taps and a half-texel minimum disk, engine-bil1 spheres 1.60 / 1.54 / 1.59, interior 1.27 (sun 15), exterior 0.93 to 1.14, backlit 1.14 to 1.41; still open. The remaining width is the texel footprint (finest level 6.9 mm, 1.5 to 2.5 px at the sphere row). A fifth level (3.4 mm) gives spheres 1.29 / 1.45 / 1.63 and shows a static straight cut on the sun-60 capsule shadow and a polygonal sphere shadow (area 0.92 of Unreal), so it is not adopted until its cause is found.
- [x] The owned engine accepts `light.shadow.shadowNode = new VirtualShadowNode(...)` through its native clipmap atlas, with source-owned shadow settings preserved. proof: `pnpm exec vitest run packages/three-native` and Wasm VSM tests. **2026-10-22 (vsm-lane, epic 45568df88 merged in, all native targets rebuilt after the merge):** full `pnpm exec vitest run packages/three-native packages/core/__tests__/virtual-shadow.spec.ts packages/core/__tests__/soft-shadow.spec.ts` 40 files / 457 tests pass (exit 0), `run-native.spec.ts` included (11 tests, no stall); facade `tsc --noEmit` exit 0; Wasm `ctest -R native_engine_vsm` 5/5; desktop V8 (engine-only `tn-linux` with `TN_ENGINE_PLAYER`, Dawn) `ctest -R "native_engine_v8_|native_engine_vsm" -E "fixtures|half_float"` 38/38, so `native_engine_v8_scene` accepts the full default options record and the region command on V8 (the 3 `*_fixtures` rows need the fixture driver, which was not built, and stay unrun). Headed render: the harness tuned arm box below (RTX 2080, owned Wasm engine). The following is historical round-1 evidence, superseded by the round-3 status below; unsupported options must not be silently dropped. **2026-10-19 round 1 partial:** facade constructs core’s real node and installs fixed-depth configurations; source bias/normalBias/intensity/radius survive the registry setter. Focused facade regression: 3 pass (options-array serialization reproduced red, then green); Wasm VSM atlas/binding, continuous invalidation and sampling: 3/3 pass; `tn-native-engine-web` builds with `EM_CACHE=/tmp/shadownode-em-cache`; facade `tsc --noEmit` exits 0. Full `pnpm exec vitest run packages/three-native` stalled in unchanged `run-native.spec.ts` and was interrupted (130); rerun excluding that file passes 33 files / 240 tests (0). At round 1, default options refused `TN_VIRTUAL_SHADOW_UNSUPPORTED: automatic depth`; custom filters refused `TN_VIRTUAL_SHADOW_UNSUPPORTED: filterNode`. Desktop V8 and headed visual/playtest proof unverified; box remains open.

- [ ] Round 3: default native options schedule level refresh from measured cost; animated casters use mover maps, settle after quiet frames, and honour tracking/static overrides. proof: Wasm `native_engine_vsm_atlas`, `native_engine_vsm_continuous_invalidation`, `native_engine_vsm_sampling`; facade Vitest and `tsc --noEmit`. **2026-10-19 partial, uncommitted round-3 hunks:** default-options regression reproduced red (2 failed checks), then Wasm VSM atlas/binding/motion/adaptation/delay/focus, continuous invalidation and sampling pass 3/3 (exit 0). `tn-native-engine-web` builds (exit 0, `EM_CACHE=/tmp/shadownode-em-cache`). Core shadow + facade focused tests pass 127/127; facade excluding unchanged `run-native.spec.ts` passes 33 files / 242 tests (exit 0), facade `tsc --noEmit` exits 0. Requested full facade suite timed out after 240 s (124) with that driver lane unfinished. Native now accepts default policies; completed per-level GPU timestamps drive adaptive trails/gates/delay (measured CPU fallback only without timestamp queries), mover maps bypass the static cache with urgent regional eviction and quiet-frame readmission, and pin/track/untrack/invalidation commands cross the facade. Receiver bounds drive aerial focus; registered index-only LOD chains reach coarse static passes; authored bias/normalBias/intensity/radius and source-angle filtering remain active. Extended `33-virtual-shadow` conformance scene moves its caster and then settles it; not executed here. V8 options-record array conversion and its adapter regression are implemented but desktop V8 is unverified. Automatic depth still explicitly refuses GPU-only deformation (position nodes/projected GPU joints; fixed `lightDistance` plus `depthRange` remains supported); CPU skin/morph bounds are measured. Headed before/after captures and visual judge remain unverified: sandbox localhost listen fails `EPERM`, so no conformance server can start. Playtest doctor exits 0. Dashboard reporter also fails sandbox IPC `EPERM`; telemetry did not block work. Full native/browser visual parity is not claimed; box stays open.

#### Phase 3: Every template
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/lighting.ts`, `packages/create-threenative/templates/minimal/AGENTS.md` (and mirror)
- [ ] All templates use the chosen method and the filter, and the template gate passes. proof: `pnpm test:templates`.
- [ ] The `low` tier keeps one 2048² map with the filter, and the phone budget holds. proof: `pnpm test:templates` (starter, `low`).
- [ ] Every affected template's `AGENTS.md` (and mirror) states the view-wide sun shadow and its `sourceAngle`, with the override that restores a fixed box, so a new project's agent knows the default and how to override it. proof: `rg -l 'sourceAngle' packages/create-threenative/templates/*/AGENTS.md` lists every affected template, and `pnpm sync:agents --check` exits 0.

## Decisions

- 2026-10-20 (shadow slicing, source read): a fresh project runs shadow quality Epic, which sets `r.Shadow.Virtual.ResolutionLodBiasDirectional` −1.5 (`Engine/Config/BaseScalability.ini:258`). Its finest page texel is therefore about 2.8 times finer than the default bias gives. That bears on the open AC-2 texel-footprint gap and on the fifth-level trial. Epic also starts each SMRT ray after a 0.015 screen-space ray (`r.Shadow.Virtual.ScreenRayLength`), which narrows contact edges. [PRD-649](../shadows/PRD-649-shadow-calibration-scenes-are-built-in-unreal-and-judged-until-parity.md) measures both by ablation, and [PRD-652](../shadows/PRD-652-the-shadow-tier-follows-unreal-shadow-quality-levels.md) owns the tier table, so the Phase 3 `low` box follows it. No box changed.
- 2026-10-20 (round 2): the virtual shadow receiver reads the finest covering level first and stops when the blend weight is spent, reads the mover map only while a mover is active, and runs the 5-tap PCF only where the source-angle filter is off. Whole-frame median at 1920x1080 on the RTX 2080 (five-level arm, loaded host, noisy): 81.9 to 89.5 ms before, 55.8 to 82.6 ms after; p90 108.6 to 115.0 before, 95.5 to 102.5 after. The interior seam lines at sun 15 are blue sky fill (B above G above R, smooth gradient), not sun leakage. Sphere_Chrome casts (all meshes cast); the soft contact blob under it in Unreal is ambient occlusion, which the GI/AO lanes own.
- 2026-10-20: Unreal 5.8.3 shows no sun shadow at L1 to L4 (`r.Shadow.Virtual.Enable 0`, `r.ShadowQuality 0` in `layers.json`), so shadow cells are L5 and up. Its shadow edges on the reference scene are 1.5 to 3 px wide at every sun elevation (4 px on the sphere row at 4 degrees), far under the geometric penumbra of a 0.7357 degree sun at a 40 m caster gap. The model borrowed from `VirtualShadowMapSMRTCommon.ush` and `VirtualShadowMapProjectionDirectional.ush` is rays over the source disc of radius sin(angle / 2), with a ray length of 1.5 times the view distance (`r.Shadow.Virtual.SMRT.RayLengthScaleDirectional`); the harness matches the measured widths with the angular radius, not a second constant.

- 2026-10-19: Contact shadows stay declined (PRD-561). Unreal's default light has contact-shadow
  length 0, so the reference does not ask for them.
- 2026-10-19: Unreal's SMRT traces rays through the shadow map. This PRD copies the effect (a
  penumbra that grows with the caster gap), not the method. A blocker-search filter gives that
  effect on any shadow method, and WebGPU can run it.
- 2026-10-19: the measured source angle is 0.7357° (live 5.8.3 level dump, `template-actors.json`),
  not 0.5357°; the templates use the measured value. The starter's `shadow.radius = 2`
  (`templates/starter/src/render/lighting.ts:28`) is part of the blob look the review flagged;
  the source-angle filter replaces it.
