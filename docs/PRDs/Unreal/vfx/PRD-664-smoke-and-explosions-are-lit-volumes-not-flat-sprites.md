---
prd_contract: v1
---

# PRD-664 — Smoke and explosions are lit volumes, not flat sprites

**Status:** NOT STARTED — deferred behind its Phase 1 gate. Revisit when Phase 1 passes both gates, or when a game or template asks for smoke, fire or clouds that a sprite cannot show.
**Priority:** P3 — AC-1 to AC-3 are open: every smoke and blast in the templates is a camera-facing sprite. A fresh Unreal project places no heterogeneous volume, so the default look does not change.
**Complexity:** 6 (MEDIUM) — 6–10 implementation files (2), a new GPU module (+2), per-frame lighting-cache and half-resolution composite state (+2); risk override: none
**Owner:** João
**Depends on:** None to start Phase 1. Phase 3 shares the native 3D storage-texture proof with [PRD-562](../rendering/PRD-562-aerial-perspective-from-a-froxel-volume.md); whichever lands first proves it for both. The billboard smoke of [PRD-316](PRD-316-forty-six-vfx-are-generated-render-source-not-an-engine-inside-the-engine.md) stays the fallback at every tier where this is off.

## Context

### What Unreal does (UE 5.8.3, read 2026-10-21)

Unreal renders a voxel volume with a material when a level has a `HeterogeneousVolumeComponent` or a
Niagara volume renderer. A fresh project has neither. The path draws only when a view has volume
mesh batches. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/HeterogeneousVolumes/HeterogeneousVolumes.cpp:438-446`.

- **Default pipeline: live shading with a lighting cache.** The ray march evaluates the volume
  material at each step. A pre-pass caches in-scattered light into a 3D texture
  (`r.HeterogeneousVolumes.LightingCache` is 2, "cache in-scattering"). `HeterogeneousVolumes.cpp:270-275`.
  The cache resolution is the volume resolution divided by the lighting downsample factor, clamped
  to 1024×1024×512, with a full mip chain, in an 11-11-10 float format (RGBA16F on Metal).
  `HeterogeneousVolumes.cpp:889-902, 1238-1246`.
- **Component defaults.** The volume resolution is 128³. The step factor is 1, the shadow step
  factor is 2, and the lighting downsample factor is 2, so the cache is 64³. Animated frames play at
  24 frames per second. `UE 5.8.3: Engine/Source/Runtime/Engine/Private/Components/HeterogeneousVolumeComponent.cpp:259-269`.
- **Screen cost controls.** The march jitters its start (`:159-161`), stops at 512 steps
  (`:166-168`), sorts volumes by centroid depth (`:296-298`), and receives height fog (`:303-305`).
  It uses continuous level of detail (`:341-343`). Iterative bilateral smoothing upsamples a
  reduced-resolution result (`:73-96`).
- **Off by default:** casting shadows onto the scene (`:33-35`), indirect lighting (`:131-133`),
  hardware ray tracing (`:124-126`) and the sparse-voxel pipeline (`:235-237`). The sparse volume
  texture is an asset format. It is imported from OpenVDB by editor code
  (`Engine/Source/Editor/SparseVolumeTexture/Private/SparseVolumeTextureOpenVDB.h`) and streamed by page.
- **Scalability.** `EffectsQuality@0` and `@1` (low and medium) do not allow the feature. `@2`
  renders at half resolution with 96 steps and a 256 shadow map. `@3` uses 256 steps and a 512
  shadow map. `UE 5.8.3: Engine/Config/BaseScalability.ini:825, 854, 883-886, 916-919`.

Unreal LOC: 26,952 lines (15,562 C++, 11,390 shader) in the feature map row "Heterogeneous volumes".

### What ThreeNative does today

- The shooter's blast is a glow and a cloud of pooled, camera-facing smoke sprites with a soft-disc
  texture (`packages/create-threenative/templates/shooter/src/scenes/Play.ts:587-634`,
  `src/render/gunfx.ts:21`). The sprite has no thickness, so the sun cannot light one side of it.
- The rain template ray-marches clouds through a 64³ noise `Data3DTexture`
  (`packages/create-threenative/templates/rain/src/render/noise-volume.ts`, `clouds.ts`). That is a
  sky layer, not a placed volume.
- `FluidParticles3D` already writes a density volume from particles (`packages/core/src/fluid-particles.ts:98`).
- Pinned three 0.185.1 `VolumeNodeMaterial` skips directional lights and couples extinction to
  lighting (`packages/create-threenative/templates/starter/src/render/volumetricFog.ts`, header
  note). It cannot be the march as it is.
- `packages/create-threenative/capabilities.json` has no volume-rendering entry
  (`rg -i 'heterogeneous|smoke volume'`, 2026-10-21).

## Solution

**The march, the lighting cache and the composite are mechanism. The density, the colour and the
emission are the game's.**

| Unreal piece | ThreeNative module | Layer |
| --- | --- | --- |
| Live-shading ray march with jitter, a step cap and depth sort | `HeterogeneousVolume` (`@alias HeterogeneousVolumes, smoke volume, explosion volume`) in `packages/core/src/render/heterogeneous-volume.ts` (new). The game attaches it to a box `Mesh`. | core |
| Lighting cache (in-scatter 3D texture at half the volume resolution) | Same file. One compute pass per volume per frame fills an `rgba16float` storage 3D texture with sun in-scatter, from a shadow march toward the sun. WebGPU has no 11-11-10 storage format. | core |
| Reduced-resolution render and bilateral upsample | A render-chain stage before `bloom` in `packages/core/src/render/chain.ts`. It renders at half resolution and upsamples by depth. | core |
| Volume material (density, albedo, emission, phase) | The game passes a TSL density function of local position and time, or a `Data3DTexture`. The template keeps it in `src/render/blastVolume.ts` (new), with the temperature-to-colour ramp of the fire. | template |
| Sparse volume texture, OpenVDB import, streaming | Not ported. See `## Decisions`. | — |
| Scalability gate | Off at `low` and `medium`, as in Unreal. 96 steps at half resolution at `high`. The billboard smoke stays where the volume is off. | template `quality.ts` |

- **First consumer: the shooter blast**, after the Phase 1 gate passes. Its sprites stay as the `low`
  and `medium` path.
- **Port size:** about 1,100 to 1,300 ThreeNative lines with tests, against 26,952 Unreal lines. The
  core module is about 600 lines, and the template volume is about 200 lines. Tests are about 300
  lines, and the native conformance scene is about 80 lines.

Risks:

- Cost. Unreal itself turns the feature off below `EffectsQuality@2`. Phase 1 measures before any
  module is written.
- The owned C++ engine must run a compute pass that writes a 3D storage texture. Phase 3 proves it.

## Acceptance Criteria

- [ ] AC-1 [local]: A fresh visual judge rates the shooter blast as a volume IMPROVEMENT against the current sprite blast. Criteria: the smoke has a lit side toward the sun and a dark side away from it, it does not show sprite edges or camera-facing rotation, and it settles without popping. proof: same pose and blast frame before and after, headed `--browser-recipe webgpu`, two runs per arm, fresh read-only judge subagent — Evidence: pending.
- [ ] AC-2 [local]: One 128³ volume that covers a quarter of a 1080p frame costs at most 1.5 ms GPU at `high` on the RTX 2080 browser WebGPU lane. proof: `TN_FRAME_BUDGET` p50 delta from `node packages/playtest/dist/runner/cli.js perf`, volume against sprites — Evidence: pending.
- [ ] AC-3 [local]: The desktop native host renders the volume to match the browser reference within tolerance. proof: `pnpm parity --target desktop --only-tests heterogeneous-volume` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `HeterogeneousVolume` march and lighting cache | shooter `src/scenes/Play.ts` blast → `src/render/blastVolume.ts` → core volume stage | Replaces the blast smoke sprites at `high`. The sprites stay at `low` and `medium` | Phase 2, AC-1 |

## Execution Phases

#### Phase 1: The gate
**Status:** NOT STARTED
**Files:** `examples/vfx-gallery/src/render/blastVolume.ts` (new prototype), `examples/vfx-gallery/playtests/blast-volume.playtest.json` (new)
- [ ] A prototype march of one procedural 128³ blast at half resolution, 96 steps and a 64³ lighting cache is measured at 1080p on the RTX 2080 browser lane. The result goes under `## Decisions`: continue only if it costs at most 1.5 ms. proof: `node packages/playtest/dist/runner/cli.js perf` (`TN_FRAME_BUDGET` p50 delta, two runs per arm).
- [ ] A fresh visual judge compares the prototype with the shooter's sprite blast at the same pose, against the AC-1 criteria. The verdict goes under `## Decisions`: continue only on IMPROVEMENT. proof: capture pair from `examples/vfx-gallery/playtests/blast-volume.playtest.json --browser-recipe webgpu` and the judge verdict.

#### Phase 2: The mechanism, and the shooter adopts it
**Status:** NOT STARTED
**Files:** `packages/core/src/render/heterogeneous-volume.ts` (new), `packages/core/src/render/chain.ts`, `packages/core/src/index.ts`, `packages/core/__tests__/heterogeneous-volume.spec.ts` (new), `packages/create-threenative/templates/shooter/src/render/blastVolume.ts` (new), `packages/create-threenative/templates/shooter/src/render/quality.ts`, `packages/create-threenative/templates/shooter/src/scenes/Play.ts`, `packages/create-threenative/templates/shooter/AGENTS.md` (and mirror)
- [ ] For a slab of uniform density, the march's transmittance matches `exp(-density × thickness)` within 1%, and the lighting cache is half the volume resolution on each axis. proof: `pnpm exec vitest run packages/core/__tests__/heterogeneous-volume.spec.ts`.
- [ ] The stage allocates and dispatches nothing at `low`, `medium` and `off`, and `TN_VOLUMES` reports the tier, the step cap and the cache size. proof: `pnpm exec vitest run packages/core/__tests__/heterogeneous-volume.spec.ts`.
- [ ] A shooter playtest throws a blast. The labelled blast region is lit on the sun side, the volume is gone at the end of its life, and no frame is blank. proof: `node packages/playtest/dist/runner/cli.js packages/create-threenative/templates/shooter/playtests/blast-volume.playtest.json --browser-recipe webgpu` and `pnpm test:templates` (shooter).
- [ ] AC-1 passes on the visual judge. proof: the AC-1 capture pair and the judge verdict, posted on the PR.

#### Phase 3: Native
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/heterogeneous-volume.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The desktop native host fills the lighting cache and marches a fixed volume to match the browser reference within tolerance. proof: `pnpm parity --target desktop --only-tests heterogeneous-volume`.

## Decisions

- 2026-10-21 (filing): No sparse voxel pipeline, no OpenVDB import and no page streaming. Unreal's sparse pipeline is off by default, and its import is editor code. Revisit when a game ships a VDB asset or a dense 128³ volume no longer fits its memory budget.
- 2026-10-21 (filing): No shadow cast onto the scene and no indirect light from the volume. Both are off by default in Unreal.
- 2026-10-21 (filing): The core class takes the Unreal name, `HeterogeneousVolume`. It is a render resource that the game attaches to its own `Mesh`, not a scene node, so the Godot node rule does not apply.
