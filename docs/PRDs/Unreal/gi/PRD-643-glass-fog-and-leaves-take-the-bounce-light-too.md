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

- [ ] AC-1 [local]: The glass pane and the fog-filled room regions on the owned engine match Unreal Epic within the PRD-631 thresholds at L7. proof: `pnpm unreal-look:compare --scene gi --layer L7` — Evidence: pending.
- [ ] AC-2 [local]: The back-lit leaf region of the `foliage` pose matches Unreal Epic within the thresholds. proof: the same command — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The conformance row `translucency-gi` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests translucency-gi` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Translucency reads the radiance cache | Translucent and transmissive node materials in the game | Replaces the sky's diffuse term on those materials | AC-1 |
| Fog reads the radiance cache | The VQ-07 volumetric fog froxel pass | Adds a GI term to the sun and sky terms | AC-1 |
| Two-sided foliage back face | Materials marked `twoSidedFoliage` | New | AC-2 |

## Execution Phases

#### Phase 1: What takes no GI
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/gi/foliage/{scene.py,criteria.md}` (new), `tools/unreal-reference/gi/scenes.json`
- [ ] `foliage` is ready to calibrate: authored and captured in Unreal, recreated with direct light matching (PRD-646), and its PRD-647 criteria written. proof: `pnpm unreal-look:capture --engine unreal --scene gi:foliage --check-cvars` and `pnpm unreal-look:compare --scene gi:foliage --layer L1`.
- [ ] The materials and fog froxels that take no GI on the `foliage` scene are listed under `## Decisions`, with the per-region error against Unreal Epic. proof: `pnpm unreal-look:compare --scene gi:foliage --layer L7`.

#### Phase 2: Glass and fog
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-volume.ts`, the VQ-07 fog pass, `packages/core/__tests__/probe-volume.spec.ts`
- [ ] A translucent pixel and a fog froxel read the same irradiance as an opaque pixel at the same point. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`.
- [ ] The per-pixel read on a full-screen glass pane costs no more than 0.5 ms at 1920 × 1080, or the froxel decision is recorded. proof: `node packages/playtest/dist/runner/cli.js perf` on the harness.

#### Phase 3: Leaves lit from behind
**Status:** NOT STARTED
**Files:** `packages/core/src/render/two-sided-foliage.ts` (new), `packages/core/__tests__/two-sided-foliage.spec.ts` (new), `packages/runtime-native/conformance/scenes/shared/foliage-back-light.js` (new), `packages/runtime-native/conformance/registry.json`
- [x] A `twoSidedFoliage` material adds `subsurfaceColor ×` the back-face irradiance, and a material without `subsurfaceColor` adds nothing. proof: `pnpm exec vitest run packages/core/__tests__/two-sided-foliage.spec.ts` — 4 of 4 pass, and the spec fails with the `subsurfaceColor` guard removed. Native: `pnpm parity --target desktop --only-tests foliage-back-light` (web reference first) passes at 0 % mismatch and delta E 0 against the 0.03 / 4 tolerance. With the helper call skipped the same row shows 6.36 % and 6.8, so the row fails. Host: a built desktop host borrowed from another lane (TS-only change). Row: `foliage-back-light` in `registry.json`.
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
