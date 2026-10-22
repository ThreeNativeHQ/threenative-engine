---
prd_contract: v1
---

# PRD-653 — A rough surface takes direct light the way Unreal's Substrate shades it

**Status:** NOT STARTED
**Priority:** P1 — no box is ticked: every lit cell of the Unreal look shifts with this change, and the parity locks cannot settle before it lands.
**Complexity:** 6 (MEDIUM) — about 8 engine files across the TSL and C++ halves (+2), a new core module (+2), TypeScript and native C++ build boundaries (+2); risk override: none, because Phase 3 measures every shifted cell.
**Owner:** João
**Depends on:** [PRD-631](PRD-631-an-unreal-reference-scene-measures-the-default-look.md). Related: [PRD-635](PRD-635-ambient-occlusion-darkens-only-the-light-that-comes-from-around.md) (its 2026-10-19 BRDF decision is superseded below), [PRD-646](../gi/PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) (unit mapping and light falloff), [PRD-651](../shadows/PRD-651-leaves-cast-leaf-shadows-that-sway-near-the-camera.md) (foliage).

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
- [ ] AC-2 [local]: With the harness pick, the spread of the per-region Unreal to ThreeNative ratio at L1 on `gi:cornell`, `gi:sunlit-room` and the spheres scene is no wider than the Phase 1 prediction plus one point. proof: `pnpm unreal-look:compare` L1 regions table on `#541` — Evidence: pending.
- [ ] AC-3 [local]: A fresh judge returns IMPROVEMENT overall on L1, L7 and L9 of every scene, and no frame regresses. proof: `scripts/unreal-look/judge.ts` verdict, linked on `#541` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer / trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| `roughDiffuse` on stock three | `material.roughDiffuse = true` → core `setupLightingModel` wrapper in `packages/core/src/render/` | Lambert stays when the flag is off | Phase 2, box 1 |
| `roughDiffuse` in the owned engine | JS field write → `abi/bindings_material.cpp` → `renderer/render_database.cpp` → `shader/standard.cpp` direct path | Lambert stays when the flag is off | Phase 2, box 2 |
| The harness pick | `scripts/unreal-look/scaffold/render/` sets the flag on each standard material | Lambert today | Phase 3, box 1 |

## Execution Phases

#### Phase 1: Predict the effect
**Status:** NOT STARTED
**Files:** a scratch script under `~/.cache/tmp-tn/brdf/` (not committed), this PRD.
Per pixel, cast the scene geometry to get N, L and V. Compute the EON to Lambert ratio, with the light-size weight for point lights. Compare it with the observed Unreal to ThreeNative ratio by region. Go rule, set before the numbers: build the option if EON shrinks the region spread on at least two of the three scenes. Also check a sky-only region, to confirm that indirect diffuse stays Lambert.
- [ ] The prediction table (region ratio before and after EON, per scene) is on `#541`, and the `gi:cornell` numbers went to scenes-lane. proof: the script run and the `gh pr comment 541` URL.

#### Phase 2: The option in both engines
**Status:** NOT STARTED
**Files:** `packages/core/src/render/` (new module), `packages/runtime-native/src/engine/{scene/material.h,abi/bindings_material.cpp,renderer/render_database.cpp,renderer/renderer.cpp,renderer/projection/plan.h,shader/standard.cpp,shader/standard.h}`, `packages/three-native/api/` (registry entries), `packages/runtime-native/conformance/`.
- [ ] Stock three: `roughDiffuse` selects the EON lighting model and a separate program. Off keeps three's own model. proof: `pnpm exec vitest run packages/core/__tests__/rough-diffuse.spec.ts`.
- [ ] Owned engine: the rendered flagged to unflagged pixel ratio matches the closed-form EON ratio at three angle pairs. It fails before the change. proof: `tn-native-engine-render-database-test rough_diffuse`, and `tn-native-engine-material-test` for the shader variant.
- [ ] Stock three and native agree on one shared scene. proof: `pnpm parity --target desktop --only-tests rough-diffuse`.
- [ ] A capability search for "Substrate EON" returns the option with its detail. proof: `pnpm build`, then `engine_search_capabilities` for "Substrate EON".

#### Phase 3: The look
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/` (the material pass), `tools/unreal-reference/parity-locks.json` (judge-lane rewrites the moved locks).
- [ ] The harness picks EON, and the specular check is recorded. The specular changes only if the measured lobe gap passes 3 % on a sphere region at L1, with the evidence. proof: `pnpm unreal-look:compare` at L1.
- [ ] L1, L7 and L9 are measured before and after on all scenes (two runs per arm), the judge passes, the sheet is on `#541`, and the commit is queued. proof: the judge verdict and the comment URL.

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
