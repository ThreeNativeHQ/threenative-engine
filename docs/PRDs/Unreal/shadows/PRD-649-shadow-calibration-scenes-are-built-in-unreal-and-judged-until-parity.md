---
prd_contract: v1
---

# PRD-649 — Shadow calibration scenes are built in Unreal and judged until parity

**Status:** NOT STARTED
**Priority:** P1 — no box is ticked: no Unreal-authored scene isolates penumbra growth, contact, lamp shadows, leaf shadows or shadow stability under motion, so PRD-650 to PRD-652 and the open PRD-634 boxes have no Unreal target to be judged against.
**Complexity:** 5 (MEDIUM) — 1–5 files: a scene family switch, three `scene.py` scripts, shadow metrics in compare (+1), three new Unreal scenes and their recreation (+2), every shadow PRD consumes the scoreboard (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-638](../gi/PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 1 (the scene pipeline), [PRD-646](../gi/PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) Phase 2 (the recreation) and [PRD-647](../gi/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md) Phases 1 and 2 (the calibrate command, the judge and the scoreboard). This PRD adds a scene family to that pipeline. It does not build a second pipeline.

## Context

**Owner direction (2026-10-20):** every shadow PRD is judged on calibration scenes. A scene holds
one or several PRDs' features. It is created in Unreal, recreated in ThreeNative, and sent to the
visual judge until parity, with the screenshots posted on the PR. This repeats the GI rule
([PRD-647](../gi/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md)
`## Decisions`).

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
| `lamp-room` | A 6 × 4 × 3 m room with box furniture, a 1 cm rod 5 cm from a wall | A spot light at source radius 0 and 10 cm, a point light at 5 cm; no sun, no sky | `spot`, `spot-soft`, `point`, `rod` | [PRD-650](PRD-650-a-lamp-shadow-is-as-sharp-as-the-pixels-it-covers-and-softens-with-the-lamp-size.md), PRD-652 |
| `lamp-room` (run) | `swing`: a box crosses the spot cone in frames 60 to 120, then stops | as above | — | PRD-650 |
| `horizon` | A 2 × 2 km heightfield with hills; 30 m towers at 50, 300 and 1500 m | Sun at 15°; sky light | `near`, `far` | PRD-634, [PRD-457](../rendering/PRD-457-virtual-shadows-scale-by-measurement.md), PRD-652 |
| `horizon` (runs) | `walk`: the camera moves 10 m in 3 s; `sunturn`: the sun azimuth turns 10° in 3 s | as above | — | PRD-634 (stability) |
| `foliage` (the `gi:` scene of [PRD-643](../gi/PRD-643-glass-fog-and-leaves-take-the-bounce-light-too.md)) | Adds a leaf-card tree over open ground and card grass at a capsule's feet | Sun at 60° and 15° | `canopy`, `grass` | [PRD-651](PRD-651-leaves-cast-leaf-shadows-that-sway-near-the-camera.md) |
| `foliage` (run) | `wind`: the tree sways for 180 frames on a still camera | as above | — | PRD-651 |

   Whichever of PRD-643 or PRD-651 starts first authors `foliage` with both PRDs' elements.
5. **Unreal ablation frames (Phase 2).** Like the Lumen diagnosis views of PRD-638, three Unreal
   captures separate the parts of the default look before any ThreeNative code chases them:
   - `horizon` with `r.DistanceFieldShadowing 0` and `1`: does a distance-field far shadow show?
   - `penumbra-lab/contact` with `r.Shadow.Virtual.ScreenRayLength 0` and the default.
   - `penumbra-lab/heights` with `r.Shadow.Virtual.SMRT.RayCountDirectional 0`: the hard-shadow
     edge, which splits a coverage gap from a filter gap.

**Images.** As in PRD-647: sheets in the run's scratch folder, posted on the PR through the orphan
`PRD-<n>-screenshots` branch with UNREAL | ENGINE BEFORE | ENGINE AFTER and the engine named on
each frame. Only `scene.py`, `scene.glb`, `scene.json`, `criteria.md`, `scenes.json` and
`parity.json` are tracked.

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
- [ ] The contact-gap metric reads 0 for a box resting on the floor and grows with the gap on a lifted box, in Unreal frames of `penumbra-lab/contact`. proof: `pnpm unreal-look:compare --scene shadow:penumbra-lab --metric contact`. Open: `contactGap` and `--layer L5 --metric contact` ship (unit cases: 0, 4, 12 rows for a gap of 0, 4, 12; nothing when the floor stays lit). On Unreal's L5 frames a resting `Box_0` reads 0 in 4 of 5 poses and a lifted `Box_0p25` reads 63 (sun15 heights) and 48 (sun60 contact), but `Box_0` reads 9 in sun60 contact and `Box_0p25` reads 0 in sun60 and sun4 heights, where the shadow does not fall below the box in the image. The scan runs down the image, so it holds only when the shadow side faces the camera. A pose per box that faces the shadow side closes the box.
- [x] Unreal captures `penumbra-lab` at L5 and L9 for every pose and sun, with a region-ID frame. proof: `UE_ROOT=<install> pnpm unreal-look:capture --engine unreal --scene shadow:penumbra-lab`. Evidence: 2026-10-20 commit bd369168d, "L5 cells=18 readback ok" and "L9 cells=18 readback ok"; copied captures read back by `compare --metric penumbra` on 2026-10-21 (9 poses).

#### Phase 2: The lamp, horizon and foliage scenes, and the ablations
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/shadow/lamp-room/` (new), `tools/unreal-reference/shadow/horizon/` (new), `tools/unreal-reference/gi/foliage/` (shared with PRD-643), `scripts/unreal-look/compare.ts` (the `--ablation` pair)
- [ ] Unreal captures `lamp-room` and its `swing` run. proof: `pnpm unreal-look:capture --engine unreal --scene shadow:lamp-room`. Open: `lamp-room` is built and captured at L5 and L9 for its four poses (2026-10-21, "shadow:lamp-room ID cells=4 readback ok", exit 0); the `swing` run is not authored, so the box stays open.
- [ ] Unreal captures `horizon` with its `walk` and `sunturn` runs. proof: `pnpm unreal-look:capture --engine unreal --scene shadow:horizon`.
- [ ] The three ablation pairs are captured, and each result is recorded under `## Decisions` with its region deltas. proof: `pnpm unreal-look:compare --scene shadow:<name> --ablation <cvar>`.

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
