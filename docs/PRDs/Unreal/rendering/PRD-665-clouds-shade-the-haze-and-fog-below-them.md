---
prd_contract: v1
---

# PRD-665 — Clouds shade the haze and fog below them, so light shafts show through the gaps

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: a fresh Unreal project and the reference level both leave cloud shadows and cloud sky AO off, so the gate decides if the atmosphere and fog take them.
**Complexity:** 5 (MEDIUM) — 4–6 files: atmosphere sampling, the sky AO capture, the rain template, specs (+1), new GPU resource: a second light-space map (+2), native proof (+1), template adoption (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-VQ-08](PRD-VQ-08-clouds-and-overhead-transmittance.md) Phase 1 (the three-channel cloud shadow map and its capture) and Phase 2 box 1 (direct sun on surfaces). [PRD-562](PRD-562-aerial-perspective-from-a-froxel-volume.md) Phase 1 (the aerial-perspective volume that the cloud shadow dims). PRD-633 (`docs/PRDs/Unreal/look/PRD-633-the-sky-is-an-atmosphere-and-it-lights-the-scene.md`, on `feat/unreal-look-epic`) for the atmosphere sky in the templates.

## Context

**Unreal LOC:** about 450 lines touch the cloud shadow map and the cloud sky AO (`rg -c -i
"cloudshadow|skyao"` over `VolumetricCloudRendering.cpp`, `VolumetricCloud.usf`,
`VolumetricCloudCommon.ush`, `SkyAtmosphere.usf`, `VolumetricFog.usf` and
`DeferredLightPixelShaders.usf`), inside the 6,144-line volumetric clouds row of the feature map.
**Port estimate:** about 300 to 450 ThreeNative lines, because PRD-VQ-08 builds the map and its
capture.

**Split with PRD-VQ-08.** PRD-VQ-08 owns the cloud shadow map, its encoding, snap and history, and
the sun's attenuation on surfaces. This PRD owns three consumers that PRD-VQ-08 does not box: the
cloud shadow on the atmosphere, the cloud shadow on fog, and the cloud sky AO map.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Off in a fresh project.** A directional light casts no cloud shadow by default. Its strengths on
  the surface and on the atmosphere default to 1
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/Components/DirectionalLightComponent.cpp:1073-1080`).
  The sky light's cloud AO is off by default, with an extent of 150 km, a strength of 1 and an
  aperture scale of 0.05 (`Engine/Source/Runtime/Engine/Private/Components/SkyLightComponent.cpp:332-336`).
  The map renders only when the light opts in
  (`Engine/Source/Runtime/Renderer/Private/VolumetricCloudRendering.cpp:343-346`), and the sky AO map
  only when the sky light opts in (`VolumetricCloudRendering.cpp:470-473`). The reference level keeps
  both lights at `cast_cloud_shadows: false` (`tools/unreal-reference/template-actors.json`, on
  `feat/unreal-look-epic`).
- **One sampler for every receiver.** A receiver reconstructs its optical depth from the three
  channels (front depth, mean extinction, maximum optical depth) and takes `exp(-depth)`
  (`Engine/Shaders/Private/VolumetricCloudCommon.ush:54-67`). PRD-VQ-08 describes the encoding.
- **On the atmosphere.** The sky and aerial-perspective ray march multiply the sun's shadow term at
  each sample by the cloud shadow, lerped by the atmosphere strength
  (`Engine/Shaders/Private/SkyAtmosphere.usf:739-742`). That is what draws light shafts in the haze
  through cloud gaps.
- **On fog.** The volumetric fog light injection multiplies the sun's shadow by the cloud shadow,
  lerped by the surface strength (`Engine/Shaders/Private/VolumetricFog.usf:973`;
  `Engine/Source/Runtime/Renderer/Private/VolumetricFog.cpp:1905`).
- **Cloud sky AO reaches the air, not the surfaces.** A second map of the same encoding traces
  10 samples toward the sky (`VolumetricCloudRendering.cpp:139-164`: on, 20 km snap, 2048² maximum,
  filtering on). The atmosphere ray march multiplies its multi-scattered light by it
  (`SkyAtmosphere.usf:734-737`). The surface sky-light path is compiled out, because specular was not
  dimmed with it (`Engine/Shaders/Private/ReflectionEnvironmentPixelShader.usf:296-308`).

### ThreeNative today

- **Atmosphere:** `packages/core/src/atmosphere/index.ts` builds the transmittance, multi-scattering
  and sky-view LUTs. Its `aerialPerspective` method (`index.ts:233`) takes no shadow input. PRD-562
  replaces its body with a froxel volume.
- **Clouds:** the `rain` template draws a cloud slab at 145 to 815 m
  (`packages/create-threenative/templates/rain/src/render/clouds-shader.ts`) with no shadow map
  (`rain/src/render/lighting.ts`). The reference harness draws Unreal's default cloud layer in
  `scripts/unreal-look/scaffold/render/clouds.ts` and `gpuSky.ts` (on `feat/unreal-look-epic`) with
  no map either.
- **Fog:** height fog (`packages/create-threenative/templates/starter/src/render/heightFog.ts`) and
  the starter's volumetric fog (`starter/src/render/volumetricFog*.ts`) take no cloud term.

## Solution

**The gate first (Phase 1).** Capture Unreal's reference cloud poses (layer L4) twice: as shipped,
and with `cast_cloud_shadows` and cloud AO on. Measure the per-region change in the sky, the haze
band and the ground, and give both sets to a fresh visual judge. **Continue only if** the haze or
sky regions change by more than the PRD-631 L4 threshold, or the judge names visible shafts that
the off frame lacks. Otherwise record the result under `## Decisions` and delete Phases 2 and 3 (R4).

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Cloud shadow map and capture | PRD-VQ-08 | template source plus shared capture, owned there |
| Shadow sampler (three channels to transmittance) | `packages/core/src/atmosphere/cloud-shadow.ts` (new), one TSL function used by every consumer | core mechanism |
| Cloud shadow on sky and aerial perspective | `Atmosphere` takes an optional `cloudShadow` input; the PRD-562 volume and the sky march multiply the sun term by it | core mechanism |
| Cloud shadow on fog | the template's `src/render/heightFog.ts` and fog files call the sampler for their sun term | generated template source |
| Cloud sky AO map | a second capture from the PRD-VQ-08 machinery, 10 samples over a cone toward the sky; `Atmosphere` multiplies its multi-scattered light by it | core mechanism |
| `castCloudShadows`, `cloudShadowOnAtmosphereStrength`, `cloudAmbientOcclusion` and strengths | the template's `src/render/lighting.ts` and `sky.ts` | generated template source |

- **Names** follow Unreal in camelCase, with `@alias cloud shadow` and `@alias cloud sky ao`.
- **Defaults match Unreal:** off unless the template opts in. The rain template is the first consumer
  because it already owns the PRD-VQ-08 map. The opt-in decides the look, so it lives in
  `src/render/`.
- **Left out on purpose:** cloud AO on surfaces (Unreal compiles it out) and cloud shadows from a
  second sun.

**Revisit condition if the gate defers the build:** a template or game turns cloud shadows on, or the
owner's default look adds them to the reference level.

## Acceptance Criteria

- [ ] AC-1 [local]: With cloud shadows on, the rain template frame shows shafts in the haze under cloud gaps, and a fresh visual judge returns IMPROVEMENT against the same pose with them off. proof: headed `--browser-recipe webgpu` captures, 2 runs per arm, judged by a fresh read-only subagent — Evidence: pending.
- [ ] AC-2 [local]: The atmosphere and fog sampling plus the sky AO capture cost at most 0.3 ms GPU at 1920 × 1080 on the RTX 2080. proof: `node packages/playtest/dist/runner/cli.js perf`, on against off — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Cloud shadow on atmosphere and fog | rain `src/render/sky.ts` passes the PRD-VQ-08 map to `Atmosphere` and to its fog | New; off means the current frame, unchanged | AC-1 |
| Cloud sky AO | rain `src/render/lighting.ts` opts in | New | AC-1 |

## Execution Phases

#### Phase 1: Does Unreal's frame change?
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/` (a variant of the reference level, measurement only)
- [ ] The per-region L4 change between cloud shadows off and on in Unreal, and the judge verdict on both sets, are recorded under `## Decisions` with the gate verdict. proof: `pnpm unreal-look:capture --engine unreal --layer L4` for both variants, then `pnpm unreal-look:compare --layer L4`.

#### Phase 2: The sampler in the atmosphere
**Status:** NOT STARTED
**Files:** `packages/core/src/atmosphere/cloud-shadow.ts` (new), `packages/core/src/atmosphere/index.ts`, `packages/core/__tests__/atmosphere.spec.ts`, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] A receiver below the slab, one inside it and one above it get the transmittance of their own optical depth, and zero coverage gives 1. proof: `pnpm exec vitest run packages/core/__tests__/atmosphere.spec.ts`.
- [ ] With no `cloudShadow` input, the aerial-perspective volume is bit-equal to the build without this change. proof: `pnpm exec vitest run packages/core/__tests__/atmosphere.spec.ts`.
- [ ] A capability search for "cloud shadow" returns the atmosphere input. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: Rain adopts it
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/rain/src/render/sky.ts`, `packages/create-threenative/templates/rain/src/render/lighting.ts`, `packages/runtime-native/conformance/scenes/shared/cloud-shadow-atmosphere.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The rain template renders cloud shadows on its haze and fog, and the template gate passes. proof: `pnpm test:templates` (rain).
- [ ] The conformance row `cloud-shadow-atmosphere` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests cloud-shadow-atmosphere`.
- [ ] The AC-1 judge verdict is recorded. proof: the AC-1 judge report.
**Verification:** AC-1 and AC-2.
