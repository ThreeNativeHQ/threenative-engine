---
prd_contract: v1
---

# PRD-638 — Calibration scenes are built in Unreal and captured as the GI target

**Status:** DONE — the `cornell` and `sunlit-room` scenes author in Unreal and export with their frames and noise floors, and the `pan` and `switch` motion runs are captured in Unreal and in the owned engine and measured (`scripts/unreal-look/motion.ts`). The owned-engine baseline is on PR #541.
**Priority:** P1 — no box is ticked: no scene authored in Unreal isolates colour bleed, interior sky light, leaks, emissive light or a moving light, so no GI change can be judged against Unreal. Every PRD in this folder is judged on these scenes.
**Complexity:** 7 (HIGH) — 1–5 files in the PRD-631 harness plus one scene folder per scene (+1), new system: a scene authoring and export pipeline inside Unreal (+2), new state: Level Sequences for motion runs (+2), external tool: the headless Unreal editor and its glTF exporter (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-631](../Unreal/look/PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 1 (the headless Unreal capture). Recreation in ThreeNative is [PRD-646](../Unreal/gi/PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md), and the calibration loop that uses the frames is [PRD-647](PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md).

## Context

**Owner direction (2026-10-20):** the most important part of the GI sub-epic is one or more
calibration scenes. Each scene is created in Unreal, then recreated in ThreeNative, and the visual
judge calibrates ThreeNative against it until parity.

The PRD-631 scene was built in Blender and loaded into both engines. Its four poses (exterior,
spheres, interior, backlit) and its L7 row are the only GI evidence in the repo, and they cannot
isolate GI behaviours. No pose has a coloured wall beside a white one, a dark room behind a thin
wall, a scene without sun and sky, or a light that switches. The sibling session reports a faint red
bleed and a warm emissive leak since commit `c0683da2c`, and no cell measures either one alone.

**Harness facts used here.** `pnpm unreal-look:capture --engine unreal` runs
`UnrealEditor-Cmd -ExecutePythonScript` with `tools/unreal-reference/build_level.py`. The level renders
through Movie Render Queue with 90 warm-up frames (`build_level.py:308-312`). Layers are cumulative
sets of console variables in `tools/unreal-reference/layers.json`. Reference statistics are tracked in
`tools/unreal-reference/reference-stats.json`, and the frames are not committed (PRD-631).

**Unreal 5.8.3 ships the two tools this needs:** Geometry Script makes meshes from Python
(`Engine/Plugins/Runtime/GeometryScripting`), and the glTF exporter writes a level to GLB
(`Engine/Plugins/Enterprise/GLTFExporter`).

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

- **A fresh project runs Lumen at Epic.** Project creation sets `r.DynamicGlobalIlluminationMethod=1`
  and `r.ReflectionMethod=1` (UE 5.8.3: `Engine/Source/Editor/GameProjectGeneration/Private/GameProjectUtils.cpp`,
  `AddLumenConfigValues`). `sg.GlobalIlluminationQuality` defaults to 3, Epic
  (UE 5.8.3: `Engine/Source/Runtime/Engine/Private/Scalability.cpp`). Software tracing against the
  global distance field is the template default (UE 5.8.3: `Templates/TP_ThirdPersonBP/Config/DefaultEngine.ini`).
- **The quality level changes the algorithm.** Low turns Lumen GI off, Medium uses the irradiance field
  gather, and High, Epic and Cinematic use the screen probe gather (UE 5.8.3: `Engine/Config/BaseScalability.ini`,
  `[GlobalIlluminationQuality@0..4]`). So each scene is captured at three levels.
- **Lumen accumulates over frames.** The screen probe history holds up to 10 frames and surface cache
  radiosity 4 (UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenScreenProbeGatherTemporal.usf`,
  `Engine/Source/Runtime/Renderer/Private/Lumen/LumenRadiosity.cpp`). A frame captured before the
  history settles is not a target.
- **Lumen ships diagnosis views.** `r.Lumen.Visualize.IndirectDiffuse` shows the indirect diffuse term
  alone, and `r.Lumen.Visualize` mode 3 shows the Lumen scene that the rays see
  (UE 5.8.3: `Engine/Source/Runtime/Engine/Private/LumenVisualizationData.cpp`).

## Solution

**One pipeline, many scenes.** A calibration scene is a folder `tools/unreal-reference/gi/<scene>/`:

1. **Authored in Unreal.** `scene.py` builds the level in the headless editor: meshes made with
   Geometry Script (boxes, planes, spheres, so the geometry is ours and not Epic content), materials
   with set base colour, roughness, metallic and emissive, and Unreal's own light and environment
   actors (point, spot, rect and directional lights, sky light, sky atmosphere, height fog, a post
   process volume with a fixed EV100). Unreal is the authoring tool and the source of truth.
2. **Exported.** The glTF exporter writes `scene.glb` (meshes, materials, transforms). The script
   also writes `scene.json`: every actor's class, transform and the properties that glTF loses
   (light intensity with its unit, source radius, attenuation radius, temperature, sky light and fog
   settings, exposure, post process values). `scene.json` is the authority for lights, environment
   and post. Both files are committed, so ThreeNative recreates the scene without Unreal (PRD-646).
3. **Captured.** For each pose and sun, Unreal renders at layer L7 (GI on, post minimal):
   - GI quality Low, Medium and Epic, PNG and scene-linear EXR;
   - two Epic diagnosis frames: `r.Lumen.Visualize.IndirectDiffuse 1` and `r.Lumen.Visualize 3`;
   - one Epic frame at L9, the full default look a player sees;
   - a region-ID frame, so a region means the same pixels in both engines.
4. **Motion runs.** A run is a Level Sequence that `scene.py` keys (camera, light, door or mover),
   rendered through the same Movie Render Queue path, 180 frames at a fixed step. Each frame writes
   the per-region scene-linear p50. The compare tool derives per region: **flicker** (frame-to-frame
   change on a still camera after 60 frames), **response** (frames until 90% of a switch's change)
   and **overshoot** (the largest value past the settled one).

**Which PRD owns which scene.** The pipeline and the first scene belong to this PRD. A GI PRD that
tests a behaviour no registered scene isolates authors its scene or motion run with this pipeline in
its own Phase 1, and adds it to `tools/unreal-reference/gi/scenes.json` with its owner. Pose names are
unique across all scenes, so any PRD can cite a pose by name.

| Scene | Isolates | Light | Poses | Owner |
|---|---|---|---|---|
| `cornell` | Colour bleed, multi-bounce, corners, a ceiling lit only by bounce | One point light; no sun, no sky | `cornell`, `corner` | PRD-638 (this) |
| `sunlit-room` | Sky and sun through a window, falloff into a room, a leak through a 0.2 m wall | Sun 60° and 15°, sky light | `window`, `leak`, `door` | PRD-638 (this) |
| `neon-corridor` | Emissive strips, a 5 cm bright emitter, a textured wall, a point lamp | No sun, no sky | `neon`, `textured` | [PRD-639](../Unreal/gi/PRD-639-a-surface-cache-gives-traced-rays-the-texture-glow-and-lights-of-what-they-hit.md) |
| `neon-corridor` (pose) | A chrome sphere and a glossy floor that reflect what is behind the camera | as above | `chrome` | [PRD-642](../Unreal/gi/PRD-642-glossy-surfaces-reflect-what-the-camera-cannot-see.md) |
| `foliage` | Back-lit two-sided leaves, a glass pane, fog in a room | Sun 15° behind the leaves, sky light, height fog | `foliage`, `glass` | [PRD-643](../Unreal/gi/PRD-643-glass-fog-and-leaves-take-the-bounce-light-too.md) |

| Motion run | Scene | Owner |
|---|---|---|
| `pan` (90° in 2 s) | `cornell` | PRD-638 (pipeline proof) |
| `neon` (strips off at frame 60, on at 120) | `neon-corridor` | [PRD-641](../Unreal/gi/PRD-641-bounce-light-holds-still-while-the-camera-moves-and-follows-a-light-that-changes.md) |
| `door` (opens over 30 frames), `occluder` (a 1 m box crosses the window) | `sunlit-room` | [PRD-VQ-09](../rendering/PRD-VQ-09-incremental-diffuse-relighting.md) |

`cornell` and `sunlit-room` belong here because PRD-603, PRD-604, PRD-605, PRD-640, PRD-644 and PRD-645
all need them first. `--scene gi` selects every registered scene, and `--scene gi:<name>` one.

**Units and exposure.** Light units follow PRD-632: point and spot lights in lumens or candela, the
sun in lux, emissive in nits, exposure as a fixed EV100 per scene. Fixed exposure keeps exposure
errors out of the GI judgement.

**Licence.** `scene.py`, `scene.json` and the Geometry Script meshes are ours. No Epic asset, starter
content or `.uasset` is committed, and the frames are renders of our scenes.

## Acceptance Criteria

- [x] AC-1 [local]: From a clean checkout plus `UE_ROOT`, one command authors, exports and captures `cornell` and `sunlit-room` with no manual editor step, and reads the GI level of each cell back from the log. proof: `pnpm unreal-look:capture --engine unreal --scene gi:cornell,gi:sunlit-room --check-cvars` exit 0, cell count checked against the pose list — Evidence: 2026-10-21 exit 0, 21 console variables checked, 0 missing. Every variant logged `readback ok` with the cell count of the pose list (cornell 4 per layer, 2 for ID and L7-Epic-scene; sunlit-room 12 per layer, 6 for ID and L7-Epic-scene). The log holds `r.Lumen.ScreenProbeGather.DownsampleFactor:16` and `TracingOctahedronResolution:8` (real-time Epic), not the cinematic 8 and 16.
- [x] AC-2 [local]: `reference-stats.json` holds the Unreal statistics of every registered scene, so `compare.ts` and the PRD-647 scoreboard run without Unreal. proof: `pnpm unreal-look:compare --scene gi --write-stats` — Evidence: 2026-10-21 on the real-time captures (`DownsampleFactor` 16, `TracingOctahedronResolution` 8): `cornell` 14 cells and `sunlit-room` 42 cells written, with each pose's ID frame in `gi/<scene>/id/`. Red: `--layer L7 --captures <dir with no unreal/>` failed `TN_UNREAL_LOOK_MISSING_CELL: .../unreal/cornell/ID/cornell.png`. Green after `compareGiToUnreal` took the committed stats and ID frames: the cornell L7 table without Unreal is byte-identical to the table with Unreal.
- [x] AC-3 [local]: A scene whose `scene.json` and `scene.glb` disagree on an actor (missing mesh, unknown light class, a property without a unit) fails the export, naming the actor. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-scene-export.spec.ts` — Evidence: 10/10 pass (2026-10-20); the live export also failed closed once on `Lamp: intensity has no unit` before the enum fix.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Scene authoring and export | `pnpm unreal-look:capture --engine unreal --scene gi:<name>` → `tools/unreal-reference/gi/<name>/scene.py` | New. The PRD-631 Blender scene stays as it is | AC-1, AC-3 |
| Scene registry | `tools/unreal-reference/gi/scenes.json`, read by capture, compare and PRD-647 | New | AC-2 |
| Motion runs | `--motion <run>` → Level Sequence → Movie Render Queue | New | Phase 3 |

## Execution Phases

#### Phase 1: The pipeline proves itself on `cornell`
**Status:** DONE
**Files:** `tools/unreal-reference/gi/scenes.json` (new), `tools/unreal-reference/gi/cornell/scene.py` (new), `tools/unreal-reference/gi/export.py` (new), `tools/unreal-reference/build_level.py`, `scripts/unreal-look/capture.ts`, `scripts/__tests__/unreal-look-scene-export.spec.ts` (new)
- [x] `cornell` authors, exports `scene.glb` and `scene.json`, and captures every cell. proof: `pnpm unreal-look:capture --engine unreal --scene gi:cornell --check-cvars`. Result 2026-10-20: `--check-cvars` 18 checked, 0 missing; build and export validation pass; 20 frames (L1, L7-Low/Medium/Epic, L7-Epic-indirect, L7-Epic-scene, L9-Epic, ID, L7-Epic@180, @180#2) each logged `readback ok`.
- [x] Lumen has converged: frames 90 and 180 of each Epic cell differ by less than the PRD-631 noise floor in every region, and the noise floor of the scene is recorded under `## Decisions`. Result 2026-10-20: 12 regions over 2 poses PASS, largest change 0.79% (Box_Tall) against the 1% limit; noise floor 0.18%. proof: `pnpm unreal-look:capture --engine unreal --scene gi:cornell --warm-up 90,180` and `pnpm unreal-look:compare --scene gi:cornell --unreal-vs-unreal`.

#### Phase 2: `sunlit-room`
**Status:** DONE
**Files:** `tools/unreal-reference/gi/sunlit-room/scene.py` (new), `tools/unreal-reference/gi/scenes.json`
- [x] `sunlit-room` authors, exports, converges and has its noise floor recorded, as in Phase 1. proof: the Phase 1 commands with `gi:sunlit-room` — Result 2026-10-21: `--check-cvars` 0 missing, 6 poses, every cell `readback ok`. 90 warm-up frames do NOT converge here: 34 of 52 regions change 1% to 4% against 180, and the Epic cells read about 1% dark. The reference warm-up is therefore 180 (`REFERENCE_WARM_UP` in `scripts/unreal-look/gi.ts`). 180 against 360: 40 of 40 regions PASS, largest change 0.34% (Ceiling, sun60-leak) against the 1% limit; mean abs pixel change 180 vs 360 vs 720 is 0.2 to 0.3 levels. Noise floor 0.22%. cornell at 180 against 360: 12 of 12 PASS, largest 0.34%, noise floor 0.13%. `pnpm unreal-look:compare --scene gi --unreal-vs-unreal`.

#### Phase 3: Motion runs
**Status:** DONE
**Files:** `tools/unreal-reference/gi/cornell/scene.py`, `tools/unreal-reference/gi/cornell/scene.json`, `tools/unreal-reference/gi/export.py`, `tools/unreal-reference/gi/scenes.json`, `tools/unreal-reference/gi/strip.py` (new), `tools/unreal-reference/build_level.py`, `scripts/unreal-look/motion.ts` (new), `scripts/unreal-look/motion-run.ts` (new), `scripts/unreal-look/capture-motion-threenative.ts` (new), `scripts/unreal-look/gi.ts`, `scripts/unreal-look/capture-gi-threenative.ts`, `scripts/unreal-look/scaffold/CalibrationScene.ts.in`, `scripts/__tests__/unreal-look-motion.spec.ts` (new)
- [x] The `pan` run renders 180 frames, and the motion metric fails closed on a missing frame, a frame-count mismatch or an empty region. proof: `pnpm unreal-look:capture --engine unreal --scene gi:cornell --motion pan` and `pnpm exec vitest run scripts/__tests__/unreal-look-motion.spec.ts` — Result 2026-10-21: the build made `Seq_motion_pan`, `Seq_motion_switch`, their `_id` twin and five one-frame still sequences; the capture logged `L7-Epic-motion frames=180 stills=5 readback ok` and `ID frames=180 stills=5 readback ok` (185 PNG files each, `pan.0000` to `pan.0179`). The spec passes 46 of 46. Red first: with `motion.ts` replaced by a stub that throws, the 38 tests of the metric failed 38 of 38. The report-layer, frame-gate and gate-verdict tests were written after the code and passed at once. On the real frames the metric failed closed as designed: `TN_UNREAL_LOOK_EMPTY_MASK: region Shade has at least 200 pixels in 0 of 180 frames`, so the `pan` run names the four regions that stay in view.
- [x] Lumen updates between sequence frames: in a test run where the point light switches off at frame 60, the ceiling region responds over more than 1 frame. proof: `pnpm unreal-look:compare --scene gi:cornell --metric motion --engine unreal --run switch` — Result 2026-10-21: Ceiling `lag90` 43 frames and `settle` 53 frames after the switch (`responds over more than 1 frame`, exit 0). The other regions reach 90% of the change in 32 (Wall_Red) to 51 (Back) frames. Unreal's image history adds to the response: the capture is a Movie Render Queue run with the project's temporal anti-aliasing.
- [x] ThreeNative's frames of both runs are captured one rendered frame per step and measured against Unreal's: per-region lag after the switch and ghosting along the pan, with a labelled frame strip on PR #541. proof: `pnpm unreal-look:capture --engine threenative --scene gi:cornell --motion switch` and `--motion pan`, then `pnpm unreal-look:compare --scene gi:cornell --metric motion` — Result 2026-10-21: epic `e5caffbe1`, tier `high`, the NVIDIA Turing GPU through WebGPU, 180 frames per run, one drawn frame per step (`drawsPerStep` 1, no repeated frame). The switch run was captured twice (A and B). The pan run was captured once with the fixed clock (B). Capture A's pan run is not used: its clock followed the pacing wait and cut the motion blur to a tenth (see Decisions). Switch: the owned engine's `lag90` is `never` in all 8 regions and 59% to 94% of the change is left at frame 179, where Unreal needs 32 to 51 frames. The world cache is baked once at load. The two captures agree: flicker within 0.006 points, residual identical. Pan: ghosting is at most 0.89% per pixel and 0.56% low-pass, against 0.64% and 0.35% in Unreal. The worst cell is `Box_Tall` at frame 60 in both. Labelled strips, curves and tables are on PR #541: switch https://github.com/ThreeNativeHQ/threenative-engine/pull/541#issuecomment-6330537053, pan https://github.com/ThreeNativeHQ/threenative-engine/pull/541#issuecomment-6330977152. The motion spec passes 65 of 65 and the 28 `unreal-look` spec files pass 364 of 364. A second pan capture (C, the noise floor) was still in the GPU queue when this box was ticked.

## Decisions

- 2026-10-21 (motion lane, Phase 3): the Unreal motion variant is `L7-Epic-motion`: `L7-Epic` plus
  `r.BackbufferQuantizationDitheringOverride 16`. The tone mapper's 8-bit dither would otherwise show as flicker on a
  still camera, and the flicker metric must see only the GI. The render stays real-time Lumen (not cinematic)
  with the project's temporal anti-aliasing, as the pose captures do. `L7-Medium-motion` adds
  `sg.GlobalIlluminationQuality 1` and is captured on request (`--variants L7-Medium-motion`) for the PRD-641 Medium target.
- 2026-10-21 (motion lane): the metric reads display luminance of the PNG bytes (Rec.709 weights, no
  linearisation, as `packages/playtest/src/capture.ts` does). Both engines use the Unreal ID frames of the same run
  for the region masks, eroded by 2 px, so one mask measures both engines. A region needs 200 px in a frame and 30 frames in a run. Anything less throws
  `TN_UNREAL_LOOK_EMPTY_MASK`. A missing frame, a frame count that differs from `scene.json` and a frame of another size
  also throw. The report never shows a number for an input it could not read.
- 2026-10-21 (motion lane): definitions. Flicker is the mean absolute change of a region between two consecutive
  frames, over a window where nothing moves (`switch`: frames 10 to 59, `pan`: after the sweep plus 30 frames, to the
  last frame), as a share of the region level: `flicker px` per pixel and `flicker p50` on the region median.
  `lag90` is the number of frames after the switch until the region median is within 10% of the change from its final
  level. `settle` is the first frame after which it stays within 5%. `overshoot` is the largest excursion past the final
  level, as a share of the change. `residual` is the distance of the last 15 frames from the target, which for ThreeNative
  is Unreal's final level, so a lamp that never goes dark shows `lag90 never`. Ghosting is the gap between a frame of the sweep and a
  converged still of the same pose (a one-frame sequence rendered after the same warm-up), as a share of the still.
- 2026-10-21 (motion lane): the `pan` run measures `Ceiling`, `Back`, `Wall_Green` and `Box_Tall`. The camera stands at
  the open front (z 0.5), so `Shade` is never in view (an `EMPTY_MASK` on the first measurement) and `Wall_Red`, `Floor`
  and `Box_Short` leave the view before the hold. The extreme frames of the sweep look past the walls at black void.
  The `switch` run measures all eight regions from the `cornell` pose.
- 2026-10-21 (motion lane): the ThreeNative capture replaces `requestAnimationFrame` with a gate. A step runs the queued
  callbacks once, in one real frame, and waits for the draw. The owned engine refuses a
  render while two frames are still on the GPU (`kMaxFramesOnGpu` in `web_host.cpp`) and counts it in `frameGateSkips`. A
  refused step drew nothing, so it is repeated, and a step that did both or neither stops the capture
  (`TN_UNREAL_LOOK_FRAME_STEP`). `renderer.info.frame` counts every `render()` call that passes the gate, overlay
  renders included, so a step may count two draws. The capture records `drawsPerStep` and the number of repeated steps.
- 2026-10-21 (motion lane): while it holds the loop the gate owns `performance.now()`. The clock moves 1/30 s a step
  (`STEP_MS`, the rate of Unreal's motion sequences) and stands still between steps. Three reads `deltaTime` from it, and
  the starter's motion blur lasts (1/30 s) over `deltaTime` (`motionBlur.ts`), so the first capture, whose clock followed
  the 80 to 400 ms pacing wait, ran the blur at a tenth of its length: the edge of the tall box was a 1 px step in the
  moving frame, where Unreal's frame has a 12 px ramp. That capture's pan run is not used. Its switch run has a still
  camera and stays. The two clock specs failed first (`expected 1000 to be close to 1033.33`).
- 2026-10-21 (motion lane): the ghost has a second reading, `low`. The per-pixel gap counts grain and motion blur as
  ghosting, so a temporal accumulation that lowers the noise and adds a trail would look the same. `low` is the same
  gap after both frames pass a box mean of radius 8 (a window of 17 px, 1.3% of the frame width), inside the pixels whose
  whole window is in the region in both frames. It reads a broad patch of old light. It is `null` when no pixel keeps
  such a window. `--low-radius` sets the radius. A saved Unreal report made before `low` existed fails closed in
  `--unreal-report`. The 12 new metric specs failed first.
- 2026-10-21 (motion lane): the report layer, `FRAME_GATE` and `captureMotionFrames` specs were written after their
  code. They pass at once and are not red-first. The metric's own 38 specs were red first (stub that throws: 38 of 38 failed).
  The machine ran at a load of 30 to 100 while the runs were measured, so a measurement of 180 PNG frames took about ten
  minutes and a GPU slot took more than 30 minutes.

- 2026-10-21 (GI lane): the Unreal reference warms up for 180 frames, not 90. The real-time re-capture
  (`DownsampleFactor` 16, `TracingOctahedronResolution` 8 in the log) showed `sunlit-room` still 1% dark at
  90 frames, while 180, 360 and 720 agree inside the 0.22% noise floor. Only `L7-Epic` was captured at 180 and
  renamed to the default folder (`L7-Epic@90` keeps the old frames); the other variants keep their 90-frame
  captures until a judge round needs them. `reference-stats.json` holds the 180-frame statistics. No GI
  parity lock file exists: `compare.ts --write-locks` covers the L-ladder only, so locks for `gi:` cells wait for
  a PRD-647 scoreboard that defines them.
- 2026-10-20 (owner): calibration scenes come first in the GI sub-epic. They are created in Unreal,
  recreated in ThreeNative (PRD-646), and the visual judge calibrates against them until parity
  (PRD-647). The first plan, one Blender GLB loaded into both engines, is replaced: Unreal authors.
- 2026-10-20 (owner question "per PRD or many PRDs?"): the pipeline, the recreation and the loop are
  shared and filed once (PRD-638, PRD-646, PRD-647). Each GI PRD authors the scene or motion run for
  its own behaviour with the pipeline and is judged through PRD-647. `cornell` and `sunlit-room` sit
  here because most GI PRDs need them first.
- 2026-10-20 (PRD authoring): the target is Unreal's Lumen frame, not a path-traced ground truth. The
  owner's goal is the Unreal look. Unreal's path tracer can be added as a diagnosis column later if a
  judge needs to know whether Lumen itself is wrong in a cell.
- 2026-10-20 (Phase 1 measurement): `cornell` noise floor is 0.18% (largest run-to-run EV50 change of
  two Unreal runs at 180 warm-up frames); 90 warm-up frames already converge (largest 90-vs-180 change
  0.79%), so 90 stays the default. Exposure is manual EV100 5: a surface of L nits reads L x 2^-EV100
  in the EXR (measured as an exact 4x step from EV100 3 to 5).
- 2026-10-20 (Phase 1 measurement): region IDs use the unlit glTF proxy. The lit proxy adds Substrate's
  rough specular albedo with lighting off (a 0 channel arrived as 112); the unlit proxy encodes once
  more (linear 128 arrives as 222), which `compare.ts` accepts.
