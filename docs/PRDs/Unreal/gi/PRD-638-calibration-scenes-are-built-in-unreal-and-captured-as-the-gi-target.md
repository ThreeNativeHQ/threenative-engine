---
prd_contract: v1
---

# PRD-638 — Calibration scenes are built in Unreal and captured as the GI target

**Status:** NOT STARTED
**Priority:** P1 — no box is ticked: no scene authored in Unreal isolates colour bleed, interior sky light, leaks, emissive light or a moving light, so no GI change can be judged against Unreal. Every PRD in this folder is judged on these scenes.
**Complexity:** 7 (HIGH) — 1–5 files in the PRD-631 harness plus one scene folder per scene (+1), new system: a scene authoring and export pipeline inside Unreal (+2), new state: Level Sequences for motion runs (+2), external tool: the headless Unreal editor and its glTF exporter (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-631](../look/PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 1 (the headless Unreal capture). Recreation in ThreeNative is [PRD-646](PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md), and the calibration loop that uses the frames is [PRD-647](PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md).

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
| `neon-corridor` | Emissive strips, a 5 cm bright emitter, a textured wall, a point lamp | No sun, no sky | `neon`, `textured` | [PRD-639](PRD-639-a-surface-cache-gives-traced-rays-the-texture-glow-and-lights-of-what-they-hit.md) |
| `neon-corridor` (pose) | A chrome sphere and a glossy floor that reflect what is behind the camera | as above | `chrome` | [PRD-642](PRD-642-glossy-surfaces-reflect-what-the-camera-cannot-see.md) |
| `foliage` | Back-lit two-sided leaves, a glass pane, fog in a room | Sun 15° behind the leaves, sky light, height fog | `foliage`, `glass` | [PRD-643](PRD-643-glass-fog-and-leaves-take-the-bounce-light-too.md) |

| Motion run | Scene | Owner |
|---|---|---|
| `pan` (90° in 2 s) | `cornell` | PRD-638 (pipeline proof) |
| `neon` (strips off at frame 60, on at 120) | `neon-corridor` | [PRD-641](PRD-641-bounce-light-holds-still-while-the-camera-moves-and-follows-a-light-that-changes.md) |
| `door` (opens over 30 frames), `occluder` (a 1 m box crosses the window) | `sunlit-room` | [PRD-VQ-09](../../rendering/PRD-VQ-09-incremental-diffuse-relighting.md) |

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
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/gi/cornell/scene.py`, `tools/unreal-reference/build_level.py`, `scripts/unreal-look/compare.ts`, `scripts/__tests__/unreal-look-compare.spec.ts`
- [ ] The `pan` run renders 180 frames, and the motion metric fails closed on a missing frame, a frame-count mismatch or an empty region. proof: `pnpm unreal-look:capture --engine unreal --scene gi:cornell --motion pan` and `pnpm exec vitest run scripts/__tests__/unreal-look-compare.spec.ts`.
- [ ] Lumen updates between sequence frames: in a test run where the point light switches off at frame 60, the ceiling region responds over more than 1 frame. proof: `pnpm unreal-look:compare --scene gi:cornell --metric motion --engine unreal`.

## Decisions

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
