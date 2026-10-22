---
prd_contract: v1
---

# PRD-642 — Glossy surfaces reflect what the camera cannot see

**Status:** PARTIAL (Phase 1 measured; Phase 2 in progress)
**Priority:** P2 — the chrome sphere still misses AC-1 at sun15 and sun04 (sky and clouds, sky-lane): a reflection ray that leaves the screen falls back to the sky environment, so a chrome sphere in a room reflects the sky and not the room behind the camera.
**Complexity:** 7 (HIGH) — 6–10 files: the reflection trace, rough specular, the denoise, specs, conformance (+2), new module `traced-reflections.ts` (+2), history state (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 (the radiance cache that rough reflections read and the BVH trace). [PRD-639](PRD-639-a-surface-cache-gives-traced-rays-the-texture-glow-and-lights-of-what-they-hit.md) Phase 2 (what a reflection ray sees at its hit). [PRD-641](PRD-641-bounce-light-holds-still-while-the-camera-moves-and-follows-a-light-that-changes.md) Phase 2 (the history code it reuses). [PRD-638](../../done/PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 1, [PRD-646](PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) Phase 2 and [PRD-647](../../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md): this PRD adds the `chrome` pose to the `neon-corridor` calibration scene. [PRD-VQ-03](../../rendering/PRD-VQ-03-local-reflection-probes.md) owns the reflection captures that the tiers without traced reflections use.

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
   of the PRD-631 scene and the `chrome` pose that this PRD adds in the `mirror-room` calibration scene (D11), against Unreal Epic.
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
- [ ] AC-2 [local]: In the `mirror-room` scene (the `cornell` room with a chrome block), the `chrome` pose reflects the green and white walls behind the camera within the thresholds of Unreal Epic. proof: `pnpm unreal-look:compare --scene gi:mirror-room --layer L8` — Evidence: 2026-10-22, open. `room` pose Mirror passes (deltaE 0.69, dP50 0.000). `chrome` pose Mirror deltaE 5.12, dP50 0.101 (was 15.56 and 0.261): the walls are right in place and shadow and within 4 to 11 percent in level, and 27 to 40 percent too dark low on the wall (D11).
- [x] AC-3 [local; needs a built desktop host]: The conformance row `traced-reflections` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests traced-reflections` — Evidence: 2026-10-22, RTX 2080: web reference pass, desktop host (V8 build of `prd-ocean`, read-only) pass with 0 mismatching pixels and deltaE 0; the two PNGs are byte identical (`md5 c8b6cbb9`). Scene `packages/runtime-native/conformance/scenes/shared/traced-reflections.js`: a mirror sphere with red, green and yellow walls outside the frustum. **Owned-engine result 2026-10-22 (parityaudit-lane):** `pnpm parity --target desktop --engine threenative --only-tests traced-reflections` (V8 engine player, RTX 2080, web reference from the same run): pass, pixel mismatch 0, delta E 0 (tolerance 0.08 / 10), no GPU validation error, owned frame viewed. The proof above ran the legacy `mystral` host.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| BVH continuation of reflection rays | `worldEnvironment.ts` on `high` | `ssr` stays the screen part; the sky stays the final miss | AC-1, AC-2 |
| Rough specular from the radiance cache | The same stage for roughness 0.4–0.8 | Replaces the sky's prefiltered specular indoors | Phase 3 |
| Harness floor paint | `giCache.ts` lower-hemisphere paint | Deleted once AC-1 holds without it | Phase 2 |

## Execution Phases

#### Phase 1: Which reflections are wrong, and why
**Status:** PARTIAL
**Files:** `tools/unreal-reference/gi/mirror-room/{scene.py,criteria.md}` (the `chrome` pose lives in this new scene), `tools/unreal-reference/gi/scenes.json` (the GI `L8` variant), `scripts/unreal-look/gi.ts`
- [ ] The `chrome` pose is ready to calibrate: authored and captured in Unreal, recreated with direct light matching (PRD-646), and its PRD-647 criteria written. proof: `pnpm unreal-look:capture --engine unreal --scene gi:mirror-room --check-cvars` and `pnpm unreal-look:compare --scene gi:mirror-room --layer L1`. Open: authored, captured (L1, L7, L8, L9, ID) and its criteria are written (D11), and L1 holds on 6 of 7 regions (deltaE at most 0.67), but `Box_Tall` is at dP50 0.028 against 0.01, and `--check-cvars` has not run.
- [x] Each wrong L8 region of the PRD-631 spheres scene is listed with its cause under `## Decisions` (D1). proof: `pnpm unreal-look:compare --layer L8` on `reflect-before` (exit 1, 7/84 rows pass), and `?off=ssr`, `?off=reflcap`, `?off=gi` ablations of the same cells. Evidence: D1.
- [x] Each wrong L8 region of the `chrome` pose is listed with its cause under `## Decisions`. proof: `pnpm unreal-look:compare --scene gi:mirror-room --layer L8`. Result 2026-10-22: 7 regions fail at L8 before the fix (Mirror 15.56 and 2.87, Floor 2.05, Back 1.93, Wall_Red 2.33, Wall_Green 7.29, Box_Tall 3.82), each with its cause in D11. The GI scenes now have an `L8` variant (D4 is closed by it).

#### Phase 2: Reflection rays leave the screen
**Status:** PARTIAL
**Files:** `packages/core/src/render/traced-reflections.ts` (new), `packages/core/src/index.ts`, `packages/core/__tests__/traced-reflections.spec.ts` (new), `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `scripts/unreal-look/scaffold/render/giCache.ts`, `packages/engine-mcp/__tests__/search.spec.ts`
- [x] An `ssr` miss on a surface at roughness 0.4 or less continues through the BVH, and a rougher surface casts no BVH ray. proof: `pnpm exec vitest run packages/core/__tests__/traced-reflections.spec.ts`. Result: 9/9 pass (with `search.spec.ts` 67/67); the stage replaces the `ssr` march in `worldEnvironment.ts` and gates on `trace.weight(roughness)`; GPU proof in D6.
- [ ] The harness floor paint is gone and AC-1 still holds. proof: `pnpm unreal-look:compare --layer L8`.
  Paint is off whenever the trace runs (`paint=1` brings it back); AC-1 does not hold yet on Sphere_Chrome at sun15 (dE 3.25 against 1) and sun04 (3.46), see D6.
- [x] A capability search for "lumen reflections" returns `TracedReflections`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`. Result: 67/67 with the traced spec; both aliases rank it first.
**Verification:** a PRD-647 round on the PRD-631 sphere cells and the `chrome` pose at `high`, Unreal Epic as the target, must return IMPROVEMENT against BEFORE.

#### Phase 3: Rough specular and the denoiser
**Status:** PARTIAL (conformance row landed; rough specular and denoiser open)
**Files:** `packages/core/src/render/traced-reflections.ts`, `packages/core/__tests__/traced-reflections.spec.ts`, `packages/runtime-native/conformance/scenes/shared/traced-reflections.js` (new), `packages/runtime-native/conformance/registry.json`
- [x] The conformance row `traced-reflections` runs the kernel on the browser and the desktop host. proof: `pnpm parity --target desktop --only-tests traced-reflections`. Result 2026-10-22: pass, 0 mismatching pixels, deltaE 0 (AC-3, D7). **Owned-engine result 2026-10-22 (parityaudit-lane):** `pnpm parity --target desktop --engine threenative --only-tests traced-reflections` (V8 engine player, RTX 2080, web reference from the same run): pass, pixel mismatch 0, delta E 0 (tolerance 0.08 / 10), no GPU validation error, owned frame viewed. The proof above ran the legacy `mystral` host.
- [ ] A surface at roughness 0.6 indoors reads the radiance cache, not the sky, and a surface above 0.8 takes the diffuse GI. proof: `pnpm exec vitest run packages/core/__tests__/traced-reflections.spec.ts`. Open: the rule landed (`route()`/`routeAt()`, 11/11 vitest, red before green) but the harness wiring (`?roughSpec=1`) regresses every rough region while the radiance cache's shaded side is too bright, so it is off by default (D10).
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
variant of the GI scenes, and an Unreal capture of both. The `mirror-room` scene and the GI `L8` variant now exist (D11).

### D5 — What the kernel does and why (2026-10-21)

The walk keeps a runtime trip count and a runtime loop over a leaf's triangles: a constant bound with an unrolled
leaf lost the NVIDIA device. The cube capture stays while rays are traced (it is the miss colour source).
A barycentric tolerance of 1e-5 closes the hairline cracks between triangles of one edge (spec: two triangles 2e-6 apart).
The default node budget is the tree's node count up to 2048 and not 192: a CPU twin of the kernel on the spheres
pose gives a wrong first hit on 3.02 percent of the pixels at 192, 0.13 at 256 and 0 at 512. The cut rays kept the far wall of
the capsule, which showed as axis-aligned dark blocks on the capsule's band in the lit camera ray and as specks in the
chrome. Cause: engine (`packages/core`). A metal hit takes a diffuse share of 0.12 times its roughness: with none the
rough metal sphere reflects black, with the full colour it reflects a bright disc (Unreal: dark grey, about 34).

### D6 — Result at L8, Sphere_Chrome (2026-10-21, reflect-lane)

BEFORE (`?off=traced`, two runs, identical to the digit) and AFTER (two runs, final code) on the owned engine (Wasm),
NVIDIA adapter, headed. Median Lab deltaE to Unreal, BEFORE then AFTER (runs agree within 0.1):

| Region | sun60 spheres | sun15 spheres | sun04 spheres | sun15 exterior | sun04 exterior |
|---|---:|---:|---:|---:|---:|
| Sphere_Chrome | 1.14 to 0.93 | 4.55 to 3.26 | 3.46 to 3.53 | 7.22 to 3.65 | 4.79 to 3.97 |
| Sphere_RoughMetal | not in pose | not in pose | not in pose | 10.18 to 5.06 | 9.24 to 6.51 |
| Sphere_SmoothDielectric | 1.00 to 1.05 | 2.64 to 2.70 | 8.33 to 8.36 | 2.46 to 2.46 | 7.78 to 7.88 |

The radial streaks, the stair-stepped seam, the flat white neighbours, the painted floor and the bright disc of the
reflected rough metal are gone. Judge tool (`judge.ts`, 6 frames, 2 runs per arm, criteria in the PR comment):
IMPROVEMENT on all six frames and overall, CLOSE to Unreal. Direct-view regions change by at most 0.1 deltaE, the same as
run-to-run noise (Floor sun15 6.03, 6.15, 6.07).
AC-1 is still open: at sun15 and sun04 the chrome median is set by the reflected sky and clouds (sky-lane), and
sun04 chrome dP50 stays 0.18 against a limit of 0.01. SmoothDielectric is the L7/L8 lighting, unchanged by this PRD.
Open: the shadow ray is hard, so a reflected shadow edge is sharper than Unreal's.

### D7 — The metal hit takes Unreal's albedo, but the hit light is too bright (2026-10-22, reflect2-lane)

Task: replace `METAL_DIFFUSE` (0.12 times roughness, chosen by eye) with Unreal's model. Source read: the surface cache stores one diffuse albedo
per surface, with the specular colour folded in as a fully rough surface: `DiffuseColor = Base (1 - Metallic) + 0.45 * lerp(0.08 * Specular, Base, Metallic)`
(UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenCardBasePass.ush:114-117`, `Engine/Shaders/Private/BRDF.ush:648-654`; the Substrate branch of the same file
reaches the same sum). The hit is lit as `(direct + indirect) * albedo / PI` (`Engine/Shaders/Private/Lumen/SurfaceCache/LumenSurfaceCache.ush:50-61`). There is no
specular term and no roughness at the hit, so a metal hit is 0.45 of its base colour whatever its roughness. A hit on screen takes the frame's colour instead
(`r.Lumen.Reflections.SampleSceneColorAtHit`, default 1; depth thickness 0.01, normal threshold 85 degrees; `Engine/Shaders/Private/Lumen/LumenScreenTracing.ush:78-137`).

Result (NVIDIA, headed, L8, `Sphere_Chrome` median deltaE; BEFORE = D6 code, `ms` = metal share, `sr` = screen reuse):

| Cell | BEFORE (0.12 r) | 0.45 | 0.45 + sr | 0.2 + sr | 0.12 + sr |
|---|---:|---:|---:|---:|---:|
| spheres sun60 | 0.93 | 1.76 | 2.01 | 1.37 | 1.32 |
| spheres sun15 | 3.26 | 5.22 | 4.72 | 3.56 | 3.50 |
| spheres sun04 | 3.53 | 5.22 | 3.65 | 3.01 | 2.71 |
| exterior sun15 | 3.66 | 6.63 | 7.12 | 5.68 | 5.93 |

Unreal's model is a regression here, so it is not in the code and the 0.12 constant stays. The cause is the light at the hit, not the albedo. The reflected rough metal
sphere (median grey value, Unreal / ours at 0.45): sun60 176 / 212, sun15 40 / 128, sun04 14 / 99. The share that matches Unreal changes with the sun (about 0.2, 0.09, 0.04),
so no constant fits, and at 0.45 our hit takes about 2 times too much direct light and 5 to 10 times too much shaded-side bounce. The reflected floor in the lower third of the chrome shows the same excess
(sun15: Unreal 55, ours 79, 66 with screen reuse). Our direct view of that floor lacks the contact darkening that Unreal has next to the sphere, so the error sits in
the radiance cache (`giCache.irradiance`), which is the gi lane's code. A second fact for that lane: the cache bakes a metal's bounce albedo as `color * (1 - metalness)`
(`scripts/unreal-look/scaffold/render/giCache.ts:1373`), that is 0 for a metal, where Unreal's surface cache bounces 0.36 for the 0.8 grey metal. Retry both steps together once the
shaded-side bounce matches. Screen reuse on top of 0.45 gave sun04 spheres 5.22 to 3.65 and the floor 59.7 to 44.3 (Unreal 35), but exterior sun15 7.12 against 6.63, so it is not shipped alone either.
The experiment build (knobs `kd`, `ki`, `ms`, `sr` and the screen reuse stage) is kept at `~/.cache/tmp-tn/reflect/reflectionTrace.task1-sr-knobs.ts`.

Also: a TSL `mix(miss, shaded, hit.hit)` carries the undefined hit fields into the pixel on a miss (0 times NaN is NaN), which painted white rings on the mirror in the first
conformance capture. Use `select` on `hit.hit`; the scene does.

### D8 — AC-1 after the sky and BRDF lines merged (2026-10-22, reflect2-lane)

Merged tree: epic `be61f9bc6` (held sky `c571a3727`, `roughDiffuse`, gamut, gather) plus `lane/reflect`; fresh Wasm pair from the preview lane, scaffold repacked,
NVIDIA, headed, two runs (agree within 0.01 deltaE). Median Lab deltaE and dP50 to Unreal at L8 (limit 1 and 0.01), D6 code on the old epic then the merged tree:

| Region | sun60 spheres | sun15 spheres | sun04 spheres |
|---|---|---|---|
| Sphere_Chrome | 0.93 / 0.000 to 1.22 / 0.010 | 3.26 / 0.080 to 2.73 / 0.069 | 3.53 / 0.176 to 3.57 / 0.157 |
| Sphere_SmoothDielectric | 1.05 / 0.022 to 0.97 / 0.017 | 2.70 / 0.036 to 1.59 / 0.027 | 8.36 / 0.153 to 4.88 / 0.100 |

The sky and BRDF lines closed about half of the SmoothDielectric gap and 0.5 of the chrome gap at sun15, and none at sun04. AC-1 stays open for the chrome at sun15 and sun04
(and sun60 by 0.22 deltaE). What remains is the hit light of D7: the reflected floor lower third (Unreal 55, ours 66 to 79 at sun15) and the reflected rough metal
(Unreal 40, ours 49 to 128), which the sky cannot change. Next step, in order: the radiance cache shaded-side bounce (gi lane), then retry D7 with Unreal's metal albedo and the screen reuse.

### D10 — The roughness routing rule landed in the engine; the harness wiring stays opt-in (2026-10-22, reflect3-lane)

Layer: the rule is engine (`packages/core/src/render/traced-reflections.ts`), the wiring is harness (`scripts/unreal-look/scaffold/render/giCache.ts`, URL knob `roughSpec=1`).

Rule (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenReflections.cpp` `MaxRoughnessToTrace` (line 108); `Engine/Shaders/Private/Lumen/LumenReflectionsCombine.ush:39` `RoughReflectionsDiffuseLerp`):
`TracedReflections.route(roughness)` and `routeAt(roughness)` return three shares that sum to 1: `traced` (the existing fade, 0.3 to 0.4), `roughSpecular` (the radiance cache along the
reflection) and `diffuse` (the diffuse GI along the normal). `diffuse` rises from 0 at `maxRoughnessToEvaluateRoughSpecular - roughSpecularFadeLength` to the full remainder at
`maxRoughnessToEvaluateRoughSpecular` (defaults 0.8 and 0.2). Both options are validated and a game can set its own limit.
Red then green: `pnpm exec vitest run packages/core/__tests__/traced-reflections.spec.ts` (11/11; the two new tests failed before the implementation).

Wiring result (NVIDIA, headed, one tree, `roughSpec=0` against `roughSpec=1`, median Lab deltaE to Unreal at L8; `sr=0`):

| Cell and region | off | on |
|---|---:|---:|
| spheres sun60 Sphere_Chrome / SmoothDielectric | 2.13 / 0.97 | 2.11 / 0.97 |
| exterior sun60 Sphere_RoughMetal / Box_Red | 3.66 / 4.49 | 6.96 / 5.55 |
| exterior sun15 Sphere_RoughMetal / Box_Red | 3.42 / 1.71 | 24.07 / 2.93 |
| exterior sun04 Sphere_RoughMetal / Box_Red | 7.11 / 10.85 | 20.41 / 11.69 |
| exterior sun15 and sun04 Floor | 4.81 / 3.85 | 5.46 / 4.88 |

The smooth regions do not move, because they take the traced share. Every rough region gets worse: the rough metal reads 157 against Unreal's 95 at sun15. Cause: the ambient
cube is a wide, shaded-side-bright lobe (D9), and a rough metal's specular is its whole colour, so the excess lands at full strength; the sky term it replaces was dim, which hid that.
Decision: `roughSpec` is off by default, so no pixel changes. The routing box stays open until the cache's shaded level matches Unreal. Revisit when `ScreenProbeGather` or the cache
shows the shaded side within a factor of 1.3 of Unreal (D9), then rerun this table.

### D9 — On a lit surface the hit light is right; the excess is in the cache's shaded side (2026-10-22, reflect3-lane)

Layer: the hit light is harness (`scripts/unreal-look/scaffold/render/reflectionTrace.ts`, look) and the bounce term it reads is the cache (`giCache.ts`, gi lane). This note replaces D7's "2 times too much direct light and 5 to 10 times too much shaded bounce" for the code that is now in the tree.
Method: Unreal's own hit light is its Lumen Scene view (`r.Lumen.Visualize 3` at L8, the sphere poses; the surface cache as a ray sees it). Each number is a median (or, for the chrome third, a mean) of scene-linear luminance over an ID mask. Same frames for ThreeNative: the full L8 frame, a frame with the sun only (`ki=0`), a frame with the cache only (`kd=0`), and a frame where the camera ray itself is lit by the hit code (`dbg=hitlit`, a diagnosis knob that is not in the tree).

| Floor pixels | sun60 | sun15 | sun04 |
|---|---|---|---|
| Lit floor: Unreal Lumen Scene, ThreeNative hit light, ThreeNative screen | 0.643, 0.714, 0.734 | 0.182, 0.248, 0.276 | 0.0196, 0.0272, 0.0411 |
| Floor in shade (spheres pose): same three | 0.0709, 0.0793, 0.0586 | 0.0415, 0.0437, 0.0484 | 0.0062, 0.0128, 0.0167 |

| Chrome sphere, lower third (the reflected floor), mean | sun60 | sun15 | sun04 |
|---|---|---|---|
| Unreal L8, ThreeNative L8, ratio (spheres pose) | 0.550, 0.602, 1.10 | 0.0753, 0.118, 1.56 | 0.0555, 0.0895, 1.61 |
| Same, exterior pose | 0.577, 0.629, 1.09 | 0.0558, 0.121, 2.17 | 0.0377, 0.0931, 2.47 |

What this says:
1. A lit hit is within 10 to 35 percent of Unreal's surface cache, and it is closer to it than ThreeNative's own screen light is (the floor on screen is 0.276 against Unreal 0.182 at sun15). The direct term is not the fault: in the lower third the sun-only frame is 0.0003 at sun15 and sun04 (those hits are in the sun's shadow), and at sun60 the sun-only frame is 0.527 of 0.602.
2. In shade the hit light equals ThreeNative's own screen light and both are above Unreal at dusk (the floor at sun04: hit 0.0128, screen 0.0167, Unreal 0.0062). The reflected floor is 1.6 to 2.5 times too bright at sun15 and sun04 because the shaded floor is. That belongs to the cache's sky and bounce level (gi lane and sky lane), not to the hit.
3. Exposure is not a factor: the hit light and the screen light go through the same gain. Not measured: how much of the dusk shade excess is the sky term of the cache, and how much is its bounce.
Decision: no change to the hit light of the sun scenes. The finding sets the revisit condition of D10: the routing wiring waits for the cache's shaded side.

### D11 — The chrome pose: a hit takes the direct light of every lamp (2026-10-22, reflect3-lane)

Layer: harness (`reflectionTrace.ts` is where a hit is lit; "how it is lit is a look"), with one new scene and one new Unreal variant for the harness.
Scene: `tools/unreal-reference/gi/mirror-room` is the `cornell` room closed at the front, with a polished chrome block (`Mirror`: base 0.95, roughness 0.05, metallic 1, turned 40 degrees) and one lamp under the ceiling. No sun and no sky, so a ray that finds nothing shows black and the room is the only thing a mirror can show. Poses: `chrome` (1.1 m from the Mirror, which fills the frame) and `room`. Criteria: `mirror-room/criteria.md`. The GI scenes had no L8 variant (D4), so `scenes.json` has a new variant `L8` (layer L8, `sg.GlobalIlluminationQuality 3`, `r.ReflectionMethod 1`) and `gi.ts` pairs it (`unrealVariant("L8")`; red then green in `unreal-look-compare.spec.ts`, 41/41). `L7-Epic` has `r.ReflectionMethod 0`, so it is the wrong target for a mirror: it shows a soft green gradient with no walls.
Cause of the wrong Mirror: a hit was lit by the sun plus the cache, and this scene has no sun, so the hit had no direct light. The reflected green wall read (86, 157, 57) against Unreal's (124, 196, 94) and the shadow on the reflected green wall was missing. Unreal's surface cache takes the direct light of every light (`Engine/Source/Runtime/Renderer/Private/Lumen/LumenSceneDirectLighting.cpp`).
Fix: `ITracedReflectionStage.lamps` (point and spot lamps) lights a hit with colour times candela over the squared distance, the lamp's cut-off window and cone, and the same any-hit shadow ray as the sun. The scene registers its lamps in `reflectionTrace.lamps`; a scene with no lamps builds the same graph as before. Diagnosis knob `?lampHit=0` is the BEFORE arm.
Result (NVIDIA, headed, L8, owned engine, median deltaE and dP50 to Unreal; two runs per arm, the runs differ by at most 10 display levels on 416 pixels of the chrome frame):

| Region | BEFORE | AFTER |
|---|---|---|
| chrome pose, Mirror | 15.56 and 0.261 | 5.12 and 0.101 |
| room pose, Mirror | 2.87 and 0.045 | 0.69 and 0.000 (PASS) |
| room pose, Floor, Back, Wall_Red, Wall_Green, Box_Tall | 2.05, 1.93, 2.33, 7.29, 3.82 | unchanged |

Judge (fresh Sonnet, six frames, criteria set before the run): IMPROVEMENT on both poses and overall. The `chrome` pose stays a MISMATCH against Unreal and the `room` pose is CLOSE.
What is left, and why:
1. The reflected walls are 4 to 11 percent below Unreal at the top and fall 27 to 40 percent below by the foot of the wall (green, G channel 192 to 159 against Unreal 198 to 184), because the lamp's direct light falls with the cosine and Unreal's walls stay flat. The screen does not have this fault: the `room` pose walls follow Unreal's top-to-foot gradient (Back, TN over Unreal 0.92 at the top and 0.95 at the foot; Wall_Red 0.89 and 0.93), and `ssgi=0` moves the walls by under 3 percent (Floor 0.644 to 0.668, Back 0.677 to 0.680, Wall_Red unchanged), so the gather is not what a hit lacks. The screen and a hit both take the lamp plus the cache. What differs is how the lamp's light shades a rough wall: on screen the direct light uses the EON rough diffuse (`shadeLikeSubstrate`, PRD-653), which is brighter than Lambert facing the lamp and flatter at grazing angles, and the lower wall meets the ceiling lamp at a grazing angle; a hit uses Lambert. Untested candidate: a hit lit with the same lobe. Not built, because the lobe lives in a closure of `packages/core/src/render/rough-diffuse.ts` and Unreal's own surface cache lights a hit as Lambert, so the fix may belong to the cache's bounce instead (gi lane). A later cache fix reaches a hit, since a hit takes the cache's irradiance as it is.
2. A dark olive wedge at the lower left of the `chrome` frame (about 270 by 85 pixels), where Unreal shows a faint pale shape. It is a lamp shadow and has the same cause as 1: Unreal fills a shadow with bounce light.
3. Unreal's reflected walls carry soft mottled noise (surface cache and denoiser). ThreeNative shows smooth walls. Not ported.
4. The other regions of the `room` pose are not reflection regions. They have the same numbers at L7 (Floor 2.01, Back 1.96, Wall_Red 2.32, Wall_Green 7.58, Box_Tall 3.93) and the direct light matches at L1 (Wall_Green 0.35), so the fault is the indirect level: Wall_Green is 16 percent too bright on screen while its reflection is too dark. GI lanes own them.
Spheres scene (the wack-a-mole check): lamps are empty there, so the stage is unchanged. Two cells (sun15 spheres, sun60 exterior) were captured with the scaffold at HEAD (BEFORE) and with this tree (AFTER), and again with this tree. AFTER against BEFORE differs in 136106 and 60356 pixels; AFTER against AFTER differs in 118456 and 73136, so the difference is run noise. `compare --check --layer L8` on the AFTER capture breaks 12 of the 22 L8 locks (sun60 floors, `Sphere_Chrome` sun60 dP50 0.01005, others), all in cells where the change is inert; the BEFORE capture covers 2 cells and was not checked against the locks, so whether those 12 broke before this change is unverified. `Sphere_Chrome` is not touched by the routing commit (`roughSpec` is off, D10). The GI lock for `mirror-room` at L8 is not seeded: `reference-stats.json` needs the Unreal convergence captures (`L7-Epic@360`) that `--write-stats` demands.
