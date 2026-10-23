---
prd_contract: v1
---

# PRD-643 — Glass, fog and leaves take the bounce light too

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: GI reaches opaque materials only, so glass, particles and fog inside a room glow with the sky and a leaf lit from behind stays dark.
**Complexity:** 5 (MEDIUM) — 1–5 files: the translucency read, the fog read, the foliage term, specs, one conformance scene (+1), per-pixel and per-froxel cost (+2), native proof (+1), two consumers with different render paths (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 and [PRD-604](../rendering/PRD-604-a-surface-is-lit-only-by-probes-that-can-see-it.md) Phase 2 (the radiance cache and its visibility-weighted read). [PRD-638](../../done/PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 1 (the scene pipeline), [PRD-646](PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) Phase 2 and [PRD-647](../../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md). This PRD authors the `foliage` calibration scene.

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

- [ ] AC-1 [local]: The glass pane and the fog-filled room regions on the owned engine match Unreal Epic within the PRD-631 thresholds at L7. proof: `pnpm unreal-look:compare --scene gi --layer L7` — Evidence: not met. `Pane` at L7 went from dP50 0.387 to 0.143 (Decision 9), still outside the threshold because L1 is 2.17 times Unreal (Decision 10). The fog room frames were black until Decision 14. With the camera fix, the fog without GI sits 11 to 17 percent below Unreal on the room regions at L7 (Decision 16), and the GI fog term overshoots the side walls (Decision 15), so fog is outside the thresholds too.
- [ ] AC-2 [local]: The back-lit leaf region of the `foliage` pose matches Unreal Epic within the thresholds. proof: the same command — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The conformance row `translucency-gi` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests translucency-gi` — Evidence: `node packages/runtime-native/conformance/run-conformance.mjs --target desktop --only-tests translucency-gi` on 5f17e6d87 (2026-10-21 19:06): pass, pixelMismatchRatio 0, perceptualDeltaE 0, no GPU validation errors, host exit 0 (the runner exits 2 because it marks the 118 unselected rows blocked). The first two desktop runs failed under host load, see Decision 8. Reopened 2026-10-22 (receiptB-lane): that pass ran the legacy host on upstream three. On the owned engine the row fails, see the receipt Decision below.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Translucency reads the radiance cache | Translucent and transmissive node materials in the game | Replaces the sky's diffuse term on those materials | AC-1 |
| Fog reads the radiance cache | The VQ-07 volumetric fog froxel pass | Adds a GI term to the sun and sky terms | AC-1 |
| Two-sided foliage back face | Materials marked `twoSidedFoliage` | New | AC-2 |

## Decisions

Lane glassfog, 2026-10-21. The engine owns the mechanism. The harness render source owns the look.

1. **The lane builds `glass` and `fog`, not `foliage`.** Two scenes isolate the two materials that Phase 1
   names, and each scene has one cause. The `shadow:wildwood` scene reached the epic (b5a08bde2) late in the run.
   leaf-lane found that the L1 foliage cell does not match before any GI is added (PRD-651 Decisions: Unreal's direct
   diffuse is EON where ThreeNative draws Lambert plus a white specular term, and its red on green foliage sits a
   further 20 to 25 percent below the albedo). PRD-646 stops the GI comparison at an L1 mismatch, so the Phase 3 box
   and AC-2 stay open and the lane did not start them.
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
8. **The desktop row needed a looser bake budget.** The row passed on web but failed on the desktop host under load:
   300 frames in 30 s, one present, "startup gate never opened". The likely cause is the ProbeVolume bake guard
   (`packages/core/src/render/probe-volume.ts`: a work item over `bakeBudgetMs` plus 0.5 ms throws). The row judges
   the frame, not the bake cost, so it sets `bakeBudgetMs: 250`. The runner keeps only the last 4000 bytes of
   stdout, so the commit records the cause as likely, not proven. Sibling rows (`probe-volume-sample`,
   `gi-tier-medium`) still set 16 and are not touched.
9. **Glass result at the epic head b5a08bde2 merged into `lane/glassfog` (5f17e6d87).** Two runs per arm on the
   NVIDIA adapter gave identical region values. The table lists pose `glass`; pose `glass-edge` is in the #541
   comment. `Pane` is the material that took no GI before: it was lit as an opaque material and, in the cache bake,
   it blocked the bounce paths. Display p50 (0 to 255), dP50 is the relative gap to Unreal Epic.

   | layer | region | Unreal | BEFORE | AFTER | dP50 BEFORE | dP50 AFTER |
   |---|---|---:|---:|---:|---:|---:|
   | L1 | Pane | 46 | 116 | 69 | 1.522 | 0.500 |
   | L7 | Pane | 119 | 165 | 136 | 0.387 | 0.143 |
   | L9 | Pane | 122 | 165 | 136 | 0.352 | 0.115 |
   | L7 | Back | 93 | 98 | 104 | 0.054 | 0.118 |
   | L7 | Ceiling | 104 | 105 | 112 | 0.010 | 0.077 |
   | L7 | Floor | 133 | 135 | 137 | 0.015 | 0.030 |
   | L7 | Wall_Red | 29 | 30 | 34 | 0.034 | 0.172 |
   | L7 | Wall_Green | 61 | 74 | 78 | 0.213 | 0.279 |
   | L7 | Box_White | 139 | 143 | 146 | 0.029 | 0.050 |

   The judge (2 runs per arm, L7 and L9) returned IMPROVEMENT on both poses and overall, and CLOSE to Unreal.
   Comment: https://github.com/ThreeNativeHQ/threenative-engine/pull/541#issuecomment-6331292243.
10. **The opaque room regions moved away from Unreal, and the cause is not this PRD.** The BEFORE bake counted the
    pane as a solid. That dimmed the room and hid an error. AFTER removes the wrong block, as Unreal does. The error
    that remains is in L1, with no GI at all: 1.94 times Unreal on `Back`, 1.85 on `Wall_Red`, 2.01 on `Wall_Green`,
    1.45 on `Box_White` (scene-linear), and the L1 `Pane` is 2.17 times. That is direct light matching
    (PRD-646). The AC-1 thresholds of PRD-631 do not hold on glass while L1 itself fails them.
11. **Sameness gate passes.** `pnpm unreal-look:compare --sameness --scene gi:glass,gi:fog` reports PASS on all 12
    glass rows and all fog rows (IoU at least 0.9998, 0 px beyond 1 px, 0 no-ID px) with the new-base ID frames.
    The earlier failure on old-base frames came from multisampled ID edges.
12. **Measurement set-up.** The Wasm engine pair of the lane lacked engine commit 0449f9e63 (TRAA late resolve), so
    the first captures ran new JS on an old engine. The lane rebuilt the pair from source (2 minutes, 206 steps).
    The L9 captures skip the auto-exposure wait of b5a08bde2 with a local switch, because that wait fails every
    fixed-exposure scene (glass and fog use `aem_manual`). The switch is not committed.
13. **Glass lacked refraction, and Unreal has no strong reflection here (owner report 2026-10-21).** Unreal's default
    glTF material (`GLTFExporter/Materials/Proxy/M_GLTF_Default`) refracts with index of refraction 1.5, through the
    distortion pass (UE 5.8.3: `Engine/Shaders/Private/DistortAccumulatePS.usf`, `DistortionCommon.ush`,
    `DistortApplyScreenPS.usf`, parameters from `Renderer/Private/DistortionRendering.cpp`). The scene colour behind
    the pane moves by the view-space normal times (IOR - 1) times the view width times 0.00023 times
    1 / tan(half the horizontal field of view), kept only where the shifted place lies behind the pane. In the
    `glass-edge` pose that is about 82 pixels. Layer: harness render source. `refraction.ts` (`refractBehind`) does
    this with an analytic ray test on the pane box from the scene file. The translucent twin writes no depth, as in
    Unreal. Red-green: `scripts/__tests__/unreal-look-refraction.spec.ts` pins the scale and the owned-engine IR rules.
    The capture proof is the judge: 2 runs per arm, L7 and L9, `--expect improvement`, all four frames IMPROVEMENT,
    overall IMPROVEMENT, close to Unreal (comment on #541, 2026-10-22). The dP50 of the pane does not move
    (L7 `glass` 0.143 to 0.151, `glass-edge` 0.162 to 0.162), because refraction changes where the picture sits. Reflection:
    Unreal draws one on a translucent surface only through Lumen front-layer reflections, on at the Epic tier
    (`Engine/Config/BaseScalability.ini:558`, code default 0 in `FrontLayerTranslucency.cpp:23`). With roughness 1.0
    and F0 0.04 the term is faint and blurred (estimate about 4 percent of the room radiance, not measured). No
    reflection code was added. Measure the term in a capture before adding one.
14. **The starter's fog drew black on the owned engine, and the cause was the camera matrix.** The fog read the
    camera through a `mat4` made of four `vec4` uniforms. On the Wasm engine that matrix did not follow the camera pose
    (probes: scene, depth and march alpha fine, scattering exactly zero, a ray built from the matrix zero). The fog now
    reads the camera as vector uniforms (axes, lens, clip), the way `packages/three-native/src/addons/screen-space.ts`
    reads its projection. Layer: starter template, `volumetricFogTransport.ts` and `volumetricFogVolume.ts`, because
    every owned-engine game that opts into the fog got a black frame. Red-green: `vq-volumetric-fog.spec.ts`
    "reads the camera as vectors" fails on the old graph (`mat4x4` in the WGSL) and passes on the new one. Capture
    proof: fog L6 mean 0.00 to 90.9 and L7 0.00 to 122.8 (display, `blackcheck.mts`). Not run: a native desktop or
    Android capture of the fixed fog.
15. **The GI fog term is not accepted, so the harness keeps it behind `?fogGi=1`.** Judge, fog L7, 2 runs per arm,
    BEFORE = fog with the camera fix and no GI term, AFTER = the same plus `ambientNode`: both poses REGRESSION,
    overall REGRESSION, far from Unreal. The term lifts the floor, ceiling and back wall toward Unreal (L7 dP50
    Floor 0.139 to 0.032, Ceiling 0.120 to 0.024, Back 0.137 to 0.085) but veils the side walls too much (Wall_Red
    0.165 to 0.468, Wall_Green 0.110 to 0.275). Probable cause, not tested: the walls are already 1.85 to 2.0 times
    Unreal in L1 (Decision 10), and the full mean radiance as an isotropic scatter adds more haze than Unreal's
    translucency volume does. Next step: a measured fog term per Unreal's volume lighting (port-map wave for
    fog), after PRD-646 fixes the direct light. The default harness arm (term off, run f3 on 7811a10d1 plus this change) matches the
    no-GI arm within noise: L7 mean 122.79 against 122.80, at most 103 pixels differ by more than 6 of 765 (sum of channels).
16. **Fog result, L7 display p50 against Unreal Epic, pose `fog`.** Camera fix and no GI term (fb2): Floor 136 vs 158,
    Ceiling 147 vs 167, Back 132 vs 153, Wall_Red 66 vs 79, Wall_Green 97 vs 109. With the GI term (f1): Floor 163,
    Ceiling 171, Back 166, Wall_Red 116, Wall_Green 139. At L6 (no GI, both arms equal): Floor 87 vs 79, Ceiling 112 vs 107,
    Back 95 vs 74, Wall_Red 51 vs 29, Wall_Green 65 vs 43. Frames before the fix were black at L6, L7 and L9.

**Receipt on the epic head (receiptB-lane, 2026-10-22).**

- **Merge.** `lane/glassfog` merged into the epic head `a2bff4bd8`. Three defects were fixed on the way:
  `pnpm lint` failed on two unformatted `reference-stats.json` files, `volumetricFogTransport.ts` had 211 lines
  against the cap of under 200, and `screenRay` had no caller outside its file. The fix moves `IFogCamera`,
  `viewDepth` and `screenRay` into `volumetricFogCamera.ts` (a pure move, no pixel change). The starter
  fingerprint changed from `cae4279c...` to `47abb45b...`.
- **Specs.** 118 tests pass in 6 files (probe-volume, vq-volumetric-fog, gi-cache, refraction, scene-export,
  translucency). `looks.spec`, the template "call every exported render integration symbol" test and the scaffold
  "byte-stable" test pass.
- **Judge, BEFORE = epic scaffold, AFTER = line, 2 runs per arm, L7 and L9, RTX 2080, `--browser-recipe webgpu`.**
  Overall IMPROVEMENT on all 8 frames. Fog is CLOSE to Unreal at L7 and L9, with every region inside the 0.25 limit
  (Wall_Red dP50 0.30 to 0.15). Glass is FAR to Unreal. The pane dP50 fell from 0.36 to 0.16 (L7) and from 0.33 to
  0.13 (L9). Wall_Red and Wall_Green stay over the limit (0.34 to 0.38), which is the PRD-646 direct-light gap.
- **Open regression to track.** At the `glass-edge` pose the translucent pane no longer blocks the bounce, so
  some regions moved numerically away from Unreal: Floor 0.38 to 0.60 and Wall_Green 0.65 to 0.88 at L7, and Back
  0.06 to 0.27, Floor 0.33 to 0.54 and Wall_Green 0.79 to 1.04 at L9. The frames still read IMPROVEMENT. A
  same-tree control (`?refraction=off`, glass pose, L7) shows no region change except Pane (0.151 to 0.160).
  Next step: calibrate the bounce level of the glass room (PRD-646 direct light), then rejudge `glass-edge`.
- **Neutrality.** `gi:sunlit-room` (6 poses), `gi:cornell` (2) and `gi:neon-corridor` (2) at L7-high are identical
  to the epic head (mean abs diff at most 0.0009), so the locks hold by identity.
- **AC-3 reopened.** On the owned engine the row `translucency-gi` fails. On the Wasm engine the error is
  `TN_NATIVE_UNCATALOGUED_CUBERENDERTARGET`. On the V8 desktop player it is `TN_NATIVE_ENGINE_UNBOUND` for
  CubeRenderTarget, RenderTarget3D, viewportCoordinate and Box2. The control row `probe-volume-sample` fails
  the same way, so this is an older ProbeVolume gap. Next step: allocate the bake resources lazily
  (`#ensureGpuResources` in `packages/core/src/render/probe-volume.ts` creates a CubeRenderTarget, a RenderTarget
  and a RenderTarget3D in `attachRenderer`) and let the row read atlas data without a bake. Not measured: the GPU
  cost of the per-pixel read (Phase 2 box stays open).

## Execution Phases

#### Phase 1: What takes no GI
**Status:** IN PROGRESS (glass and fog; `foliage` waits for the `shadow:wildwood` scene)
**Files:** `tools/unreal-reference/gi/{glass,fog}/{scene.py,criteria.md}` (new), `tools/unreal-reference/gi/foliage/{scene.py,criteria.md}` (new, open), `tools/unreal-reference/gi/scenes.json`
- [x] `glass` and `fog` are ready to calibrate: built and captured in Unreal, recreated with direct light matching (PRD-646), their silhouettes agree, and their PRD-647 criteria are written. proof: `pnpm unreal-look:capture --engine unreal --scene gi:glass,gi:fog --check-cvars` and `pnpm unreal-look:compare --sameness --scene gi:glass,gi:fog`. Evidence: sameness PASS on all glass and fog rows (Decision 11, IoU at least 0.9998); criteria `tools/unreal-reference/gi/{glass,fog}/criteria.md` written, glass item 6 added with Decision 13. The Unreal captures of both scenes exist (`tools/unreal-reference/captures/unreal/{glass,fog}/L7-Epic`) and every compare here reads them. `--check-cvars` was not rerun in this session (unverified).
- [x] The materials and fog froxels that take no GI on `glass` and `fog` are listed under `## Decisions`, with the per-region error against Unreal Epic. proof: `pnpm unreal-look:compare --scene gi:glass,gi:fog --layer L7`. Evidence: Decisions 9, 10, 13 and 16 list the surfaces (glass pane, fog) and give the per-region error.
- [ ] `foliage` is ready to calibrate: authored and captured in Unreal, recreated with direct light matching (PRD-646), and its PRD-647 criteria written. It reuses the `shadow:wildwood` scene when that lands. proof: `pnpm unreal-look:capture --engine unreal --scene gi:foliage --check-cvars` and `pnpm unreal-look:compare --scene gi:foliage --layer L1`.

#### Phase 2: Glass and fog
**Status:** IN PROGRESS
**Files:** `packages/core/src/render/probe-volume.ts`, the VQ-07 fog pass (`packages/create-threenative/templates/starter/src/render/volumetricFog*.ts`), `scripts/unreal-look/scaffold/render/{translucency,giCache}.ts`, `packages/core/__tests__/probe-volume.spec.ts`
- [x] A translucent pixel and a fog froxel read the same irradiance as an opaque pixel at the same point. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`. Evidence: 28 tests pass on 7811a10d1 (2026-10-22), with `scripts/__tests__/unreal-look-translucency.spec.ts` and `packages/create-threenative/__tests__/vq-volumetric-fog.spec.ts` (32). The fog read is opt-in in the harness (Decision 15), because its look is not accepted.
- [ ] The per-pixel read on a full-screen glass pane costs no more than 0.5 ms at 1920 × 1080, or the froxel decision is recorded. proof: `node packages/playtest/dist/runner/cli.js perf` on the harness.

#### Phase 3: Leaves lit from behind
**Status:** NOT STARTED
**Files:** `packages/core/src/render/two-sided-foliage.ts` (new), `packages/core/__tests__/two-sided-foliage.spec.ts` (new), `packages/runtime-native/conformance/scenes/shared/foliage-back-light.js` (new), `packages/runtime-native/conformance/registry.json`
- [x] A `twoSidedFoliage` material adds `subsurfaceColor ×` the back-face irradiance, and a material without `subsurfaceColor` adds nothing. proof: `pnpm exec vitest run packages/core/__tests__/two-sided-foliage.spec.ts` — 4 of 4 pass, and the spec fails with the `subsurfaceColor` guard removed.
- [x] The row `foliage-back-light` matches between upstream three and the owned engine on desktop. proof: `pnpm parity --target desktop --engine threenative --only-tests foliage-back-light`. Earlier evidence, legacy `mystral` host on upstream three, not the owned engine: `pnpm parity --target desktop --only-tests foliage-back-light` (web reference first) passes at 0 % mismatch and delta E 0 against the 0.03 / 4 tolerance. With the helper call skipped the same row shows 6.36 % and 6.8, so the row fails. Host: a built desktop host borrowed from another lane (TS-only change). Row: `foliage-back-light` in `registry.json`. **Unticked 2026-10-22 (parityaudit-lane):** on the owned engine (V8 engine player, epic head c82595f3c, RTX 2080, web reference from the same run) the row fails: pixel mismatch 0.1907, delta E 4.81 against the 0.03 / 4 tolerance, no GPU validation error. Both frames were viewed. Centre pixels: the two plain panels are 000000 on upstream three (the web lane and the legacy host) and 1a4020 on the owned engine, and the marked panel is ffd159 on upstream three and ffd95f on the owned engine. Cause: the scene gives every card `material.irradianceNode = front`. Upstream three 0.185.1 has no `irradianceNode` property, so it ignores it, while the owned engine applies it (`standard.cpp:1459`). The back-term helper itself works on both, which is the left card. Next step: build the front irradiance in a way both engines honour (a light, or an `IrradianceNode` in the material's `lightsNode`), then rerun on both lanes. **Re-ticked 2026-10-22 (ownedbind-lane).** On the owned engine (`pnpm parity --target desktop --engine threenative --only-tests foliage-back-light` and `--target web --engine threenative`, lane/ownedbind 829831f19, V8 engine player and the web Wasm engine, NVIDIA RTX 2080, reference = the upstream-three web capture) both pass: desktop pixelMismatchRatio 0, deltaE 0; Wasm 0, 0 (tolerance 0.03, 4). The 19.07% miss was the upstream arm, not the owned engine: upstream three 0.185.1 has no `irradianceNode`, so the reference dropped the front term (plain cards black there, (26,64,32) on the owned engine, which is albedo x 0.25 plus the back term as the scene intends). The scene now gives the front term as an ambient light of pi x 0.25, which both engines take. The change is to a test scene only, not a shipped look, so no judge round.
- [x] A Two Sided Foliage leaf lets the sun through from behind on the web and on the owned native engine. proof: `pnpm exec vitest run packages/core/__tests__/two-sided-foliage.spec.ts`, `ctest -R native_engine_foliage_transmission` and `pnpm parity --engine threenative --only-tests foliage-transmission` on `--target web` and `--target desktop`. Evidence (receiptB-lane, 2026-10-23, tree 995411f8e = epic a2bff4bd8 plus this line): the spec passes 7 of 7; the native test passes (`native_engine_foliage_transmission`, with `leaf_receiver`, `rough_diffuse` and one more, 4 of 4, built with `cmake --preset tn-linux -DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON` and `--parallel 4`); the row `foliage-transmission` passes on the Wasm engine and on the V8 engine player (pixelMismatchRatio 0.000225, perceptualDeltaE 0.000124 against 0.03 and 4, RTX 2080, reference = the upstream-three web capture of the same run), and `foliage-back-light` still passes at 0 and 0 on both. The Wasm pair was rebuilt after the merge and holds `subsurfaceColor` and `roughDiffuse`.
**Verification:** AC-2 and AC-3. A PRD-647 round on `foliage` at `high`, Unreal Epic as the target, must return IMPROVEMENT against BEFORE on the `foliage` and `glass` poses.

## Decisions

Written by subsurface-lane (foliage half). glassfog-lane owns the glass and fog boxes.

- **Scene.** The calibration scene is `shadow:wildwood-backlit`, not `gi:foliage`. It uses the real Fab tree, bush and fern, with the leaf materials on Unreal's Two Sided Foliage model. Two poses look up into the crown (`under`) and along the sun (`toward`), each at sun 60 and sun 15.
- **Mechanism.** `addFoliageBackLight(material, backIrradiance)` in `packages/core/src/render/two-sided-foliage.ts` adds `subsurfaceColor × backIrradiance` to the material `emissiveNode`. Both engines evaluate `emissiveNode`, so no C++ change was needed. A material without the `twoSidedFoliage` marker or without `subsurfaceColor` gets nothing and the helper returns `false`. The game reads its own cache along `normalWorld.negate()` and passes the node. The engine owns no colour.
- **Alias.** The helper carries no `@alias`. An alias needs a predecessor corpus row that the unaliased search misses, and `two sided foliage` already finds the helper by its situation text. One recall row, `request.two-sided-foliage`, pins this. `rejectHits` stays at 15.
- **Unreal cites.** Back-face indirect: `Engine/Shaders/Private/DiffuseIndirectComposite.usf`, the `SHADINGMODELID_TWOSIDED_FOLIAGE` branch. Substrate conversion: `Engine/Shaders/Private/Substrate/SubstrateLegacyConversion.ush`, the two-sided foliage block (thin slab, `SSS_TYPE_TWO_SIDED_WRAP`, mean free path from `SubsurfaceColor`). Direct transmission: `Engine/Shaders/Private/ShadingModels.ush`, `TwoSidedBxDF`.
- **Not done: sun transmission and the 0.7 AO factor.** Unreal adds direct sun light through the leaf (`SubsurfaceColor × wrapped N·L × scatter × transmission shadow`). This helper adds only the indirect term. The sun term needs the sun shadow visibility inside the material, which TSL cannot reach without a lighting-model change. That change is a native C++ task and a follow-up. The 0.7 factor on the short-range AO is also not implemented. The Unreal wildwood scene has no short-range AO difference to measure yet.
- **Materials and froxels that take no GI on this scene.** With the helper off, no leaf material takes a back term. The three leaf materials (`MI_dead-tree-leafs_master_Inst_Inst`, `MI_bush_leafs_material_master_lod00_Inst`, `MI_farn_material_Inst`) read the front hemisphere only. The scene has no fog froxels and no translucent material, so the froxel list is empty.
- **Unreal reference status (open).** The Two Sided Foliage build and captures ran once (`foliage_master` in `tools/unreal-reference/gi/export.py`). The read-back confirms the shading model and the three Subsurface Colors. The leaves render near white at L5, L7 and L9, even though the base colour texture is bound. The default-lit Unreal wildwood scene renders the same leaves green. The cause is not found. The leaf frames are therefore not a valid target, and no per-region error against Unreal is recorded. AC-2 stays open. Next probe: build the same scene with the master's Substrate output inspected, or with `Opacity` and `Subsurface Color` varied, one change per run.
- **ThreeNative effect (cause found by subsurface2-lane, 2026-10-22).** The measured change of at most 0.0011 was zero by construction. A default-template scene (this one) is drawn by `Reference.ts`, and `Reference.ts` never marked any material `twoSidedFoliage`, so the back term was in no frame. Only `CalibrationScene.ts` (the ID layer) carried the marker. Fix: `patchGi` writes `src/scenes/referenceFoliage.ts` from scene.json, and `Reference.ts` calls `markTwoSidedFoliage` (giCache.ts) before `installGi`. Proof: with the marker, a probe frame that draws the back term alone (leaf colour set to black) shows olive leaves at about 0.4 display luma, where the old AFTER arm showed none. The old BEFORE and AFTER arms are void. New arms (one run each, scene.json with and without the foliage fields, 507efab11): mean linear luma over the tree region (Unreal ID mask), BEFORE to AFTER: L7 sun60 under 0.191 to 0.340, L7 sun15 under 0.066 to 0.138, L9 sun60 under 0.175 to 0.260, L9 sun15 under 0.145 to 0.214. The term is no longer below noise. No Unreal comparison yet, because the Unreal target is still invalid. Specs: `unreal-look-patch-gi.spec.ts` (foliage table, and the Reference scene reads it) and `unreal-look-gi-cache.spec.ts` (marking by glTF material name). New arms are open.
- **Unreal reference (open, narrowed by two captures).** Read-back of the level (null RHI): the master is `MSM_TWO_SIDED_FOLIAGE`, and the instance binds the leaf texture, Base Color Factor 1, Metallic 0, Roughness 1, masked, two sided. L5 `sun60` frames, one change per leaf material: (1) Subsurface Color 0 on the tree: still white, so it is not the Subsurface Color. (2) Base Color Factor 0 on the tree: still white, so it is not the base colour. (3) A Default Lit copy of the same master on the bush: green, so the master copy and the texture binding are sound. (4) The `Opacity` pin of the Two Sided Foliage master set to constant 0 on the tree: whiter, every leaf. (5) The same pin at constant 1 on the bush: still whitish with green speckle. The white therefore comes from the Two Sided Foliage path in Substrate itself, and it grows as Opacity falls. The frames are `~/.cache/tmp-tn/subsurface/captures/exp1` and `exp2` (untracked). Next: one run per hypothesis from `SubstrateEvaluation.ush` (the wrap branches for direct light and for the environment, `DiffuseBackFaceWeight`) and `SubstrateSubsurface.ush`, with the Opacity pin driven by the leaf alpha as built; and a rebuild first, because these runs edited the built materials in place. Until the leaves render green, no Unreal frame of this scene is a target.
- **Card losses to check (engine gap, from leaf-lane's chroma cards via team-lead, 2026-10-22).** Unreal darkens a lit masked card by 8 percent and a lit masked two-sided card by 11 percent against an opaque card, and ThreeNative shows no such loss. This is the opposite of the near-white Two Sided Foliage leaves, so the white is specific to the Two Sided Foliage master or its Substrate conversion. Cleanest probe: the same leaf on the Default Lit master and on the Two Sided Foliage master, side by side in one scene, on the `shadow:chroma` cards. Data from leaf-lane (scene `shadow:chroma` on `lane/leaf` at 8a54bf863, L1, sun 60, pose `probe`; four colours by four material paths: Opaque, Textured, Masked, MaskedTwoSided; all Unreal cards are Default Lit masters). Unreal card over Unreal opaque card, grey: textured 0.957, masked 0.920, masked two-sided 0.888 (R, G and B alike; raw grey means 1.38, 1.32, 1.27, 1.23 in R). Bark: 0.95, 0.92, 0.89. Leaf (G channel): 0.952, 0.916, 0.889, so the green channel loses the same amount or more. ThreeNative, grey, fitted on the opaque card: textured 1.006, masked 1.023, two-sided 1.025 against opaque 1.023, so no loss. The loss therefore grows with each step from opaque, and it is not a Two Sided Foliage effect. Frames are untracked in the unreal-leaf worktree (`tools/unreal-reference/captures/unreal/shadow/chroma/L1/sun60-probe.exr`) and `~/.cache/tmp-tn/leaf/chroma-tn`; the per-card means are in `~/.cache/tmp-tn/leaf/chroma-dump-tn.json`. This is leaf-lane's finding (PRD-651 Decisions) and stays open there; PRD-643 only needs the Two Sided Foliage master added to the same card scene for the side-by-side probe.
- **Sun transmission (open).** Unreal adds the sun through the leaf: `SubsurfaceColor x wrapped(-N.L) x GGX scatter(-V.L) x shadow` (UE 5.8.3: `Engine/Shaders/Private/Substrate/SubstrateEvaluation.ush`, the `SSS_TYPE_TWO_SIDED_WRAP` branch, wrap 0.5, GGX roughness 0.6). For the `under` pose the sun is behind the crown, so this term is larger than the sky back term. It needs the light's shadow factor, which only the lighting loop has: in the owned engine that is `packages/runtime-native/src/engine/shader/standard.cpp` (the light loop, `variant.leafReceiver`), in three a `LightingModel.direct` override. Both, with a native test and a conformance row.
- **Sun transmission, receipt and one build fix (receiptB-lane, 2026-10-23).** Layer: engine (`packages/core`, `packages/runtime-native`) for the mechanism, harness for the marked leaves. Merging `lane/subsurface` onto the epic needed a union of three import lists (`tuning.ts.in`, `tuningBaseline.ts.in`, `unreal-look-gi-cache.spec.ts`). **Defect found and fixed:** `pnpm --filter @threenative/core build` failed in the declaration step with TS2339 at `two-sided-foliage.ts(37,16)` and `(97,16)`, because `renderer.ts` now imports `two-sided-foliage.js`, so the declaration entries that reach it without `soft-shadow.ts` do not see the `twoSidedFoliage` augmentation, while `tsc --noEmit` passes. Fix: the helper declares `twoSidedFoliage?: boolean` itself with the same type (commit f537b5011). Red: the build log of the first capture on the merged tree (`exit 1`). Green: `pnpm build` of the package exits 0, with publint clean. **Frames** (BEFORE = same tree, `scene.json` with the foliage fields stripped, so the leaves stay unmarked as on the epic; 2 runs per arm, L7 and L9, four poses, NVIDIA RTX 2080, run to run difference at most 0.012 grey levels; Unreal = the L7 and L9 captures of this scene, whose leaves are near white and are no valid hue target, see the open Decision above). A fresh read-only judge returned IMPROVEMENT on all 8 frames and overall, and FAR against Unreal on all 8 (every crown region is past the 0.25 limit, as it was before). The crown moved toward Unreal in every region: dP50 `GreenTree_1` 0.56 to 0.87 before and 0.35 to 0.63 after (L7 sun60 under 0.650 to 0.367), `Bush_1` 0.54 to 0.91 before and 0.35 to 0.58 after, `Fern_1` 0.55 to 0.85 before and 0.47 to 0.63 after; `Floor` unchanged at L7 (0.008 and 0.029) and slightly closer at L9 (0.068 to 0.063 and 0.148 to 0.136); trunk, sky and clouds unchanged. AC-2 stays open: the Unreal leaf target is invalid and the crown is still far from it. GPU cost of the transmission term is not measured. No lock or ratchet covers `shadow:wildwood-backlit`. Only a scene whose `scene.json` names a `subsurfaceColor` slot marks any leaf (`markTwoSidedFoliage` returns at once for no table), and only `shadow:wildwood-backlit` has one. `compare --check` was not run on this line, because its Unreal frames are not in a lane checkout. Gate frames of the GI scenes are in the queue line. Neutrality: with the subsurface tree, `gi:sunlit-room`, `gi:cornell` and `gi:neon-corridor` at L7-high (10 frames) and `gi:sunlit-room` and `gi:cornell` at L9 (8 frames) differ from the epic head `a2bff4bd8` by at most 0.009 levels (mean absolute difference), so the locks hold by identity. The receipt did not measure the GPU cost of the transmission term.
