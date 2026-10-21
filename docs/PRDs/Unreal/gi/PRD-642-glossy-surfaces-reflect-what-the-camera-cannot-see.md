---
prd_contract: v1
---

# PRD-642 — Glossy surfaces reflect what the camera cannot see

**Status:** PARTIAL (Phase 1 measured; Phase 2 in progress)
**Priority:** P2 — no box is ticked: a reflection ray that leaves the screen falls back to the sky environment, so a chrome sphere in a room reflects the sky and not the room behind the camera.
**Complexity:** 7 (HIGH) — 6–10 files: the reflection trace, rough specular, the denoise, specs, conformance (+2), new module `traced-reflections.ts` (+2), history state (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 (the radiance cache that rough reflections read and the BVH trace). [PRD-639](PRD-639-a-surface-cache-gives-traced-rays-the-texture-glow-and-lights-of-what-they-hit.md) Phase 2 (what a reflection ray sees at its hit). [PRD-641](PRD-641-bounce-light-holds-still-while-the-camera-moves-and-follows-a-light-that-changes.md) Phase 2 (the history code it reuses). [PRD-638](PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 1, [PRD-646](PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) Phase 2 and [PRD-647](PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md): this PRD adds the `chrome` pose to the `neon-corridor` calibration scene. [PRD-VQ-03](../../rendering/PRD-VQ-03-local-reflection-probes.md) owns the reflection captures that the tiers without traced reflections use.

## Context

- `ssr` runs on the owned engine (`packages/three-native/src/addons/screen-space.ts`, commits
  `8aaed8753`, `f3edbce9c`). It marches 48 slices with bisection, spreads by roughness, stops at
  Unreal's 0.4 roughness and returns a delta, so a miss keeps the environment. Beyond its 30 m
  `maxDistance` a band shows under the horizon (sibling report).
- The environment is the sky (PRD-633). The harness paints the lit floor into the lower half of the
  environment so chrome reflects the floor (`giCache.ts`). That is a harness trick, not a reflection
  of the scene.
- No reflection ray reads the BVH, the radiance cache or a surface cache. A room behind the camera
  never shows in a mirror.
- Surfaces rougher than 0.4 take the environment's prefiltered specular. They never take the
  room's bounce light, so a satin floor indoors reflects the bright sky.

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

- **Lumen reflections are the fresh-project default** (`r.ReflectionMethod=1`, UE 5.8.3:
  `Engine/Source/Editor/GameProjectGeneration/Private/GameProjectUtils.cpp`). They are on from
  Reflection quality High (level 2) and off at Low and Medium (`r.Lumen.Reflections.Allow`, UE 5.8.3:
  `Engine/Config/BaseScalability.ini`, `[ReflectionQuality@N]`). Below High, reflection captures and the
  sky answer.
- **Dedicated rays only for smooth surfaces.** Pixels with roughness up to 0.4 trace their own ray,
  with a fade length of 0.1 (`LumenMaxRoughnessToTraceReflections`, `r.Lumen.Reflections.RoughnessFadeLength`;
  UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenReflections.cpp`). Foliage traces
  only up to 0.2 below Epic.
- **Rougher surfaces reuse the diffuse gather.** Up to roughness 0.8 they read the gather's rough
  specular. Above 0.8, specular takes the diffuse GI (`MaxRoughnessToEvaluateRoughSpecular`, same
  value on the irradiance field path; UE 5.8.3: `LumenIrradianceFieldGather.cpp`).
- **Same trace, same hit lighting.** A reflection ray walks the screen, then the mesh and global
  distance fields, and its hit is shaded from the surface cache (UE 5.8.3:
  `Engine/Source/Runtime/Renderer/Private/Lumen/LumenReflectionTracing.cpp`).
- **Its own denoiser.** Spatial reconstruction (5 samples at Epic), temporal accumulation (at most 12
  frames), then a bilateral filter. Full resolution at Epic, half at High
  (UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenReflectionDenoiserTemporal.usf`, `LumenReflectionDenoiserSpatial.usf`).

## Solution

1. **Measure (Phase 1).** On the owned engine at L8, compare the chrome and smooth-dielectric spheres
   of the PRD-631 scene and the `chrome` pose that this PRD adds to the `neon-corridor` calibration scene, against Unreal Epic.
   Classify each wrong region by cause: the reflected object is off screen, behind the camera,
   beyond `maxDistance`, or the surface is rougher than 0.4. Only the measured causes are built.
2. **`TracedReflections` (Phase 2).** For pixels with roughness up to `maxRoughnessToTrace` (0.4,
   fade 0.1), a reflection ray walks the scene's packed triangles (D2). The hit reads the
   Surface Cache colour (PRD-639) lit by the sun with one shadow ray, plus the radiance cache at
   the hit for its bounce. A miss reads the sky environment. The `ssr` stage stays the screen part
   and keeps its name.
3. **Rough specular and the denoiser (Phase 3).** Pixels between 0.4 and
   `maxRoughnessToEvaluateRoughSpecular` (0.8) read specular from the radiance cache in the
   reflected direction, widened by roughness, instead of the sky. Above 0.8 they take the diffuse
   GI, as Unreal does. Traced reflections get a spatial pass and a temporal history of at most 12
   frames, using the PRD-641 history code with its own limits.

**Names and manifest.** `TracedReflections`: Unreal calls this "Lumen Reflections" and the brand
stays out of the API. The options keep Unreal's names in camelCase: `maxRoughnessToTrace`,
`roughnessFadeLength`, `maxRoughnessToEvaluateRoughSpecular`. The manifest entry carries
`@alias lumen reflections` and `@alias dedicated reflection rays`.

**Where each part lives.** The trace, the rough-specular read and the denoiser are mechanism in
`packages/core/src/render/`. The roughness limits are look values in the template's `src/render/`.
`TN_REFLECTIONS` reports the traced share, the BVH-hit share and the rough-specular share.

## Acceptance Criteria

- [ ] AC-1 [local]: The L8 cells on the owned engine match Unreal Epic within the PRD-631 thresholds on the chrome and smooth-dielectric sphere regions. proof: `pnpm unreal-look:compare --layer L8` — Evidence: pending.
- [ ] AC-2 [local]: In the `cornell` pose, the chrome sphere reflects the red and green walls behind the camera within the thresholds of Unreal Epic. proof: `pnpm unreal-look:compare --scene gi --layer L8` — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The conformance row `traced-reflections` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests traced-reflections` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| BVH continuation of reflection rays | `worldEnvironment.ts` on `high` | `ssr` stays the screen part; the sky stays the final miss | AC-1, AC-2 |
| Rough specular from the radiance cache | The same stage for roughness 0.4–0.8 | Replaces the sky's prefiltered specular indoors | Phase 3 |
| Harness floor paint | `giCache.ts` lower-hemisphere paint | Deleted once AC-1 holds without it | Phase 2 |

## Execution Phases

#### Phase 1: Which reflections are wrong, and why
**Status:** PARTIAL
**Files:** `tools/unreal-reference/gi/neon-corridor/{scene.py,criteria.md}` (the `chrome` pose; the scene comes from PRD-639 or is created here)
- [ ] The `chrome` pose is ready to calibrate: authored and captured in Unreal, recreated with direct light matching (PRD-646), and its PRD-647 criteria written. proof: `pnpm unreal-look:capture --engine unreal --scene gi:neon-corridor --check-cvars` and `pnpm unreal-look:compare --scene gi:neon-corridor --layer L1`.
- [x] Each wrong L8 region of the PRD-631 spheres scene is listed with its cause under `## Decisions` (D1). proof: `pnpm unreal-look:compare --layer L8` on `reflect-before` (exit 1, 7/84 rows pass), and `?off=ssr`, `?off=reflcap`, `?off=gi` ablations of the same cells. Evidence: D1.
- [ ] Each wrong L8 region of the `chrome` pose is listed with its cause under `## Decisions`. proof: `pnpm unreal-look:compare --scene gi:neon-corridor --layer L8`. Open: the scene is not on the epic yet and GI scenes have no L8 variant (D4).

#### Phase 2: Reflection rays leave the screen
**Status:** NOT STARTED
**Files:** `packages/core/src/render/traced-reflections.ts` (new), `packages/core/src/index.ts`, `packages/core/__tests__/traced-reflections.spec.ts` (new), `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `scripts/unreal-look/scaffold/render/giCache.ts`, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] An `ssr` miss on a surface at roughness 0.4 or less continues through the BVH, and a rougher surface casts no BVH ray. proof: `pnpm exec vitest run packages/core/__tests__/traced-reflections.spec.ts`.
- [ ] The harness floor paint is gone and AC-1 still holds. proof: `pnpm unreal-look:compare --layer L8`.
- [ ] A capability search for "lumen reflections" returns `TracedReflections`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.
**Verification:** a PRD-647 round on the PRD-631 sphere cells and the `chrome` pose at `high`, Unreal Epic as the target, must return IMPROVEMENT against BEFORE.

#### Phase 3: Rough specular and the denoiser
**Status:** NOT STARTED
**Files:** `packages/core/src/render/traced-reflections.ts`, `packages/core/__tests__/traced-reflections.spec.ts`, `packages/runtime-native/conformance/scenes/shared/traced-reflections.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A surface at roughness 0.6 indoors reads the radiance cache, not the sky, and a surface above 0.8 takes the diffuse GI. proof: `pnpm exec vitest run packages/core/__tests__/traced-reflections.spec.ts`.
**Verification:** AC-3, and the PRD-641 flicker metric on the `pan` run for the chrome sphere region.

## Decisions

### D1 — What is wrong at L8, and why (2026-10-21, reflect-lane)

BEFORE is epic head `7688a516e`, owned engine, NVIDIA adapter, `pnpm unreal-look:capture --layers ID,L5,L8`.
Numbers come from `pnpm unreal-look:compare --layer L8` (median Lab deltaE, relative p50 difference; the
threshold is deltaE 1 and dP50 0.01). Causes come from ablations of the same cells with `?off=ssr`, `?off=reflcap`
and `?off=gi`. The `base` ablation reproduced BEFORE to the digit (chrome 1.78 and 4.55), so the ablations are exact.

| Region | Cell | deltaE | dP50 | What the eye sees against Unreal | Cause |
|---|---|---:|---:|---|---|
| Sphere_Chrome | sun60 | 1.78 | 0.000 | Reflected neighbours flat white and blocky. Hard sun halo with one black texel. Small hard clouds. | 1, 2, 3 |
| Sphere_Chrome | sun15 | 4.55 | 0.126 | Stair-stepped edge across the floor half. Radial streaks. Flat neighbours. Reflected floor too bright. | 1, 2, 4 |
| Sphere_Chrome | sun04 | 3.40 | 0.196 | Same as sun15. | 1, 2, 4 |
| Sphere_SmoothDielectric | sun60, sun15, sun04 | 0.79, 2.59, 8.26 | 0.013, 0.031, 0.153 | Brighter than Unreal. | 5 |

1. **The `ssr` stage breaks the chrome sphere.** With `?off=ssr` the stair-stepped edge, the radial streaks and the
   flat white neighbours are gone, and the neighbours show Unreal's grey shading (chrome sun15: deltaE 4.55 to 3.88).
   A screen trace holds only the side of an object that the camera sees. A ray that leaves the chrome sphere for the
   far side of a neighbour finds the camera-facing pixel near its silhouette, which is lit white. Where the hit ends,
   the static cube capture shows the true floor, and the two disagree: that seam is the stair-stepped edge.
   This is the case this PRD names: the reflected side is off screen. Layer: engine `ssr`
   (`packages/three-native/src/addons/screen-space.ts`) and the harness stage that adds it
   (`worldEnvironment.ts`, stage `ssr`). The trace fixes it for every game, so the fix is engine mechanism.
2. **The sun halo has one black texel, and its clouds are too sharp.** Both survive `?off=ssr,reflcap`, so they
   are in the 64 x 32 environment canvas (`gpuSky.ts`, `createGpuSky`) and not in the reflection stages. The
   cube capture draws the live sky at 256 px per face: its clouds are smaller and harder than Unreal's soft
   reflected clouds. The environment alone has the right softness. Layer: sky. Owner: sky-lane, told on 2026-10-21.
   This lane keeps the environment as the miss colour and does not change how it is built.
3. **The cube capture covers one sphere.** `TN_REFLECTION_CAPTURE` reports `objects: 1` (`metalness >= 0.9` and
   `roughness <= 0.3`). A glossy floor, a wet wall or a second mirror has no capture, only the sky and the paint.
4. **The lower half of every mirror is a painted flat colour.** `?off=ssr,reflcap` shows a flat tan floor (chrome
   sun15 p50 116 against Unreal 87). `?off=ssr,reflcap,gi` shows black below the horizon: the sky has no ground
   (`paintGround` in `giCache.ts` is the only floor). Layer: harness trick, deleted in Phase 2.
5. **The smooth dielectric sphere is not a reflection-ray fault.** `ssr` changes its deltaE by 0.00 (the Fresnel term
   is 0.04) and `?off=gi` changes it by at most 0.3. The error is the sphere's own brightness (sun04 p50 196 against
   Unreal 170). Cause open: it belongs to the diffuse and specular lighting of L7 and L8, not to this PRD's ray.
   AC-1 can pass for this region only if that lighting is fixed by its owner.

Other L8 regions fail too (floor, sky, room, backlit wall: worst deltaE 14.6). They are not reflection regions and
belong to the GI, sky and shadow PRDs.

### D2 — The trace uses its own packed BVH, not `GPUSceneBVH` (2026-10-21)

The owned engine refuses `bvhIntersectFirstHit` (`packages/three-native/src/addons/mesh-bvh-webgpu.ts`,
`unsupportedExport`), and its `wgslFn` takes only scalar, vector and matrix parameters: no storage pointer and no
include. `GPUSceneBVH`'s trace cannot run there. `TracedReflections` packs the world-space triangles into three
RGBA32F textures on the CPU (`packages/core/src/render/scene-trace.ts`) and walks them with a stackless
skip-pointer loop in the engine's TSL subset (`Fn`, `If`, `Loop`, `textureLoad`). One kernel then serves the
browser, the Wasm engine and the desktop player. The CPU walk (`traceScene`) is the reference the spec holds the
pack to: it matches three's `Raycaster` on 400 random rays.

### D3 — Dependencies not done (2026-10-21)

PRD-603, PRD-639 and PRD-641 are not done. This PRD does not wait for them. A hit is lit by the sun with one shadow
ray through the same pack, plus the harness radiance cache (`giCache.irradiance`) for the bounce, plus the
material's emissive colour. The PRD-639 Surface Cache replaces that hit lighting when it lands. The PRD-641 history
code replaces the reflection history in Phase 3 when it lands.

### D4 — The `chrome` pose and AC-2 (2026-10-21)

The `cornell` scene (`tools/unreal-reference/gi/cornell/scene.py`) has no chrome sphere, and the GI scenes support
only the layers ID, L1, L7 and L9, so `--scene gi --layer L8` cannot run today. The `neon-corridor` scene exists
only on `lane/surface` (commit `84f1682c5`) and has no glossy object. The sunlit-room and `cornell` surfaces all
have roughness 1.0, so they have no glossy region to list. AC-2 needs a chrome sphere in `cornell`, an L8
variant of the GI scenes, and an Unreal capture of both. They come after Phase 2 proves on the spheres scene.
