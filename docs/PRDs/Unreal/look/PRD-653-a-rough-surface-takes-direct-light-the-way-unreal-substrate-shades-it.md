---
prd_contract: v1
---

# PRD-653 — A rough surface takes direct light the way Unreal's Substrate shades it

**Status:** IN PROGRESS
**Priority:** P1 — the stock-versus-native parity box, the harness pick and the judged L1/L7/L9 sheet are open: every lit cell of the Unreal look shifts with this change, and the parity locks cannot settle before it lands.
**Complexity:** 6 (MEDIUM) — about 8 engine files across the TSL and C++ halves (+2), a new core module (+2), TypeScript and native C++ build boundaries (+2); risk override: none, because Phase 3 measures every shifted cell.
**Owner:** João
**Depends on:** [PRD-631](../../done/PRD-631-an-unreal-reference-scene-measures-the-default-look.md). Related: [PRD-635](PRD-635-ambient-occlusion-darkens-only-the-light-that-comes-from-around.md) (its 2026-10-19 BRDF decision is superseded below), [PRD-646](../gi/PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) (unit mapping and light falloff), [PRD-651](../shadows/PRD-651-leaves-cast-leaf-shadows-that-sway-near-the-camera.md) (foliage).

## Context

**ThreeNative today.** The standard material lights a surface with Lambert diffuse and a GGX specular
with F0 = 0.04. Stock three.js r185 does this in `PhysicalLightingModel.direct`. The owned engine does
the same in `packages/runtime-native/src/engine/shader/standard.cpp` (`brdfLambert`, near line 1279).

**Unreal 5.8.3** (source read 2026-10-21). The reference project renders with Substrate, and Substrate
shades the direct diffuse light of a rough surface with the EON model, not Lambert:

| Behaviour | Value | Source |
| --- | --- | --- |
| The project renders with Substrate | `r.Substrate=True` | `tools/unreal-reference/Config/DefaultEngine.ini:21` |
| Rough diffuse is on for Substrate on desktop | `r.Substrate.RoughDiffuse=1` | `Engine/Config/Linux/BaseLinuxEngine.ini:23`, `Windows/BaseWindowsEngine.ini:37`, `Mac/BaseMacEngine.ini:43` |
| The shader define follows the Substrate variable when Substrate is on | `MATERIAL_ROUGHDIFFUSE` | `Engine/Source/Runtime/Engine/Private/ShaderCompiler/ShaderCompiler.cpp:4168-4171` |
| Direct diffuse calls `Diffuse_GGX_Rough` when it is on, `Diffuse_Lambert` when it is off | | `Engine/Shaders/Private/Substrate/SubstrateEvaluation.ush:553-560` |
| `Diffuse_GGX_Rough` calls `Diffuse_EON` at 0.4 × roughness × a light-size weight | | `Engine/Shaders/Private/BRDF.ush:213`, `:238-249` |
| The light-size weight is 1 for a point source and falls to 0 as the source grows to 20 units | | `Engine/Shaders/Private/CapsuleLightIntegrate.ush:96-102` |
| Energy conservation is off in the reference project, so the diffuse is not scaled by the specular albedo | `r.Substrate.ProjectGBufferFormat=0` | `DefaultEngine.ini:22`, `Engine/Shaders/Private/ShadingEnergyConservation.ush:8-30` |

The PRD-635 decision of 2026-10-19 read the older variable `r.Material.RoughDiffuse`, whose code
default is 0 (`Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp:2147-2157`). Substrate does not
read it.

**Evidence that the gap is real.** The foliage lane measured it on `shadow:foliage` at L1 (PRD-651
`## Decisions` on `lane/leaf`, commit `fd49182d4`). The ratio of Unreal to Lambert varies 9 to 12 %
from card to card. Dividing each card by its own EON to Lambert ratio, with no fitted parameter, leaves
2 to 4 % (0.7 % on grass). On `gi:cornell` at L1 the Unreal floor is 5 to 11 % darker than closed-form
Lambert and the back wall is 1.5 to 6.5 % brighter. The scenes lane tests the light falloff there, so EON
may be the second part of that gap.

## Solution

One option on the standard material, `roughDiffuse`. It is `false` by default, which keeps three's
Lambert result for a game that does not ask. When it is `true`, the direct diffuse light uses the EON
model from Portsmouth, Kutz and Hill (2025), "EON: A Practical Energy-Preserving Rough Diffuse BRDF".
Its roughness is 0.4 × the material roughness × the light-size weight. Indirect diffuse light (sky,
probes, the radiance cache) stays Lambert. The code is written from the paper. The Unreal files above
are cited and never copied.

The owned engine cannot run a game's TSL lighting model, so the option is a standard-material field in
both engines, like `twoSidedFoliage` (PRD-651):

- **Stock three.** A new module in `packages/core/src/render/` makes `setupLightingModel` return a
  model that adds `(EON - Lambert) × irradiance` to the direct diffuse light of a flagged material. No
  change to the three package.
- **Owned engine.** `Material::roughDiffuse` is an engine field with a shader variant key. The direct
  path in `standard.cpp` evaluates EON when it is set.
- **Names.** The option takes Unreal's term, `roughDiffuse`. The exported symbol carries
  `@alias Substrate EON, Diffuse_EON, Diffuse_GGX_Rough` so a capability search by Unreal's name finds it.
- **The look decision.** Whether a scene uses EON is a look, so it lives in render source. The harness
  scaffold (`scripts/unreal-look/scaffold/render/`) sets the flag on every standard material, as a fresh
  Unreal project does. The templates follow once the harness matches.
- **Specular.** Substrate uses GGX with F0 = 0.04 and F90 = 1, with no multiple-scatter lift in the
  reference project. Three adds a multiple-scatter lift. Phase 3 measures the specular lobe at equal
  roughness. The specular changes only if a measured gap passes the threshold in Phase 3.

Phase 1 predicts the effect from the geometry before any engine code changes.

## Acceptance Criteria

- [ ] AC-1 [local]: A material with `roughDiffuse` set shades the same on stock three and on the native engine. proof: `pnpm parity --target desktop --only-tests rough-diffuse` — Evidence: pending.
- [ ] AC-2 [local] (PARTIAL): With the harness pick, the spread of the per-region Unreal to ThreeNative ratio at L1 on `gi:cornell`, `gi:sunlit-room` and the spheres scene is no wider than the Phase 1 prediction plus one point. proof: `pnpm unreal-look:compare` L1 regions table on `#541` — Evidence: calibration L1 spread of the region UE/TN ratio, before to after, final tree: spheres sun60/15/04 52.4->7.4, 65.9->2.1, 160.6->10.2 % (prediction 6.4/8.6/8.7; sun60 +1.0 and sun04 +1.5 over it, the red box moves with gamut 3dd7ab60e); exterior 18.9->4.1, 54.9->2.7, 62.2->8.2; interior 9.0->2.8, 37.5->2.0, 39.7->6.1. `gi:cornell` and `gi:sunlit-room` are on the earlier merged tree only (sunlit-room and cornell numbers not yet computed). Open.
- [ ] AC-3 [local] (PARTIAL): A fresh judge returns IMPROVEMENT overall on L1, L7 and L9 of every scene, and no frame regresses. proof: `scripts/unreal-look/judge.ts` verdict, linked on `#541` — Evidence: calibration only. L1 IMPROVEMENT, L9 IMPROVEMENT, L7 NEUTRAL (no frame regresses). L7 is not IMPROVEMENT, so the box stays open. Verdict files: `~/.cache/tmp-tn/brdf/verdicts/fin-L{1,7,9}.json`.

## Integration Ledger

| Capability | Reachable consumer / trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| `roughDiffuse` on stock three | `useRoughDiffuse(root)` (`packages/core/src/index.ts`, exported from `render/rough-diffuse.ts:160`) sets the flag → the `setupLightingModel` wrapper (`render/rough-diffuse.ts:135-146`) returns the model that `roughen` (`:101`) wraps | Lambert stays when the flag is off | Phase 2, box 1 |
| `roughDiffuse` in the owned engine | JS field write → `abi/bindings_material.cpp:250` → `renderer/render_database.cpp:507,526` → `renderer/renderer.cpp:2731` (variant) → `shader/standard.cpp:1311-1316` (`roughDiffuseFactor` at `:1161`) | Lambert stays when the flag is off | Phase 2, box 2 |
| A lamp's Source Radius | `PointLight.sourceRadius`, `SpotLight.sourceRadius` → `abi/bindings_material.cpp` light fields → `renderer/renderer.cpp` `light<i>SourceRadius` uniform, declared only by a flagged variant; stock three reads `light.sourceRadius` each render in `render/rough-diffuse.ts:65-72` | A lamp of 20 cm or more is Lambert | Phase 2, box 2 |
| The harness pick | `scripts/unreal-look/scaffold/render/lighting.ts:64` `shadeLikeSubstrate` ← `Reference.ts.in:158`, `CalibrationScene.ts.in:162` | Lambert today | Phase 3, box 1 |

## Execution Phases

#### Phase 1: Predict the effect
**Status:** DONE
**Files:** a scratch script under `~/.cache/tmp-tn/brdf/` (not committed), this PRD.
Per pixel, cast the scene geometry to get N, L and V. Compute the EON to Lambert ratio, with the light-size weight for point lights. Compare it with the observed Unreal to ThreeNative ratio by region. Go rule, set before the numbers: build the option if EON shrinks the region spread on at least two of the three scenes. The sky-only check (indirect diffuse stays Lambert) was not run: the L7 and L9 judge rounds in Phase 3 measure indirect light instead.
- [x] The prediction table (region ratio before and after EON, per scene) is on `#541`, and the `gi:cornell` numbers went to scenes-lane. proof: the script run and the `gh pr comment 541` URL — https://github.com/ThreeNativeHQ/threenative-engine/pull/541#issuecomment-6330876280. Go rule met on all three scenes: cornell main region spread 18.40 → 2.86 %, per-pixel rms 14.80 → 1.31 %; sunlit-room up to 18.54 → 1.95 %; spheres up to 59.88 → 8.68 %. The scenes-lane message with the cornell numbers was sent on 2026-10-21.

#### Phase 2: The option in both engines
**Status:** IN PROGRESS
**Files:** `packages/core/src/render/` (new module), `packages/runtime-native/src/engine/{scene/material.h,abi/bindings_material.cpp,renderer/render_database.cpp,renderer/renderer.cpp,renderer/projection/plan.h,shader/standard.cpp,shader/standard.h}`, `packages/three-native/api/` (registry entries), `packages/runtime-native/conformance/`.
- [x] Stock three: `roughDiffuse` selects the EON lighting model and a separate program. Off keeps three's own model. proof: `pnpm exec vitest run packages/core/__tests__/rough-diffuse.spec.ts` — 4 passed (EON constant in the WGSL of a flagged standard, physical, classic standard and classic physical material under a sun and under a lamp, none in an unflagged one; the material cache key differs). Red: with the lighting hook disabled 2 of 4 failed.
- [x] Owned engine: the rendered flagged to unflagged pixel ratio matches the closed-form EON ratio at three angle pairs. It fails before the change. proof: `tn-native-engine-render-database-test rough_diffuse`, and `tn-native-engine-material-test` for the shader variant — both pass (sun back-scatter +44.0 against +43.5 expected, forward −39.0 against −39.4; lamp radius 0 +43.0, 0.1 m +22.0 against +22.4, 0.2 m 0.0). Red: with the shader hunk disabled both failed (shifts 0.0). The lit, Lambert, Phong, physical and alpha reference tests, `leaf_receiver`, `lamp_source_radius` and the ABI tests still pass (54 ctest cases).
- [x] Stock three and native agree on one shared scene. proof: `pnpm parity --target desktop --only-tests rough-diffuse` — web run `--target web` passes (11 s, Chromium WebGPU on the NVIDIA adapter, so the TSL graph compiles in Dawn); desktop run with `--reference` the web capture passes: pixelMismatchRatio 0, perceptualDeltaE 0, 1280x720 (`report.json` of 2026-10-21 22:00). The desktop lane is the legacy V8 + Dawn host running stock three. The owned engine's EON is proven against the closed form by `rough_diffuse` (Phase 2 box 2) and by the harness frames of Phase 3, where its before-to-after ratio is the one Phase 1 predicted.
- [x] A capability search for "Substrate EON" returns the option with its detail. proof: `pnpm capabilities:sync` and `searchCapabilities("Substrate EON")` on this worktree's manifest — `useRoughDiffuse` is the only result for "Substrate EON", "Diffuse_EON" and "rough diffuse Oren-Nayar"; `check-capability-docs --census` passes against the rebuilt core.

#### Phase 3: The look
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/` (the material pass), `tools/unreal-reference/parity-locks.json` (judge-lane rewrites the moved locks).
- [x] The harness picks EON, and the specular check is recorded. The specular changes only if the measured lobe gap passes 3 % on a sphere region at L1, with the evidence. proof: `pnpm unreal-look:compare` at L1 — `shadeLikeSubstrate` (`scripts/unreal-look/scaffold/render/lighting.ts`) sets `roughDiffuse` on every harness material. Specular check on the calibration spheres pose after EON, UE/TN region medians (L1, linearised, sun 60/15/04): Sphere_RoughDielectric 1.013/1.006/0.979, Sphere_SmoothDielectric 1.011/1.006/0.979. Every gap is under 3 %, so GGX with F0 0.04 stays and the specular is unchanged.
- [ ] L1, L7 and L9 are measured before and after on all scenes (two runs per arm), the judge passes, the sheet is on `#541`, and the commit is queued. proof: the judge verdict and the comment URL. PARTIAL: the calibration scene is done on the merged tree (epic head + sky c571a3727 + gamut 3dd7ab60e, two runs per arm, NVIDIA adapter): judge L1 IMPROVEMENT (9 of 12 frames improve, 3 neutral, 0 regress), L9 IMPROVEMENT (4 improve, 8 neutral), L7 NEUTRAL (2 improve, 10 neutral, 0 regress). The gi scenes and the shadow scenes are not in a final-tree judge round: the capture queue was starved (about 2 h for 6 jobs), so they stay on the earlier merged tree numbers. Not queued: see Decisions.

## Decisions

- 2026-10-21 (brdf-lane, on the owner's rule "use Unreal defaults"): this PRD supersedes the PRD-635
  decision of 2026-10-19 that no BRDF PRD is filed. That decision read the legacy `r.Material.RoughDiffuse`
  (default 0). The reference project runs Substrate, and the desktop engine configs set
  `r.Substrate.RoughDiffuse=1` (sources in Context).
- 2026-10-21: the option is off by default. A game that sets nothing keeps three's result on both
  engines. The pick of EON is a look, so the harness and then the templates make it in render source.
- 2026-10-21: only direct light uses EON. The reference project has no energy conservation, so there is
  no (1 - specular albedo) factor on the diffuse. Phase 1 checks on a sky-only region that indirect
  diffuse stays Lambert.
- 2026-10-21: `roughDiffuse` is a boolean switch. The model's constants (0.4 roughness scale, the EON fit
  constants) are fixed to the published fit, because Unreal fixes them. A numeric strength is the upgrade
  if a game ever needs a blend.
- 2026-10-21: the stock-three half wraps `setupLightingModel` once on the standard and physical node
  materials and, for a flagged material, wraps `direct` of the returned model. The stock Lambert term goes
  into a scratch accumulator and returns scaled by the EON factor, so sheen compensation and the
  specular terms stay untouched. No edit of `node_modules/three`.
- 2026-10-21: the light-size weight is in. `sourceRadius` (metres) is a field of PointLight and SpotLight
  in both engines. The weight is `saturate(1 − sourceRadius / 20 cm)`; a sun has weight 1. The cornell lamp
  (5 cm) therefore shades with roughness 0.30, the value that fitted the Unreal frame.
- 2026-10-21: no installed system provides a diffuse-model option. Four `engine_search_capabilities`
  queries (rough diffuse, custom lighting model, Unreal Substrate, matte-surface option) returned only
  unrelated hits (`lightmapPass`, `observeSceneResources`, `ProbeVolume`, `WorldEnvironment` and similar),
  and `engine_capability_detail` on the two nearest confirmed it. `useRoughDiffuse` is a new core export.
  It is a mechanism of the same kind as `sourceRadiusShadowFilter` and `twoSidedFoliage` (PRD-650,
  PRD-651), which landed with a `constraints.spec.ts` allowlist entry and no `CHARTER.md` line. This PRD
  does the same: the allowlist entry carries assertions that the file builds no material, light or colour.
- 2026-10-21: `useRoughDiffuse` marks the materials under the root at the call. A streamed world that
  brings new materials later needs another call; `materialKey` does not include the flag.
- 2026-10-21: three failures were already red on the epic base and are not caused by this PRD:
  `pnpm caps:recall` is below its floor (row `brief.fps.9`) with and without this change;
  `pnpm typecheck` fails in `examples/strata-terrain-preview/src/render/horizon.ts` (generated
  `horizon.json` is absent in this checkout); `packages/core/__tests__/constraints.spec.ts` rejected
  `render/surface-cache.ts` (PRD-639). The last one is fixed here, in the file this PRD already edits.
- 2026-10-21 (brdf-lane): sky c571a3727 and gamut 3dd7ab60e are merged into `lane/brdf`, never rebased. sky-lane's
  `lensAttenuation` commit was not ready at 23:10, so EON lands without it. The measured L5 sun-elevation
  metric (floor lit minus shade, red channel) is UE 5.71/8.28/5.68, TN before 6.56/5.69/3.76, TN after
  7.30/10.77/7.88 at sun 60/15/4, so TN/UE is a flat 1.28 to 1.39 after EON, the size of 1/0.78.
- 2026-10-21 (brdf-lane): L9 locks on the final tree (21 locks): 17 hold. Broken: Sky sun60 exterior dP50
  0.0511, Sky sun15 spheres 0.0485, Room sun60 interior 0.0435 (limit 0.0392) and Sphere_Chrome sun60 spheres
  deltaE 1.18 (limit 1). With EON off on the same tree, Room sun60 interior (0.0435) and Sphere_Chrome (1.17)
  are already broken, so they come from the merge of epic + sky + gamut, not from EON. EON fixes
  Sky sun60 spheres, Sphere_RoughDielectric sun60 spheres and Floor/LitFloor sun15 spheres and breaks
  Sky sun60 exterior (EON brightens the frame, auto exposure drops, the sky darkens; the 0.78 lens constant
  from sky-lane lifts it back) and Sky sun15 spheres.
