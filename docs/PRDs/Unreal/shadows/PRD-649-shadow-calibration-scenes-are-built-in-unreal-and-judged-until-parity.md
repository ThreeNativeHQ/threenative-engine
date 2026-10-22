---
prd_contract: v1
---

# PRD-649 — Shadow calibration scenes are built in Unreal and judged until parity

**Status:** NOT STARTED
**Priority:** P1 — no box is ticked: no Unreal-authored scene isolates penumbra growth, contact, lamp shadows, leaf shadows or shadow stability under motion, so PRD-650 to PRD-652 and the open PRD-634 boxes have no Unreal target to be judged against.
**Complexity:** 5 (MEDIUM) — 1–5 files: a scene family switch, three `scene.py` scripts, shadow metrics in compare (+1), three new Unreal scenes and their recreation (+2), every shadow PRD consumes the scoreboard (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-638](../../done/PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 1 (the scene pipeline), [PRD-646](../gi/PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) Phase 2 (the recreation) and [PRD-647](../../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md) Phases 1 and 2 (the calibrate command, the judge and the scoreboard). This PRD adds a scene family to that pipeline. It does not build a second pipeline.

## Context

**Owner direction (2026-10-20):** every shadow PRD is judged on calibration scenes. A scene holds
one or several PRDs' features. It is created in Unreal, recreated in ThreeNative, and sent to the
visual judge until parity, with the screenshots posted on the PR. This repeats the GI rule
([PRD-647](../../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md)
`## Decisions`).

- 2026-10-22 (the bright rim at the room junctions is the GI cache read, not a shadow): the calibration interior showed a thin bright line along the roof edge and the corners already at L5. With the same pose the rim is the same under `&recvBias=0` and `&off=vsm`, and gone under `&off=gi`, so no shadow bias causes it. Cause: `irradianceAt` in `scripts/unreal-look/scaffold/render/giCache.ts` blends eight walks by the start texel's weight to the fourth power. A wall thinner than a texel (the 0.2 m roof and side walls) cuts the link between two texels, but the texel on the far side (sky above the roof) still kept its own start weight: 0.48 against 0.52 one centimetre under the roof. Fix: the bake stores where each cut link's wall starts (`walls`, a seventh slice of the volume), and the reader gives a start no weight when a wall on its links has the read point on the other side (`WALL_SOFT`). Ceiling-edge ratio (wall pixels 1 to 5 px under the roof edge over the wall 30 px lower), L5 sun60 interior: 1.52 before, 1.00 after (two runs each); judge IMPROVEMENT at L5 and at L9 (sun60 and sun15 interior, spheres NEUTRAL). Native parity locks were not run (see the queue line).
**What exists.** The PRD-631 reference scene has an L5 shadow layer and a penumbra metric
(`scripts/unreal-look/penumbra.ts`). PRD-634 tunes the sun penumbra against it. The scene has no
lamp, no leaf card, no caster at a known height and no motion, so it cannot judge PRD-650 to
PRD-652. The GI pipeline (PRD-638) names scenes with a family prefix, `--scene gi:<name>`, and keeps
them in `tools/unreal-reference/gi/<scene>/`.

**What Unreal 5.8.3 shows by default** (source read 2026-10-20; clean-room summary, no code copied):

- The reference project turns on virtual shadow maps and mesh distance fields
  (`tools/unreal-reference/Config/DefaultEngine.ini`: `r.Shadow.Virtual.Enable=1`,
  `r.GenerateMeshDistanceFields=True`). Every light, the lamps included, shadows through the
  virtual shadow map and shadow-map ray tracing (SMRT).
- Shadow quality Epic: 8 rays × 4 samples for the sun and for lamps, a directional resolution bias
  of −1.5, and distance-field shadowing on (`Engine/Config/BaseScalability.ini:240-265`).
- A short screen-space ray (`r.Shadow.Virtual.ScreenRayLength` 0.015) starts each shadow ray past
  the receiver's own geometry (`Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapScreenRayTrace.ush`).
  This is not the light's contact shadow, which stays off (length 0, `LightComponent.cpp:470`).
- The directional light keeps `bUseRayTracedDistanceFieldShadows = true` and a distance-field
  shadow distance of 512 m (`Engine/Source/Runtime/Engine/Private/Components/DirectionalLightComponent.cpp:1043-1046`).
  The source does not settle whether a far distance-field cascade renders beside the virtual
  shadow clipmap (`ShouldCreateRayTracedCascade`, `:554-567`; `Engine/Source/Runtime/Renderer/Private/ShadowSetup.cpp:4401`).
  Phase 2 measures it.

## Solution

1. **A `shadow:` family on the PRD-638 pipeline (Phase 1).** `--scene shadow:<name>` reads
   `tools/unreal-reference/shadow/<name>/` (`scene.py`, `scene.glb`, `scene.json`, `criteria.md`)
   and registers it in `tools/unreal-reference/shadow/scenes.json` with its owner PRD. A registry
   entry can point at a scene of the `gi:` family, so one scene serves both families and is
   authored once. Capture, recreation (`CalibrationScene.ts.in`), the calibrate command, the judge
   and the parity rule are the PRD-647 ones, unchanged. The scoreboard is
   `tools/unreal-reference/shadow/parity.json`.
2. **Shadow layers.** Shadow cells are captured at L5: sun, lamps and shadows, with GI, AO and fog
   off. The judge then sees direct shadow alone, and GI cannot hide or add a shadow. Each pose also
   gets one L9 frame, the look a player sees. A shadow scene is captured at the Unreal quality
   level of its tier (`high` against Epic, as in PRD-644).
3. **Shadow metrics in `compare`.** Per shadow region: penumbra width (`penumbra.ts`), the contact
   gap between a caster's base and its shadow (peter-panning), the acne score PRD-634 already
   uses, and for a motion run the flicker metric of PRD-638. The judge reads the criteria, the
   sheets and these numbers.
4. **The scenes.** One scene holds the features of several PRDs:

| Scene | What it isolates | Light | Poses | Serves |
| --- | --- | --- | --- | --- |
| `penumbra-lab` | 0.5 m boxes at 0, 0.25, 1, 4 and 10 m over a white floor; a 2 cm pole; a 15° ramp for acne; a 1 m step | Sun at 60°, 15° and 4°; sky light | `heights`, `contact`, `ramp` | [PRD-634](../look/PRD-634-sun-shadows-reach-the-horizon-and-soften-with-distance-from-the-caster.md), [PRD-652](PRD-652-the-shadow-tier-follows-unreal-shadow-quality-levels.md) |
| `lamp-room` | A 6 × 4 × 3 m room with box furniture, a 1 cm rod 5 cm from a wall | A spot light at source radius 0 and 10 cm, a point light at 5 cm; no sun, no sky | `spot`, `spot-soft`, `point`, `rod` | [PRD-650](../../done/PRD-650-a-lamp-shadow-is-as-sharp-as-the-pixels-it-covers-and-softens-with-the-lamp-size.md), PRD-652 |
| `lamp-room` (run) | `swing`: a box crosses the spot cone in frames 60 to 120, then stops | as above | — | PRD-650 |
| `horizon` | A 2 × 2 km heightfield with hills; 30 m towers at 50, 300 and 1500 m | Sun at 15°; sky light | `near`, `far` | PRD-634, [PRD-457](../rendering/PRD-457-virtual-shadows-scale-by-measurement.md), PRD-652 |
| `horizon` (runs) | `walk`: the camera moves 10 m in 3 s; `sunturn`: the sun azimuth turns 10° in 3 s | as above | — | PRD-634 (stability) |
| `foliage` (the `gi:` scene of [PRD-643](../gi/PRD-643-glass-fog-and-leaves-take-the-bounce-light-too.md)) | Adds a leaf-card tree over open ground and card grass at a capsule's feet | Sun at 60° and 15° | `canopy`, `grass` | [PRD-651](PRD-651-leaves-cast-leaf-shadows-that-sway-near-the-camera.md) |
| `foliage` (run) | `wind`: the tree sways for 180 frames on a still camera | as above | — | PRD-651 |
| `wildwood` | Real vegetation, three Fab GLBs of the sandbox wildwood game: one broadleaf tree, one bush and one fern clump on a flat floor, and nothing else of that game. The files are not in the repository | Sun at 60° and 15° | `closeup`, `medium` | [PRD-651](PRD-651-leaves-cast-leaf-shadows-that-sway-near-the-camera.md), PRD-643 |

   Whichever of PRD-643 or PRD-651 starts first authors `foliage` with both PRDs' elements.
   The owner asked for real vegetation (2026-10-21), so the judge takes `wildwood` as the foliage
   target. `foliage` stays as the procedural control and keeps the `wind` run.
5. **Unreal ablation frames (Phase 2).** Like the Lumen diagnosis views of PRD-638, three Unreal
   captures separate the parts of the default look before any ThreeNative code chases them:
   - `horizon` with `r.DistanceFieldShadowing 0` and `1`: does a distance-field far shadow show?
   - `penumbra-lab/contact` with `r.Shadow.Virtual.ScreenRayLength 0` and the default.
   - `penumbra-lab/heights` with `r.Shadow.Virtual.SMRT.RayCountDirectional 0`: the hard-shadow
     edge, which splits a coverage gap from a filter gap.

**Images.** As in PRD-647: sheets in the run's scratch folder, posted on the PR through the orphan
`PRD-<n>-screenshots` branch with UNREAL | ENGINE BEFORE | ENGINE AFTER and the engine named on
each frame. Only `scene.py`, `scene.glb`, `scene.json`, `criteria.md`, `scenes.json` and
`parity.json` are tracked. `wildwood` tracks `manifest.json` in place of `scene.glb`, and no Fab model,
texture or frame of them is tracked: Unreal frames of these models go to the gitignored
`tools/unreal-reference/captures/` (or to `--out` in the run's work folder), and the sheets go to the
screenshots branch only.

## Acceptance Criteria

- [ ] AC-1 [local]: The baseline round on `penumbra-lab`, `lamp-room` and `horizon` at `high` writes three sheets per pose, a judge answer per cell and one scoreboard entry per cell. proof: `pnpm unreal-look:calibrate --scene shadow:<name> --tier high --before HEAD` for each scene — Evidence: pending.
- [ ] AC-2 [local]: The PRD records whether Unreal's default look includes a distance-field far shadow, from the `horizon` ablation pair. proof: `pnpm unreal-look:compare --scene shadow:horizon --ablation r.DistanceFieldShadowing` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `shadow:` scene family | `pnpm unreal-look:capture --scene shadow:<name>` and `pnpm unreal-look:calibrate --scene shadow:<name>` | New family on the PRD-638 pipeline; the `gi:` family is unchanged | Phase 1 |
| Shadow metrics | `scripts/unreal-look/compare.ts` reads `penumbra.ts` and the new contact-gap metric | Extends compare; no new tool | Phase 1 |
| Shadow scoreboard | `tools/unreal-reference/shadow/parity.json`, cited by the PRD-634 and PRD-650 to PRD-652 visual boxes | New | AC-1 |

## Execution Phases

#### Phase 1: The family and the first scene
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/capture.ts`, `scripts/unreal-look/compare.ts`, `scripts/unreal-look/penumbra.ts`, `tools/unreal-reference/shadow/scenes.json` (new), `tools/unreal-reference/shadow/penumbra-lab/` (new), `scripts/__tests__/unreal-look-calibrate.spec.ts`
- [ ] `--scene shadow:<name>` resolves a scene of either family, and fails closed on an unknown name, a missing `criteria.md` and an L5 cell captured with GI on. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-calibrate.spec.ts`.
- [ ] The contact-gap metric reads 0 for a box resting on the floor and grows with the gap on a lifted box, in Unreal frames of `penumbra-lab/contact`. proof: `pnpm unreal-look:compare --scene shadow:penumbra-lab --metric contact`. Open: `contactGap` and `--layer L5 --metric contact` ship (unit cases: 0, 4, 12 rows for a gap of 0, 4, 12; nothing when the floor stays lit). On Unreal's L5 frames a resting `Box_0` reads 0 in 4 of 5 poses and a lifted `Box_0p25` reads 63 (sun15 heights) and 48 (sun60 contact), but `Box_0` reads 9 in sun60 contact and `Box_0p25` reads 0 in sun60 and sun4 heights, where the shadow does not fall below the box in the image. The scan runs down the image, so it holds only when the shadow side faces the camera. A pose per box that faces the shadow side closes the box. Numbers on the ThreeNative frames (2026-10-21, two runs agree, PR #541 comment 6332495123): lifted boxes read 38 against Unreal's 37 (sun60-heights Box_1), 48 against 48 (sun60-contact Box_0p25) and 0 against 0; ThreeNative has no reading on sun15-heights Box_0p25 (Unreal 63) and sun60-contact Box_0, so the box stays open.
- [x] Unreal captures `penumbra-lab` at L5 and L9 for every pose and sun, with a region-ID frame. proof: `UE_ROOT=<install> pnpm unreal-look:capture --engine unreal --scene shadow:penumbra-lab`. Evidence: 2026-10-20 commit bd369168d, "L5 cells=18 readback ok" and "L9 cells=18 readback ok"; copied captures read back by `compare --metric penumbra` on 2026-10-21 (9 poses).

#### Phase 2: The lamp, horizon and foliage scenes, and the ablations
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/shadow/lamp-room/` (new), `tools/unreal-reference/shadow/horizon/` (new), `tools/unreal-reference/gi/foliage/` (shared with PRD-643), `tools/unreal-reference/shadow/wildwood/` (new), `scripts/unreal-look/wildwood.ts` (new), `scripts/unreal-look/compare.ts` (the `--ablation` pair)
- [ ] Unreal captures `lamp-room` and its `swing` run. proof: `pnpm unreal-look:capture --engine unreal --scene shadow:lamp-room`. Open: `lamp-room` is built and captured at L5 and L9 for its four poses (2026-10-21, "shadow:lamp-room ID cells=4 readback ok", exit 0); the `swing` run is not authored, so the box stays open.
- [ ] Unreal captures `horizon` with its `walk` and `sunturn` runs. proof: `pnpm unreal-look:capture --engine unreal --scene shadow:horizon`.
- [ ] The three ablation pairs are captured, and each result is recorded under `## Decisions` with its region deltas. proof: `pnpm unreal-look:compare --scene shadow:<name> --ablation <cvar>`.
- [x] Unreal and ThreeNative capture the lean `wildwood` scene from the three real Fab GLBs at L5, L7 and L9, with two suns, two poses and two runs per arm. proof: `UE_ROOT=<install> pnpm unreal-look:capture --engine unreal --scene shadow:wildwood` and `pnpm unreal-look:capture --engine threenative --scene shadow:wildwood`. Evidence: 2026-10-21 at 487219145: Unreal exit 0 (cells=52: L5, L7 and L9 twice, ID once), ThreeNative run 1 cells=16 and run 2 cells=12, both rc 0; sheets, region tables and IoU on PR #541 (issuecomment-6329578609).
- [x] The lean `wildwood` ID frames pass the sameness gate in every pose. proof: `pnpm unreal-look:compare --sameness --scene shadow:wildwood --captures <root>`. Evidence: 2026-10-21, Unreal imported with Nanite off against the ThreeNative ID frames at the epic head 0453b549f: 16 objects in 4 poses, farthest edge 1 px, 0 poses fail, 99.38 to 99.74 percent of the pixels agree, lowest IoU 0.9488 (`GreenTree_1`, medium). With Nanite on the same gate failed in 4 of 4 poses (farthest edge 37 px).

#### Phase 3: Recreation and the baseline round
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/shadow/*/criteria.md`, `tools/unreal-reference/shadow/parity.json` (new)
- [ ] ThreeNative recreates each scene on the owned engine and passes the PRD-646 checks: region-ID edges within 1 px and L1 direct-light cells inside the thresholds. proof: `pnpm unreal-look:capture --engine threenative --scene shadow:<name>` then `pnpm unreal-look:compare --scene shadow:<name> --layer L1`.
- [ ] AC-1 holds, and its sheets are posted on PR #541. proof: the AC-1 commands.
**Verification:** AC-1 and AC-2.

## Decisions

- 2026-10-20 (owner): shadow PRDs use Unreal-authored calibration scenes and the visual judge until
  parity, with screenshots on the PR. One scene may hold several PRDs' features.
- 2026-10-20 (slicing): this PRD extends the PRD-638/646/647 pipeline with a family and does not
  copy it. Shadows are judged at L5, not L7, so a GI change cannot pass as a shadow change.
- 2026-10-21 (lane): `pnpm unreal-look:compare --scene shadow:<name> --layer L5 --metric penumbra` prints the
  floor edge widths per pose. BEFORE baseline on `penumbra-lab` (TN / UE, median 10 to 90 percent width):
  sun 60 heights 0.64, contact 1.08, ramp 1.33; sun 15 1.14, 2.20, 2.74; sun 4 1.71, 3.27, 1.92. Two runs agree.
  `lamp-room` adds SpotLight to the pipeline (target and cone angles in scene.json, `validateSceneExport`).
- 2026-10-21 (wildwood lane, owner): the vegetation target uses real assets. The owner asked three
  times for the Fab GLBs of the sandbox wildwood game in place of procedural cards.
  `shadow:wildwood` places them from `tools/unreal-reference/shadow/wildwood/manifest.json`. The
  repository is public and the files are licensed, so the manifest names each file with its sha256
  and each instance with its transform, and the files come from `TN_WILDWOOD_ASSETS`. A missing
  root, a missing file or a changed hash stops the run before any engine starts
  (`scripts/unreal-look/wildwood.ts`, `scripts/__tests__/unreal-look-wildwood.spec.ts`).
- 2026-10-21 (wildwood lane, owner): keep the vegetation scene lean. The owner said the comparison does
  not need the whole wildwood scene. The first build held 10 instances (a pine, a tree, a bush, two
  ferns, three grass clumps and two flower clumps) in 3 poses; it is trimmed to one broadleaf tree
  (`SM_green-tree01`), one bush (`SM_bush01`) and one fern clump (`SM_FarnGroup01`) in 2 poses:
  `closeup` (leaf shadows on the ground, the trunk and the understory) and `medium` (the whole tree and
  the length of the shadows). The layers are L5 and L9, plus L7 because the light on the leaves is
  measurably off at L9. Both engines run 2 times per arm.
- 2026-10-21 (wildwood lane): Unreal imports each file with its own glTF importer (Interchange),
  from a decoded copy, because that importer has no `EXT_meshopt_compression` and the files carry it.
  The copy holds the same triangles, UVs, textures and materials. Interchange draws a masked
  material through sorted translucency, which does not cut a shadow. The build therefore rebuilds
  each slot on the exporter's glTF master as Masked and two-sided with the file's own cutoff, and it
  keeps the importer's textures. `scene.json` reports each slot, and the capture compares it with the
  file's JSON before any frame is rendered. ThreeNative loads one GLB composed from the same decoded
  copies (the floor box of `scene.json`, one node per manifest instance), so both engines read the
  same triangles and the same textures.
- 2026-10-21 (wildwood lane): the lean `wildwood` scene is captured in both engines (L5, L7, L9, two
  suns, two poses, two runs per arm) and judged against Unreal. The judge reads CLOSE at L5, FAR at L7
  (`sun60-closeup`, `sun60-medium`) and CLOSE at L9 (`sun15-medium` FAR). It read BEFORE and AFTER from
  the same files, because this lane changes no engine code. The tree median is 0.38 to 0.87 above
  Unreal at L7 and 0.19 to 0.73 above it at L9 (limit 0.25), and the floor shadows are shallower with
  global illumination on (floor 5th over 95th percentile, `sun60-closeup`: Unreal 0.63, ThreeNative
  0.84 at L7; 0.38 and 0.57 at L9). Leaf gaps are visible in the ground shadow in every round. The
  symptoms are with leaf-lane (PRD-643). The sameness gate fails; see its box in Phase 2.
- 2026-10-21 (wildwood lane): Unreal omitted a short branch that ThreeNative draws in the lean `wildwood`
  frames (647 px at `sun60-closeup`). The source GLB holds it as opaque geometry and the Unreal import
  keeps all 14927 triangles, so Nanite was the suspect. Decision: `import_glb` of `export.py` turns Nanite
  off (`nanite_settings.enabled = False`). With Nanite off the sameness gate passes in 4 of 4 poses
  (farthest edge 1 px). The stock default is Nanite on: `bBuildNanite = true` in
  `Engine/Plugins/Interchange/Runtime/Source/Pipelines/Public/InterchangeGenericMeshPipeline.h:134`, and
  `NaniteTriangleThreshold = 0` enables it for every mesh. So Nanite off is a named override of the
  harness, taken because the calibration needs the same triangles in both engines and Nanite drops thin
  branches. The lighting rows move little: the tree dP50 changes by at most 0.10 between the two imports (L5, sun15-closeup, 0.15 to 0.25).
  All Unreal frames of this scene are Nanite off from 2026-10-21 20:00 on.
- 2026-10-22 (wildwood2 lane): what fills the floor shadow of `shadow:wildwood` at L7, by ablation. Metric: the
  median floor luminance in the shade over the median in the sun, scene-linear, on the same pixels in both
  engines (the floor pixels that Unreal shades, below a quarter of its 95th percentile, and lights, above half
  of it). Unreal frames are its `.exr`. ThreeNative frames are `linear=1&exposure=0.12` PNGs: `linear=1` removes the
  tone curve only, so the PNG is still sRGB-encoded and the script decodes it first (a doubled exposure gives 1.40 times
  the byte level, not 2.08). **Correction, same day:** the first version of this note and the #541 comment
  6343291184 compared the encoded bytes, and read 0.485 for ThreeNative against Unreal's 0.099. The numbers below
  are decoded and replace them. Script: `split-analyze.py` and `abl-analyze.py` in `~/.cache/tmp-tn/wildwood/`.

  | `shade / sun` | sun60-closeup | sun15-closeup |
  |---|---:|---:|
  | Unreal 5.8.3, L7 | 0.099 | 0.191 |
  | ThreeNative, L7 everything on | 0.208 | 0.233 |
  | Unreal, L5 (sun, sky light, no GI, no AO) | 0.087 | 0.191 |
  | ThreeNative, L5 | 0.090 | 0.203 |
  | Unreal, L5 sun only (`L5-direct`: `r.SkylightIntensityMultiplier` 0) | 0.009 | 0.002 |
  | ThreeNative, sun only (`off=gi,gtao,ssgi&envMul=0`) | 0.021-0.023 | 0.045-0.046 |
  | ThreeNative L7 `giBounces=0` / `1` / `2` / `5` | 0.082 / 0.084 / 0.162 / 0.208 | 0.185 / 0.187 / 0.213 / 0.233 |
  | `skyMul=0` / `off=gi` | 0.143 / 0.114 | 0.125 / 0.207 |
  | `off=gtao` / `off=ssgi` | 0.212 / 0.220 | 0.243 / 0.244 |
  | `probes=1` / `ssgiQuality=epic` / `tier=medium` | 0.212 / 0.208 / 0.215 | 0.237 / 0.234 / 0.235 |
  | cell 0.25 m (local patch, not committed) | 0.202 | 0.231 |

  Result. (1) The sun-only shade is small in both engines: ThreeNative 0.02 and 0.045 against Unreal's 0.009 and 0.002.
  The absolute gap is 0.01 of the sunlit floor at sun60 and 0.04 at sun15, so the direct leak under the crown is real
  but minor. (2) The sky light matches: at L5 ThreeNative reads 0.090 and 0.203 against Unreal's 0.087 and 0.191.
  (3) The fault is at L7 at sun60: ThreeNative reads 0.208 against 0.099 (2.1 times), at sun15 0.233 against 0.191
  (1.2 times). Unreal's GI adds 0.012 to the L5 value at sun60 (0.087 to 0.099), ThreeNative's adds 0.118 (0.090 to
  0.208). The GI cache adds it in bounce passes 2 to 5 (0.084 to 0.162 to 0.208); the first pass and the sky-only
  pass add nothing. (4) Cell size (0.25 m), AO, SSGI, the screen-space gather arms and the `medium` tier move the ratio
  by at most 0.01, so neither cell blur nor the gather method is the cause. Unreal's L7 method is Lumen ScreenProbeGather
  (`r.DynamicGlobalIlluminationMethod=1`, `sg.GlobalIlluminationQuality 3` = `Engine/Config/BaseScalability.ini:416-438`,
  set in `tools/unreal-reference/layers.json` L7 and `shadow/scenes.json:98-99`). `tier=low` is not a valid arm (no GI, no sky shadow).
  Candidates, not measured: the sun bounce of leaf cards that the bake shades from the underside (`surface()` uses
  `max(0, n.sun)` on the hit normal), and the `SHADE_CELL` 0.5 m share of sun visibility per object. Knobs that
  perf2-lane needs on `installGi` (none exist; `CELL` at `giCache.ts:160` and `MAX_POINTS` at `giCache.ts:179` are
  constants): `giCell`, `giMax`, `giShadeCell`, `giSkipObject` (bake without one named object). Harness knobs in
  `Reference.ts.in`: `envMul=N`, `giBounces=N`. The new Unreal variant `L5-direct` in `shadow/scenes.json` is opt-in
  (`--variants L5-direct`). The local `CELL` patch was measurement only and is not committed.
