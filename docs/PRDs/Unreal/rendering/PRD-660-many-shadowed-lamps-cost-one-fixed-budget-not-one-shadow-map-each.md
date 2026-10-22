---
prd_contract: v1
---

# PRD-660 — Many shadowed lamps cost one fixed budget, not one shadow map each

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: MegaLights is off in a fresh Unreal project, and no template ships a shadowed lamp, so the gate measurement decides if any build follows.
**Complexity:** 8 (HIGH) — 6–10 files: sampler, shadow rays, denoiser, specs, conformance (+2), new module `stochastic-lighting.ts` (+2), state across frames: light-visibility history and a lighting history (+2), native proof (+1), a new frame-cost path for local lights (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-VQ-06](../../rendering/PRD-VQ-06-many-local-lights.md) Phase 1 (the clustered light list that gives each pixel its candidate lights). PRD-650 (`docs/PRDs/Unreal/shadows/PRD-650-a-lamp-shadow-is-as-sharp-as-the-pixels-it-covers-and-softens-with-the-lamp-size.md`, on `feat/unreal-look-epic`) gives the per-lamp shadow baseline and the `lamp-room` scene. Builds on the shipped `GPUSceneBVH` (`packages/core/src/gpu-scene-bvh.ts`) and `DepthPyramid` (`packages/core/src/render/depth-pyramid.ts`).

## Context

**Unreal LOC:** 19,993 (10,136 C++, 9,857 shader), from the feature map. **Port estimate:** about
1,800 to 2,400 ThreeNative lines: about 1,500 of TSL mechanism and specs in `packages/core/`, about
150 of template wiring, and a conformance case. The native engine runs the same TSL through its
shader IR, so no new C++ renderer path is planned.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Off by default, and it needs hardware ray tracing.** `r.MegaLights.EnableForProject` is 0. Its
  help text says the feature samples many shadowed lights at a fixed cost, needs hardware ray tracing
  and skips directional lights. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/MegaLights/MegaLights.cpp:26-31`.
  Directional lights stay out unless `r.MegaLights.DirectionalLights` is set (`MegaLights.cpp:238-243`).
  The software ray-tracing fallback is off (`r.MegaLights.SoftwareRayTracing.Allow` 0,
  `Engine/Source/Runtime/Renderer/Private/MegaLights/MegaLightsRayTracing.cpp:149-151`).
- **A fixed sample count per pixel, not a shadow map per light.** Sampling runs at half resolution
  (`r.MegaLights.DownsampleMode` 2, `MegaLights.cpp:50-58`) with 4 samples per downsampled pixel
  (`r.MegaLights.NumSamplesPerPixel` 4, `MegaLights.cpp:60-66`). Shadow quality Low and Medium use 2
  samples, High and Epic use 4, all at half resolution
  (`Engine/Config/BaseScalability.ini:156-157, 191-192, 229-230, 267-268`).
- **Candidates come from the light grid.** Each pixel walks the lights of its clustered grid cell
  (`Engine/Shaders/Private/MegaLights/MegaLightsSampling.usf:317-319`). Each candidate gets a weight
  from its unshadowed contribution estimate, and the sampler picks lights in proportion to that weight
  (`MegaLightsSampling.usf:164-210`). An early cull drops lights below an energy floor that assumes a
  base-colour luminance of 0.18 (`MegaLights.cpp:76-84`).
- **History guides the choice.** A light that was hidden at this pixel last frame keeps 0.1 of its
  weight, or 0.4 where the pixel has no valid history
  (`Engine/Source/Runtime/Renderer/Private/MegaLights/MegaLightsSampling.cpp:22-31`; on by default,
  `MegaLights.cpp:86-91`).
- **One shadow ray per sample.** The ray first walks the HZB on screen (on by default, 50 steps,
  `MegaLightsRayTracing.cpp:59-61, 75-77`). A ray that leaves the screen continues in the hardware
  ray-tracing scene (`MegaLightsRayTracing.cpp:156-158`). The default shadow method is ray tracing,
  and virtual shadow maps are a per-light opt-in (`MegaLights.cpp:372-379`).
- **A denoiser makes the few samples smooth.** A temporal pass accumulates up to 12 frames
  (`Engine/Source/Runtime/Renderer/Private/MegaLights/MegaLightsDenoising.cpp:39-41`). A spatial pass
  takes 4 samples in an 8-pixel radius (`MegaLightsDenoising.cpp:67-76`).

### ThreeNative today

- **Native engine (the default engine):** a shadowed spot light draws one depth map and a shadowed
  point light draws a six-face cube, every frame
  (`packages/runtime-native/src/engine/renderer/renderer.cpp:2344-2362, 2750`). The receiver reads the
  cube in `pointShadowFactor` (`packages/runtime-native/src/engine/shader/standard.cpp:778`). The
  shadow cost therefore grows with the number of shadowed lamps.
- **three.js override:** the same per-light maps, through `PointLightShadow` and `SpotLightShadow`.
- **Light lists:** three r185 ships `ClusteredLightsNode` (`three/examples/jsm/tsl/lighting/`).
  PRD-VQ-06 owns its admission for unshadowed lights.
- **Traces:** `GPUSceneBVH` gives a first-hit ray query in TSL (`packages/core/src/gpu-scene-bvh.ts`).
- **Consumers:** no template lamp casts a shadow
  (`rg "new (PointLight|SpotLight)" packages/create-threenative/templates`, 2026-10-21). PRD-650
  owns the per-lamp atlas, cache and soft filter.

## Solution

**The gate first (Phase 1).** Build a `lamp-street` fixture with 8, 32 and 128 shadowed point lamps
over static props and one moving caster. Measure the per-light path on the native engine and on the
browser. Capture the same scene in Unreal with MegaLights on (hardware ray tracing on the RTX 2080)
and read its GPU time from `ProfileGPU`. **Continue only if** the per-light path costs more than
Unreal's MegaLights at 32 lamps or more, at 1920 × 1080. Otherwise record the result under
`## Decisions`, delete Phases 2 and 3 (R4), and keep the revisit condition below.

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Light grid candidates | `ClusteredLightsNode` cluster lists (PRD-VQ-06) | three.js, admitted by PRD-VQ-06 |
| Sample generation with target PDF and history guide | `packages/core/src/render/stochastic-lighting.ts` (new) | core mechanism |
| Screen trace, then world trace | `DepthPyramid` march, then `GPUSceneBVH` first hit | core mechanism |
| Shading resolve | the same module, writing a lighting target that the scene pass adds | core mechanism |
| Temporal and spatial denoiser | the same module, reusing the velocity target (`packages/core/src/render/velocity.ts`) | core mechanism |
| Sample count, lamp opt-in, light colour and intensity | the template's `src/render/lighting.ts` and `quality.ts` | generated template source |

- **Name.** `StochasticLighting`, after Unreal's own shader folder
  (`Engine/Shaders/Private/StochasticLighting/`). The manifest entry carries `@alias megalights` and
  `@alias many shadowed lights`. Options use Unreal names in camelCase: `numSamplesPerPixel`,
  `downsampleMode`, `guideByHistory`.
- **Opt-in per light, auto by default.** A light joins when it casts a shadow and the scene holds more
  shadowed lamps than the per-light path can afford in the tier budget. The engine measures that
  count. `light.userData.stochasticShadow = false` is the named override, and `TN_LIGHTING` reports
  each light's path and why.
- **Look stays the game's.** The module decides no colour, intensity, radius or falloff. It takes the
  lights as the game authored them.
- **Left out on purpose:** directional lights (off in Unreal), volumetric fog and translucency volumes
  (Unreal `r.MegaLights.Volume`; deferred until a template with many lamps also ships froxel fog), and
  hair. Each needs a consumer before it is filed.

**Revisit condition if the gate defers the build:** a game or template ships 16 or more shadowed
local lights, or the PRD-650 lamp atlas exceeds its tier budget on a measured scene.

## Acceptance Criteria

- [ ] AC-1 [local]: At 128 shadowed lamps on `lamp-street`, `StochasticLighting` costs no more GPU time at 1920 × 1080 on the RTX 2080 than Unreal's measured MegaLights, and less than the per-light path. proof: `node packages/playtest/dist/runner/cli.js perf` on the fixture, path on against off, beside the Phase 1 Unreal number — Evidence: pending.
- [ ] AC-2 [local]: A fresh visual judge returns NEUTRAL or IMPROVEMENT for the stochastic frames against the per-light reference frames, at the same pose, still and after a 30-frame camera pan. proof: headed `--browser-recipe webgpu` captures, 2 runs per arm, judged by a fresh read-only subagent — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `StochasticLighting` | `lamp-street` fixture `src/render/lighting.ts` builds it when the shadowed-lamp count passes the measured threshold | Replaces per-light cube maps for the lights that join; the per-light path stays for the rest | Phase 3, AC-1 |
| Capability search | `engine_search_capabilities "megalights"` | New entry | Phase 2 |

## Execution Phases

#### Phase 1: Does the per-light path run out?
**Status:** NOT STARTED
**Files:** `examples/lamp-street/` (new fixture), `examples/lamp-street/playtests/lamp-street.playtest.json` (new)
- [ ] The per-light shadow cost at 8, 32 and 128 lamps is recorded under `## Decisions` for the native desktop host and the browser WebGPU lane. proof: `node packages/playtest/dist/runner/cli.js perf` with the frame budget's `gpuMs`, once per lamp count and lane.
- [ ] Unreal's MegaLights GPU time on the same scene at 1920 × 1080 is recorded, with the gate verdict. proof: `pnpm unreal-look:capture --engine unreal` with `ProfileGPU` in `Saved/Logs`.

#### Phase 2: The sampler and the shadow rays
**Status:** NOT STARTED
**Files:** `packages/core/src/render/stochastic-lighting.ts` (new), `packages/core/src/index.ts`, `packages/core/__tests__/stochastic-lighting.spec.ts` (new), `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] Over 10,000 draws, each candidate light is picked in proportion to its weight within 2%, and a light hidden last frame keeps 0.1 of its weight. proof: `pnpm exec vitest run packages/core/__tests__/stochastic-lighting.spec.ts`.
- [ ] A shadow ray that hits on screen never queries the BVH, and a ray that leaves the screen returns the `GPUSceneBVH` first hit. proof: `pnpm exec vitest run packages/core/__tests__/stochastic-lighting.spec.ts`.
- [ ] A capability search for "megalights" returns `StochasticLighting`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: Denoise, judge and native
**Status:** NOT STARTED
**Files:** `packages/core/src/render/stochastic-lighting.ts`, `examples/lamp-street/src/render/lighting.ts`, `packages/runtime-native/conformance/scenes/shared/stochastic-lighting.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The `lamp-street` scenario passes with the stochastic path on, and its report names each lamp's path. proof: `node packages/playtest/dist/runner/cli.js examples/lamp-street/playtests/lamp-street.playtest.json --url <url> --browser-recipe webgpu`.
- [ ] The conformance row `stochastic-lighting` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests stochastic-lighting`.
- [ ] The visual judge verdict of AC-2 is recorded. proof: the AC-2 judge report.
**Verification:** AC-1 and AC-2.
