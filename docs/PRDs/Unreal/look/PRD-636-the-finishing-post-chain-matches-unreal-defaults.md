---
prd_contract: v1
---

# PRD-636 — The finishing post chain matches Unreal's defaults

**Status:** PARTIAL — the finishing stages and the template defaults are in; the L9 match (AC-1) and the frame budget (AC-3) wait on the other layers
**Priority:** P2 — AC-1 and AC-3 are open: the starter L9 cells still differ from Unreal in lighting, sky, shadows and ambient occlusion, which other PRDs own, and the whole `high` chain does not hold 16.7 ms while ambient occlusion costs 15 ms.
**Complexity:** 5 (MEDIUM) — template post source in 13 templates (+2), a local-exposure stage that is new to the chain (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-631](PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 3 (the L9 row) and [PRD-632](PRD-632-the-frame-is-exposed-and-tone-mapped-the-way-a-fresh-unreal-project-is.md): bloom and local exposure act on the exposed scene-linear frame, so they cannot be compared before exposure matches. Low-resolution temporal reconstruction belongs to [PRD-539](../performance/PRD-539-low-resolution-temporal-reconstruction-quality-and-cost.md). Phase 4 makes temporal anti-aliasing the default, by owner decision on 2026-10-21.

## Context

Layer L9 is the last rung of the PRD-631 ladder: everything a fresh Unreal project adds after
lighting.

| Stage | ThreeNative starter `high` | Unreal 5.8.3 default | Unreal source |
| --- | --- | --- | --- |
| Bloom | `BloomNode`, strength 0.22, radius 0.6, **threshold 1**: only the sun disk and emissives bloom | Sum of Gaussians, intensity 0.675, **no threshold**: every pixel blooms a little. Six stages: sizes 0.3/1/2/10/30/64 % × size scale 4, tints 0.3465/0.138/0.1176/0.066/0.066/0.061 | `Engine/Source/Runtime/Engine/Private/Scene.cpp:453-470` |
| Vignette | 0.22, `smoothstep(0.55, 1.02, r)` | 0.4, cosine-fourth law | `Scene.cpp:541` |
| Local exposure | none | Bilateral grid, highlight and shadow contrast 0.8 (set by the project generator), detail 1, blurred-luminance blend 0.6 | `Scene.cpp:525-532`; `Engine/Source/Editor/GameProjectGeneration/Private/GameProjectUtils.cpp:155` |
| Motion blur | off | Amount 0.5, at most 5% of screen width, desktop only | `Scene.cpp:646`; `Engine/Source/Editor/HardwareTargeting/Private/HardwareTargetingModule.cpp:250` |
| Grade | 9³ LUT: contrast 1.06, small RGB gains (starter only) | Neutral: every saturation, contrast, gamma and gain is 1; white balance 6500 K | `Scene.cpp:403-451` |
| Grain | 0.0039, animated (starter only) | 0 | `Scene.cpp:552` |
| Chromatic aberration, lens flare, depth of field | off | off (fringe 0; flare off by project feature; focal distance 0) | `Scene.cpp:452,537,606`; `Engine/Source/Runtime/Engine/Private/SceneView.cpp:228` |

Template values: `packages/create-threenative/templates/starter/src/render/quality.ts:104-167`,
`worldEnvironment.ts:897-992`, `grade.ts:112-143`. Platformer, racing and sailing use other values.

## Solution

All of it is look, so all of it lives in template `src/render/`. Core keeps only the chain
plumbing it already owns (`packages/core/src/render/chain.ts`).

1. **Bloom in Unreal's shape.** Six Gaussian stages at Unreal's relative sizes and weights, with no
   threshold, at half resolution. Phase 1 first checks whether three.js `BloomNode` (five mips) can
   reach the L9 cells with tuned weights. A new bloom node is written only if it cannot.
2. **Vignette** at Unreal's strength and falloff.
3. **Local exposure**: a small bilateral-grid stage with highlight and shadow contrast 0.8. It is
   new, so Phase 1 measures its cost first. It stays off at `low`, as Unreal turns it off on
   mobile (`Engine/Config/BaseDeviceProfiles.ini:411`).
4. **Motion blur** on at `high` on desktop, using the velocity buffer from
   [PRD-269](../../done/PRD-269-motion-vectors-or-the-temporal-filters-lie.md). It stays off on
   phones.
5. **Grade and grain go neutral** by default. Each template keeps its LUT and grain as a named
   option, so an art direction can turn them back on.

## Acceptance Criteria

- [ ] AC-1 [local]: The starter L9 cells match the Unreal L9 cells within the PRD-631 thresholds in all 12 poses. proof: `pnpm unreal-look:compare --layer L9` — Evidence: open. Cause: base light, not a finishing stage (see Decisions, four lock breaks). `sun15` Sky, Floor and LitFloor sit 5 to 6.5% low even at L8 and L5 with no finishing stage, and `sun60` auto exposure is about 10% low. The sky, shadow, GI and exposure lanes own it.
- [ ] AC-2 [local]: A visual judge subagent returns IMPROVEMENT against the current starter, with the Unreal frames as the target. proof: judge verdict on the PRD-631 contact sheet — Evidence: pending.
- [ ] AC-3 [local]: The finished chain holds the `high` frame budget on the RTX 2080 browser lane. proof: `node packages/playtest/dist/runner/cli.js perf` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Unreal-shaped bloom | `templates/*/src/render/worldEnvironment.ts` bloom stage | Replaces the thresholded `BloomNode` settings | Phase 2 |
| Local exposure | new stage before the tone curve in `worldEnvironment.ts` | New | Phase 2 |
| Motion blur default | `quality.ts` `high` preset on desktop | Turns on an existing opt-in stage | Phase 3 |
| Neutral grade and grain | `quality.ts`, `grade.ts` | The LUT and grain become named options | Phase 3 |

## Execution Phases

#### Phase 1: Measure what the stock nodes can reach
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/bloom-fit.ts` (new)
- [ ] `BloomNode` with fitted weights is scored on the L9 cells against Unreal, and the outcome (keep it or write a six-stage node) is recorded under `## Decisions`. proof: `pnpm unreal-look:compare --layer L9 --stage bloom`.
- [ ] The local-exposure stage cost is measured at 1080p on the RTX 2080 browser lane. proof: `node packages/playtest/dist/runner/cli.js perf`.

#### Phase 2: The starter matches L9
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/starter/src/render/{worldEnvironment,quality,grade}.ts`
- [ ] Bloom, vignette and local exposure are in place, and AC-1 passes. proof: `pnpm unreal-look:compare --layer L9`.
- [x] The vignette scales the colour channels only, leaves the alpha unchanged and follows Unreal's cosine-fourth law, in the canonical `worldEnvironment.ts`, its 13 kit copies and the harness scaffold. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vignette.spec.ts`. Result 2026-10-21: 57 of 57 tests fail on `8a1a6156f` (the parent of `4d49b1fcd`: alpha 0.385 comes out where 0.6 goes in, and the corner mask is 0.600 where Unreal gives 0.574). All 57 pass on this commit.
- [x] The emissive sphere keeps Unreal's brightness at L9: the two `Sphere_Emissive` locks in `tools/unreal-reference/parity-locks.json` hold. proof: `pnpm unreal-look:compare --check --layer L9 --sun 60` on the sun60 spheres frame. Result 2026-10-21 (RTX 2080, headed Xvfb, two runs per arm): frames from the alpha-multiplying vignette break both locks (dP50 0.1181 against 0.0392, deltaE 6.7 against 1). Frames from `7a98e9251` hold both (dP50 0, deltaE 0.919). The run used a reference directory with these two locks only. It captured the spheres pose and copied that frame into the other three poses, which no lock reads.
- [x] The emissive sphere keeps Unreal's brightness at the sun 15 cell of L9 too: the two `Sphere_Emissive` locks for `sun15` hold. proof: `pnpm unreal-look:compare --check --layer L9 --sun 15` on the sun15 spheres frame, and the lock-list test in `scripts/__tests__/unreal-look-compare.spec.ts`, which fails without the locks. Result 2026-10-21 (RTX 2080, headed Xvfb, two runs per arm, same method as the box above): frames from the pre-fix chain (`489a04f39`) break both locks (dP50 0.1331 against 0.0392, deltaE 7.199 against 1). Frames from `7a98e9251` hold both (dP50 0.0040, deltaE 0.579). The emitter centre is 251.4 / 246.6 / 238.1 against Unreal's 252.4 / 246.4 / 236.6. The post-fix frames also break the older L9 `Sky` lock at sun 60 (dP50 0.0657) and the `Sky`, `Floor` and `LitFloor` locks at sun 15 (0.0606, 0.0769 and 0.0592, against 0.0392). Those locks are the post lane's to fix or re-seed, and this commit does not change them.

#### Phase 3: Every template, native included
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/`, `packages/runtime-native/conformance/scenes/shared/local-exposure.js` (new), `packages/runtime-native/conformance/registry.json`
- [x] Local exposure and the new bloom render on the desktop host within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests local-exposure`. Result 2026-10-21: the browser reference (`--target web`, adapter `nvidia` / `turing`) and the Linux host `mystral` built from this worktree both pass; 0 pixels differ and the mean deltaE is 0 at 1280x720 (both run Dawn on the RTX 2080), tolerance 0.06 and 9.0 in the registry row. The row runs upstream Three.js on the legacy host. The owned engine's desktop player has not run these stages, and neither lane covers the vignette or the motion blur: both stay unverified on native.
- [ ] Motion blur is on at desktop `high` and off on phones, and the template gate passes. proof: `pnpm test:templates`.
- [ ] Every template defaults to the neutral grade and no grain, with the LUT kept as an option. proof: `pnpm test:templates`.
- [ ] Every affected template's `AGENTS.md` (and mirror) states the Unreal-shaped bloom, vignette, local exposure, motion blur and neutral grade, with the LUT (`grade.cube`) and grain as the named options, so a new project's agent knows the default and how to override it. proof: `rg -l 'grade.cube' packages/create-threenative/templates/*/AGENTS.md` lists every affected template, and `pnpm sync:agents --check` exits 0.
#### Phase 4: Anti-aliasing is Unreal's default, temporal
**Status:** IN PROGRESS
**Files:** `packages/runtime-native/src/engine/` (`renderer/renderer.cpp`, `renderer/post/traa.cpp`, `renderer/post/effects.cpp`, `shader/graph/post_effects.cpp`, `shader/graph/graph.cpp`, `abi/tsl_call.cpp`, `wasm/web_host.cpp`, `player/v8_main.cpp`), `packages/three-native/src/{pass-node,browser-renderer}.ts`, `scripts/unreal-look/scaffold/render/{worldEnvironment,quality}.ts`, then `packages/create-threenative/template-assets/worldEnvironment.ts` and the 13 templates
Owner decision 2026-10-21: "shouldnt we turn it on by default then? we should use unreal defaults bro". Unreal 5.8.3 anti-aliases with temporal super resolution (`r.AntiAliasingMethod` 4, `Engine/Source/Runtime/Engine/Private/SceneView.cpp:236-246`). The phases above leave the chain on SMAA.
The owner reported that the sphere borders look poor next to Unreal. There are two causes. SMAA leaves aliased edges. Ambient occlusion (GTAO) also draws a dark stair-stepped band along the lower limb, and every later stage keeps that edge. The temporal resolve now runs after the screen-space stages, as it does in Unreal, and smooths the band. The width and the halo of the GTAO band belong to [PRD-635](PRD-635-ambient-occlusion-darkens-only-the-light-that-comes-from-around.md).
- [x] SMAA runs on the owned engine, so the stair-steps in the owner's crop are what SMAA leaves. proof: arms `sm_nov` (SMAA) and `b1` (no anti-aliasing), L9 `sun60/spheres`, vignette off. Result 2026-10-21: 10168 pixels (1.103%) differ by more than 2 levels and 1226 by more than 16. 79% of them lie within one pixel of an edge of the unfiltered frame, and those edges cover 7% of the frame.
- [x] Engine (C++ renderer): `screenSpaceAA: "disabled"` renders a frame. The final output graph never received `screenSize`, so the vignette aspect was 0/0 and the frame was black. proof: `tn-native-engine-renderer-test output_screen_size`, red before the fix (the frame is not 128 grey), green after.
- [x] Engine (C++ renderer): the temporal velocity pass draws a scene with instanced, skinned, morphed, alpha-tested and transparent draws. It aborted on the first one with `TN_TRAA_VELOCITY_UNSUPPORTED`. Those draws now carry the camera's motion, and the engine names them once (`TN_TRAA_VELOCITY_SKIPPED`). proof: `traa_camera_velocity`, red before the fix (the abort), green after.
- [x] Engine and facade: a stage reads the temporal pass's velocity by name, and the frame the graph drew can start the resolve. proof: `traa_feeds_the_chain` and `velocity_needs_traa`, red before the fix (the velocity read is not 137, the request is not refused), green after. `packages/three-native/__tests__/pass-node.spec.ts`, red with the source reverted (2 failures), green after.
- [x] Engine (C++ renderer): temporal AA replaces 4x multisampling, as one method does in Unreal, and the velocity pass keeps its depth-Equal test. The note `TN_TRAA_MSAA_OFF` goes to the console log, not the error stream. proof: `traa_replaces_multisampling`, red before the fix (the sample count is not 1), green after.
- [x] Engine (C++ renderer, effects, ABI): the resolve runs late. `traa(convertToTexture(frame), depth, velocity, camera)` resolves the frame the screen-space stages drew, as a host pass of the post graph, so the edges those stages made are smoothed with the rest. proof: `traa_late_resolve` (a hard threshold edge: 0 partial pixels when the resolve runs first, 85 when it runs last), and `starter_post_bindings` (red with the late binding removed: `TN_NATIVE_TRAA_INPUT`, green after).
- [x] Engine (ABI, shader graph): `.level(n)` reads a render texture, so the motion blur stage builds on the owned engine. Before, it was dropped with `TN_ABI_1: TSL level: TN_ABI_ARGUMENT level needs a texture node`. proof: `starter_post_bindings` (red with the level branch removed: `level needs a texture node`, green after), and `motionBlur` in the applied stages of the AFTER capture.
- [x] Engine (C++ renderer): a render target reads the live scene. A game's exposure meter reads the main renderer's scene colour by name. Its cached bind group kept the view from before temporal AA replaced 4x multisampling, so it metered a frozen frame and exposed the scene 1.0 to 1.3 stops too bright. proof: `sibling_reads_the_live_scene`, red before the fix (51 and 51), green after (51 and 153). The AFTER capture meters luminance 0.8467 at `sun60` and 0.348 at `sun15`, the same as the SMAA capture.
- [x] Facade (web Wasm): `debug().temporal` reads the live frame, history and jitter, and `info.engine.samples` reads the samples drawn. proof: `packages/three-native/__tests__/browser-renderer.spec.ts`, red with the source reverted (3 failures), green after, and the `TN_UNREAL_LOOK debug` line of the AFTER capture (samples asked 4, drawn 1, temporal active with a valid history and a moving jitter).
- [x] Engine tests bound the temporal resolve under motion. proof: `native_engine_traa_ghosting` and `native_engine_traa_camera_pan` (ctest, 395 of 395 native-engine tests pass on `3bac3daa2`). Ghosting: a grey sphere crosses a bar field for 8 frames at one pixel each, as a rigid draw and as one instance. The trail outside its footprint, over its own contrast, is 0 before frame 3 and 0.46 (rigid) and 0.22 (instanced) at frame 8; bounds 0.05 on frame 1, 0.7 and 0.3 on frame 8. Camera pan: the red spread after 40 frames keeps 62% (half a pixel a frame), 80% (a pixel) and 63% (a pixel and a half) of the still camera's, bounds 50%, 60%, 50%. Negative control (history offset multiplied by zero): pan reads 47%, 43%, 34% and fails, ghosting reads 0.44 instanced and fails. A second control (no disocclusion test) changes nothing in this fixture: the stale pixels lie within one pixel of the sphere's edge, so the edge rule keeps them valid, as in upstream `TRAANode`.
- [x] The template post chains lower natively with the new stages. proof: `native_engine_template_post_packages` (13 templates, 36 graphs, 3 without a post chain, failures=0) and `native_engine_post_TextureLevel`. Red before: the starter failed in all three tiers (`non-default-sampling` for the motion blur's `.level(0)`, the host-run bloom and local exposure stages, the velocity context); green after `a7ad05dba`. Found and fixed along the way: a loop body imported through the static path (`importSerialized`) emitted its statements twice (the old `FnNode` fixture too). Cause: `Lowerer::ensureVar` (`shader/graph/graph.cpp`) did not remember a var over a void call, so the loop's statement and its return both lowered the call. `native_engine_post_TextureLevel` now asserts one `textureSampleLevel` for the one read in the loop body: red before (two), green after; 395 native-engine ctests pass (`native_engine_pacing` failed once at host load 54 and passed three reruns).
- [ ] Native desktop player: the same `info.engine` record comes from `tn.renderInfo()` (`player/v8_main.cpp`, `player/core-webgpu.mjs`). proof: `pnpm native:build`, then a desktop playtest that reads `info.engine.temporal`. Open: `v8_main.cpp` compiles only in that full build, and the engine-only build used here leaves V8 off.
- [ ] Harness: the `high` and `medium` tiers anti-alias temporally and the owner's crops are smooth. proof: BEFORE (SMAA), AFTER (temporal) and Unreal 5.8.3 crops at `sun60` and `sun15` with a fresh judge verdict, posted on the epic PR.
- [ ] Qualification of the default: ghosting under camera and object motion, rejection fraction, RTX 2080 frame cost, web Wasm and native desktop. proof: the results, posted with the change.
- [ ] Every template defaults to temporal AA at `high` and `medium`, with `temporalAA: false` as the named override. proof: `world-environment-temporal-aa.spec.ts` (red before the change) and `pnpm test:templates`.

## Decisions

- 2026-10-19: Chromatic aberration, lens flare and depth of field stay off. Unreal's effective
  defaults are off too.
- 2026-10-19 (external visual review, checked): the emissive sphere's wide, low halo is bloom
  (threshold and radius, this PRD). Its light on the floor in Unreal is Lumen GI from an emissive
  surface (layer L7), owned by the GI PRDs, not by a default point light inside the mesh.

- 2026-10-21: Temporal AA is the default at the `high` and `medium` tiers, and the `low` (phone) tier keeps
  SMAA. Unreal's mobile default is also temporal (`r.Mobile.AntiAliasing` 2,
  `Engine/Source/Runtime/Core/Private/HAL/ConsoleManager.cpp:4719-4730`), but no phone has been measured with
  the extra velocity and history targets here. `temporalAA: false` brings back SMAA. The legacy
  `engine: "threejs"` renderer keeps SMAA and the applied report names why.
- 2026-10-21: Known gap to Unreal. The Epic scalability setting keeps the history at twice the screen size
  (`Engine/Config/BaseScalability.ini`, `[AntiAliasingQuality@3]`, `r.TSR.History.ScreenPercentage=200`). The
  engine's resolve keeps it at the screen size. Draws with no previous vertex data (instanced, skinned, morphed,
  alpha-tested, transparent) carry the camera's motion only, so a fast limb or blade can ghost slightly.

- 2026-10-21 (four L9 parity locks): the exact finishing chain (`4d49b1fcd` to `7a98e9251`) breaks four `dP50` locks of `parity-locks.json` (limit 0.0392): `sun60` Sky 0.073, `sun15` Sky 0.0606, `sun15` Floor 0.0615, `sun15` LitFloor 0.0526. No finishing stage is the cause. At fixed exposure 1.0, each stage matches Unreal's own ablation frames (`unreal-fx`, `-fxnovig`, `-fxnolocal`, `-fxnobloom`) within about 1%: vignette log2 mean -0.218 against -0.223, bloom +0.137 against +0.127, local exposure -0.012 against -0.012, and the per-region display ratios agree to 3 decimals. The base light is lower than Unreal's by 5 to 6.5% in Sky, Floor and LitFloor at `sun15` in every arm, and the same gap shows at L8 and L5 with no finishing stage (L8 `sun15` Sky 175 against 167, Floor 145 against 132). At `sun60` the settled auto exposure is about 10% low (0.43 against about 0.48 in Unreal's own frame), which costs the Sky about 5% of display. The locks were seeded at `ef8871272`, when an older chain passed them by cancellation: a vignette weaker than Unreal's (0.22 smoothstep) and a grade table that lifted highlights added +4 to +8% to the same regions. The chain does not tune a stage away from Unreal's default to hide this. The base light belongs to the sky, shadow, GI and exposure lanes (PRD-633, shadow, GI and look PRDs). Decision (team lead, 2026-10-21): the four locks stay as they are and stay red on the epic until those lanes land. They are not dropped or relaxed. A re-seed with `--write-locks` restores them then. A vignette-only reading (emissive-lane ablation: vignette off lifts every region by 6.5 to 10.4 L*) was set aside because the stage-effect numbers above show the vignette matches Unreal's; one scalar cannot fit Sky, Floor and the rough sphere either.

## Performance (2026-10-20)

Question: does the Unreal-look overlay (`scripts/unreal-look/scaffold/render/`) still hold the `high` frame budget (60 fps, 16.7 ms)? No box above is ticked. This is a measurement, not an acceptance result. AC-3 stays open because the lane below cannot present at display rate.

**Lane.** C++ Wasm engine in Chromium, headed on a private Xvfb at 1920x1080 (`TN_XVFB_SCREEN=1920x1080x24`, `--size 1920x1080`, scale 1, 4x MSAA). Adapter `nvidia` / `turing` (RTX 2080), never SwiftShader. Overlay: commit `1f103f09c` plus the harness hook in `52fca3bb8` (`--measure <s>`, `--size`, `--off <stage>`). Pose `sun60/exterior` (and `sun60/interior` where listed). Hold: 30 s after the 8 to 30 s settle, window 1 dropped by `playtest perf --file`. Meter: `TN_FRAME_BUDGET`, `gpuMs` sampled 1 frame in 8. Every run held the shared capture lock. The host was never idle: 1-minute load 12 to 37 on 24 cores in the valid rows, so the reader marks every absolute `invalid-absolute`.

**Read this first.**
- Xvfb presents a 1080p frame in 50 to 117 ms. The presented period (`presented`, 50 to 117 ms) is the Xvfb copy, not the engine. **No fps claim is made.** The loop also skips about 50% of renders under its 60 fps cap, so the callback p50 is diluted. The CPU render column is the p95, which stays on rendered frames.
- GPU time is the signal. During the holds the GPU sat at P5 (`nvidia-smi`: about 0.9 to 1.1 GHz SM, memory 810 to 5600 MHz, 22 to 35% utilisation). At P2 boost the same work takes less. Treat GPU ms as an upper bound at these clocks. Repeat runs of the same arm differ by up to 2 ms on the p50 and by 30% on the mean.
- Rows marked `x` ran at host load above 45 and are not used.

### Steady-state frame cost, exterior pose

| Arm | Runs | GPU ms mean (per run) | GPU ms p50 | GPU ms p95 | CPU render p95 ms | Host load |
| --- | --- | --- | --- | --- | --- | --- |
| L1 floor (sun, fixed exposure, tonemap) | 1 (+1 x) | 4.0 | 3.8 | 7.2 | 1.0 | 17 to 19 |
| Stock starter template, Play scene, auto scale | 2 | 12.4, 12.4 | 11.9, 11.4 | 13.0, 23.8 | 2.5, 2.4 | 13 to 17 |
| L9, every overlay stage off (stock shadow map, CPU sky, SMAA, vignette) | 1 (+1 x) | 5.5 | 4.6 | 12.6 | 1.6 | 16 to 20 |
| **L9 full** | 4 | 23.3, 22.8, 30.9, 21.6 | 23.2, 23.0, 24.6, 21.2 | 24.7, 24.3, 44.0, 24.8 | 16.2, 14.9, 15.9, 11.0 | 14 to 37 |
| L9 full, interior pose | 2 | 24.1, 21.7 | 25.2, 21.1 | 26.3, 29.7 | 11.8, 15.6 | 14 to 21 |

The stock starter is a different scene (the Play arena). It is a reference point only. L9 full is about 2x the stock starter and 4x the all-off floor on the same scene.

### GPU ms by stage (ablation, exterior pose, one run each, delta against the L9 full p50 of about 23 ms)

| Stage switched off | GPU ms mean / p50 / p95 | Delta p50 | Host load | Reading |
| --- | --- | --- | --- | --- |
| GTAO (full-res + denoise) | 10.2 / 7.6 / 19.9 | **-15.5** | 14 to 17 | Largest cost |
| Bloom (Unreal sum of Gaussians) | 14.9 / 12.8 / 22.2 | **-10.3** | 5 to 7 | Second cost (the first run, load 49, is void) |
| GI cache lookup (bake still skipped) | 17.8 / 18.2 / 22.1 | -4.9 | 12 to 17 | Third cost, also CPU: render p95 16 to 8 ms |
| SSR | 26.1 / 21.7 / 37.1 | -1.4 | 16 to 26 | Inside noise |
| Auto exposure (and local exposure) | 26.5 / 21.4 / 36.4 | -1.7 | 5 to 12 | Inside noise |
| Local exposure | 29.8 / 22.3 / 40.6 | -0.8 | 12 to 27 | Inside noise |
| Clouds | 28.0 / 24.6 / 40.8 | +1.6 | 7 to 9 | No saving visible |
| GPU sky to CPU bake | 31.6 / 25.3 / 43.3 | +2.1 | 30 | No saving visible; load 30, low confidence |
| Virtual shadow maps to stock 4096 PCF map | 30.5 / 34.8 / 38.3 and 30.0 / 34.7 / 37.5 | +11.6 | 30; 22 to 52 | Stock map costs more; two runs agree on the p50, both at high load |
| SSGI | 25.0 / 23.2 / 41.4 | +0.0 | 16 to 23 | **No-op.** The engine drops the stage at build in every L9 run: `TN_RENDER_CHAIN` lists `ssgi` as dropped, `TN_ABI_ARGUMENT TN_TSL_POST_INPUT: denoise input must be a texture node`. SSGI costs nothing because it does not run. |

Stage deltas do not sum to the L9 total: removing GTAO also removes the denoise passes that SSR and bloom sample, and the p50 noise is about 2 ms.

### Startup (page start to first L9 frame)

| Run | Host load | Page start to scene ready | GI cache bake (`TN_GI_CACHE`) | Bake share |
| --- | --- | --- | --- | --- |
| L9 full | 16 | 153 s | 137 s | 89% |
| L9 full | 15 to 21 | 215 s | 195 s | 91% |
| L9 full | 23 to 37 | 273 s | 250 s | 92% |
| L9 minus bloom, quiet host | 5 to 7 | 121 s | 106 s | 87% |
| L9 all off (no GI cache) | 16 to 20 | 9.5 s | none | 0% |
| L1 | 17 | 6 to 12 s | none | 0% |

The bake is one synchronous CPU job in the scene `enter`. It scales with host load (106 s at load 5 to 7, 250 s at load 23 to 37). Everything else in startup is 16 to 23 s. Sky bake cost is below 1% of startup: `CPU environment sky 64x32` took 140 to 580 ms and `GPU sky LUT submission` 26 to 154 ms (GPU completion is unmeasured).

### What this means for the template defaults

- L9 does **not** hold the `high` budget on this lane: about 23 ms GPU at P5 clocks against 16.7 ms, and about 15 ms of CPU render p95 on the Wasm engine. The overshoot is real in order of magnitude. Its exact size at boost clocks is unverified.
- Three costs carry nearly all of it: GTAO (about 15 ms), bloom (about 10 ms) and the GI cache lookup (about 5 ms). The other stages are inside the 2 ms noise.
- To hold `high`, the defaults must leave out full-resolution GTAO with a denoise (use the `medium` sample count or half resolution), must price the Unreal bloom (a cheaper pyramid, or fewer than its six Gaussian stages), and must not bake the GI cache at every start (a 105 to 250 s bake: cache it, ship it baked, or cut the rays). With GTAO alone off the GPU time is about 8 ms median.
- Do not claim SSGI in any default: it is dropped by the engine at present.

### Not verified

- Presented fps and the boost-clock GPU time need a real display and a GPU that clocks up. Neither was available: the lane is Xvfb on a shared host with a GPU at P5.
- Bloom, clouds, GTAO, GI, SSR, exposure and VSM deltas are one run each, exterior pose only. VSM and GPU sky ran at load 22 to 52. The VSM reversal (stock map slower) repeated once with the same p50 and still needs a run on a quiet host. A repeat of L9 full on a quiet host (run `c-L9`, load 9 to 52) was void.
- Interior and the other sun poses were not ablated. Motion blur is not in the L9 harness. The native desktop engine, Android and the `medium` and `low` tiers were not measured.
- Per-stage GPU timestamps are not exposed by the engine. The ablation is the only attribution here.
- Raw logs: `perf-out/` under the lane scratchpad, not committed.
