---
prd_contract: v1
---

# PRD-643 — Glass, fog and leaves take the bounce light too

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: GI reaches opaque materials only, so glass, particles and fog inside a room glow with the sky and a leaf lit from behind stays dark.
**Complexity:** 5 (MEDIUM) — 1–5 files: the translucency read, the fog read, the foliage term, specs, one conformance scene (+1), per-pixel and per-froxel cost (+2), native proof (+1), two consumers with different render paths (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 and [PRD-604](../rendering/PRD-604-a-surface-is-lit-only-by-probes-that-can-see-it.md) Phase 2 (the radiance cache and its visibility-weighted read). [PRD-638](PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 1 (the scene pipeline), [PRD-646](PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) Phase 2 and [PRD-647](../../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md). This PRD authors the `foliage` calibration scene.

## Context

- The harness feeds GI to materials by replacing each mesh material with a `MeshStandardNodeMaterial`
  whose `irradianceNode` reads the cache (`scripts/unreal-look/scaffold/render/giCache.ts`). Phase 1
  checks which translucent, transmissive and particle materials this reaches. A material that it does
  not reach takes the environment's diffuse light, which is the sky.
- Volumetric fog ships ([PRD-VQ-07](../../done/PRD-VQ-07-volumetric-fog.md)). Its froxels take the sun
  and the sky. Phase 1 checks whether any GI term reaches them.
- `TN_UNLIT_FOLIAGE` (`packages/core/src/index.ts:665`) warns when imported foliage has no
  image-based light. No foliage material takes indirect light through its back face.
- PRD-604 already gives two-sided hits a 4× distance in the probe visibility, as Unreal does, so a
  leaf does not shut a probe off.

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

- **A translucency GI volume.** A camera froxel grid, 32 px cells at Epic and Cinematic, 64 at High,
  128 at Medium, to 80 m, is filled from the radiance cache. At Epic it also cone-traces the global
  distance field (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenTranslucencyVolumeLighting.cpp`;
  `Engine/Config/BaseScalability.ini`). It reprojects in time with a 0.9 history weight. Medium
  shares the opaque radiance cache.
- **Volumetric fog reads the same volume** (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/VolumetricFog.cpp`,
  `LUMEN_GI` permutation).
- **Two-sided foliage gathers its back face.** At Epic and Cinematic the gather adds a back-face
  diffuse term: `diffuse colour × front + subsurface colour × back` (`TwoSidedFoliageBackfaceDiffuse`).
  At High the subsurface colour is added without a separate gather. Foliage takes 0.7 of the short
  range AO (UE 5.8.3: `Engine/Shaders/Private/DiffuseIndirectComposite.usf`).

## Solution

1. **Measure (Phase 1).** On the `foliage` calibration scene (authored here with the PRD-638 pipeline) at L7, compare the glass pane, a fog-filled room and the
   `foliage` pose against Unreal Epic. List the materials that take no GI and the fog froxels that
   take none.
2. **Translucent materials and fog read the radiance cache (Phase 2).** ThreeNative draws translucency
   forward, so a translucent pixel can read the radiance cache directly with the same
   visibility-weighted sampler as opaque pixels. That is cheaper than a second froxel volume, and the
   result is the same light. The fog's froxel pass samples the cache once per froxel at its centre.
   A froxel volume like Unreal's is built only if Phase 2 measures the per-pixel read above 0.5 ms
   on a full-screen glass pane at 1920 × 1080. The decision goes under `## Decisions`.
3. **Foliage back face (Phase 3).** A material marked as two-sided foliage reads the radiance cache
   twice, along the normal and against it, and adds `subsurfaceColor × back`. It takes 0.7 of the
   Short Range AO. The material keeps its colours: the mechanism reads the material's own
   `subsurfaceColor`, and a material without one gets no back term. The name follows Unreal's
   shading model, `twoSidedFoliage`. Phase 3 first runs `engine_search_capabilities "two sided foliage"`
   and reuses an installed foliage material if one exists.

**Names and manifest.** The cache read for translucency carries `@alias lumen translucency volume`
and `@alias translucency gi`. The foliage term carries `@alias two sided foliage` and
`@alias subsurface color`.

**Where each part lives.** The reads are mechanism beside the radiance cache in `packages/core/src/render/`.
The subsurface colour, the AO factor and the fog density are look values in game or template source.

## Acceptance Criteria

- [ ] AC-1 [local]: The glass pane and the fog-filled room regions on the owned engine match Unreal Epic within the PRD-631 thresholds at L7. proof: `pnpm unreal-look:compare --scene gi --layer L7` — Evidence: pending.
- [ ] AC-2 [local]: The back-lit leaf region of the `foliage` pose matches Unreal Epic within the thresholds. proof: the same command — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The conformance row `translucency-gi` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests translucency-gi` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Translucency reads the radiance cache | Translucent and transmissive node materials in the game | Replaces the sky's diffuse term on those materials | AC-1 |
| Fog reads the radiance cache | The VQ-07 volumetric fog froxel pass | Adds a GI term to the sun and sky terms | AC-1 |
| Two-sided foliage back face | Materials marked `twoSidedFoliage` | New | AC-2 |

## Decisions

Lane glassfog, 2026-10-21. The engine owns the mechanism. The harness render source owns the look.

1. **The lane builds `glass` and `fog`, not `foliage`.** Two scenes isolate the two materials that Phase 1
   names, and each scene has one cause. `foliage` waits for the `shadow:wildwood` scene (lane wildwood).
   The Phase 3 box and AC-2 stay open until that scene lands.
2. **Unreal's default translucent material takes the translucency volume, the same in every direction.**
   The lighting mode is Volumetric NonDirectional (UE 5.8.3: `Engine/Shaders/Private/TranslucencyVolumeCommon.ush`,
   `GetVolumeLightingNonDirectional`). The read is the L0 term times 0.886227, which is the irradiance averaged over
   every normal. A lamp therefore gives a pane one quarter of what a surface that faces the lamp receives.
   A translucent-only material casts no dynamic shadow (`Engine/Source/Runtime/Engine/Public/MaterialShared.h`,
   `ShouldCastDynamicShadows`), so the pane needs no shadow term. The harness reports any other mode as
   unsupported (`translucencyLightingMode`).
3. **The look is harness source. The mechanism is engine source.** `scripts/unreal-look/scaffold/render/translucency.ts`
   swaps each unmapped translucent material for an unlit twin. The twin keeps the blending, opacity, sides and
   depth write, and takes its colour from the light. The lamps are read live as point lights, unshadowed, at one
   quarter. A spot light throws `TN_TRANSLUCENT_LIGHT`. `giCache.meanRadiance` adds the room's bounce light.
   `ProbeVolume.sampleNonDirectional` (`packages/core/src/render/probe-volume.ts`) is the engine read: one atlas
   fetch of the L0 term, not the seven fetches of `sampleNode`.
4. **Fog takes the same mean field.** The starter's volumetric fog gains `ambientNode`, a function of the step's world
   position. It adds to `ambient` and carries no phase term, because a radiance that is the same in every direction
   integrates to itself over a phase function. The harness passes `giCache.meanRadiance` from L7.
5. **The owned engine refused three things in the fog pass. The lane fixed all three in the template.** The TSL
   front end refuses a Matrix4 value for `uniform` (`TN_TSL uniform: argument 0 ...`). The catalog lists
   `getViewPosition` as unsupported on the Wasm engine (`TN_NATIVE_UNSUPPORTED_GETVIEWPOSITION`), but the native
   host implements it (`packages/runtime-native/src/engine/abi/tsl_call.cpp:268`). The shader IR compares two values
   of one type and selects on a bool scalar (`packages/runtime-native/src/engine/shader/ir.cpp`, `less`, `select`,
   `greaterEqual`), where three broadcasts a scalar against a vector (`TN_TSL_TYPE: greaterEqual: takes two equal
   numeric values`). The template now builds the camera matrices from four live `vec4` columns, has its own
   `viewPosition` helper, and writes both comparisons as same-type nodes and the ray sign as arithmetic. Two specs in
   `vq-volumetric-fog.spec.ts` fail when a refused value, call, comparison or select returns. The three engine gaps
   stay open as engine work.
6. **BEFORE is the epic head plus the fog start fixes.** The epic head cannot start the fog scene on the owned
   engine, so a BEFORE without those fixes has no fog frame to compare.
7. **Native proof is the conformance row `translucency-gi`.** `ProbeVolume` is JavaScript on both engines, so the
   lane adds no C++. The row draws a translucent pane that reads `sampleNonDirectional` beside an opaque panel that reads the directional `sampleNode` of the same volume. The runner compares web with desktop.

## Execution Phases

#### Phase 1: What takes no GI
**Status:** IN PROGRESS (glass and fog; `foliage` waits for the `shadow:wildwood` scene)
**Files:** `tools/unreal-reference/gi/{glass,fog}/{scene.py,criteria.md}` (new), `tools/unreal-reference/gi/foliage/{scene.py,criteria.md}` (new, open), `tools/unreal-reference/gi/scenes.json`
- [ ] `glass` and `fog` are ready to calibrate: built and captured in Unreal, recreated with direct light matching (PRD-646), their silhouettes agree, and their PRD-647 criteria are written. proof: `pnpm unreal-look:capture --engine unreal --scene gi:glass,gi:fog --check-cvars` and `pnpm unreal-look:compare --sameness --scene gi:glass,gi:fog`.
- [ ] The materials and fog froxels that take no GI on `glass` and `fog` are listed under `## Decisions`, with the per-region error against Unreal Epic. proof: `pnpm unreal-look:compare --scene gi:glass,gi:fog --layer L7`.
- [ ] `foliage` is ready to calibrate: authored and captured in Unreal, recreated with direct light matching (PRD-646), and its PRD-647 criteria written. It reuses the `shadow:wildwood` scene when that lands. proof: `pnpm unreal-look:capture --engine unreal --scene gi:foliage --check-cvars` and `pnpm unreal-look:compare --scene gi:foliage --layer L1`.

#### Phase 2: Glass and fog
**Status:** IN PROGRESS
**Files:** `packages/core/src/render/probe-volume.ts`, the VQ-07 fog pass (`packages/create-threenative/templates/starter/src/render/volumetricFog*.ts`), `scripts/unreal-look/scaffold/render/{translucency,giCache}.ts`, `packages/core/__tests__/probe-volume.spec.ts`
- [ ] A translucent pixel and a fog froxel read the same irradiance as an opaque pixel at the same point. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`.
- [ ] The per-pixel read on a full-screen glass pane costs no more than 0.5 ms at 1920 × 1080, or the froxel decision is recorded. proof: `node packages/playtest/dist/runner/cli.js perf` on the harness.

#### Phase 3: Leaves lit from behind
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-volume.ts`, `packages/core/__tests__/probe-volume.spec.ts`, `packages/runtime-native/conformance/scenes/shared/translucency-gi.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A `twoSidedFoliage` material adds `subsurfaceColor ×` the back-face irradiance, and a material without `subsurfaceColor` adds nothing. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`.
**Verification:** AC-2 and AC-3. A PRD-647 round on `foliage` at `high`, Unreal Epic as the target, must return IMPROVEMENT against BEFORE on the `foliage` and `glass` poses.
