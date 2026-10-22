---
prd_contract: v1
---

# PRD-639 — A Surface Cache gives traced rays the texture, glow and lights of what they hit

**Status:** IN PROGRESS
**Priority:** P2 — the harness bake now reads the map and the lamps where a ray lands (Phases 2 and 3). The GPU kernel (AC-2) waits for PRD-603 Phase 2, and the L7 cells are closer to Unreal but not yet within the PRD-631 thresholds (AC-1).
**Complexity:** 7 (HIGH) — 6–10 files: the trace kernel, a material atlas, a light list, specs, a conformance scene (+2), new module `surface-cache.ts` (+2), state across frames: atlas pages and a light update budget (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 (the traced refresh and its flat material table). [PRD-638](../../done/PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 1 (the scene pipeline), [PRD-646](PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) Phase 2 and [PRD-647](../../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md) Phase 1. This PRD authors the `neon-corridor` calibration scene. Feeds [PRD-640](PRD-640-pixels-gather-bounce-light-from-screen-probes-and-the-radiance-cache-answers-the-rest.md) and [PRD-642](PRD-642-glossy-surfaces-reflect-what-the-camera-cannot-see.md), whose rays hit the same surfaces.

## Context

PRD-603 traces probe rays through `GPUSceneBVH` (`packages/core/src/gpu-scene-bvh.ts`). Its hit
returns the material emissive plus the material colour times the sun term, with one shadow ray.
The colour is one flat value per material ("The trace path is flat material colour only",
PRD-603 Solution). Local point and spot lights are out of its scope.

The harness prototype has the same limits. `scripts/unreal-look/scaffold/render/giCache.ts` reads
`material.color` and `material.emissive * emissiveIntensity` at each hit and gathers only the sun.
It works for the PRD-631 scene because every surface there is one flat colour. It does not work
for imported assets: a Fab or Strata wall with a brick texture bounces its untextured `color`,
which is often white. A torch in `action-rpg` adds no bounce at all.

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

- **Rays read a cache, not the material.** Lumen keeps a Surface Cache: each mesh has a few
  axis-aligned cards, built offline (UE 5.8.3: `Engine/Source/Runtime/Engine/Private/MeshCardRepresentation.cpp`).
  The cards capture albedo, normal, emissive and depth into a physical atlas
  (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenSceneCardCapture.cpp`,
  `Engine/Shaders/Private/Lumen/SurfaceCache/LumenSurfaceCache.usf`). A distance-field hit samples
  the cards around the hit point (UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenSoftwareRayTracing.ush`).
- **Budgets.** The atlas is 4096² at Epic and 2048² at Medium, in pages of 128 texels. Cards range
  from 2 to 512 texels at Epic. Capture is bounded to 300 cards and atlas ÷ 64 texels per frame
  (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenSceneRendering.cpp`, `Lumen.h`;
  `Engine/Config/BaseScalability.ini`, `[GlobalIlluminationQuality@1..3]`).
- **Every light lights the cache.** Direct lighting culls the lights per card tile, shadows them and
  writes the result (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenSceneDirectLighting.cpp`).
  It refreshes atlas ÷ 32 texels per frame at Epic and ÷ 128 at Medium.
- **Bounce and glow join in the cache.** Radiosity traces short hemisphere rays from the cards and
  reads last frame's lit atlas, so bounces build up over frames (UE 5.8.3:
  `Engine/Source/Runtime/Renderer/Private/Lumen/LumenRadiosity.cpp`). The final texel is
  `(direct + indirect) × albedo + emissive` (UE 5.8.3: `Engine/Shaders/Private/Lumen/SurfaceCache/LumenSurfaceCache.ush`).
  Emissive lights the world only through rays that hit a card. There is no separate emitter path.
- **Moving and skinned meshes.** A moved primitive invalidates its cards and they are captured
  again inside the budget. A skeletal mesh gets cards from its bounds only, and Medium turns that
  off (`r.MeshCardRepresentation.SkeletalMesh=0`).

## Solution

The **Surface Cache** keeps Unreal's name and its job: the thing a traced ray reads at a hit. It is
built in the order that pays first and measured at each step.

1. **Measure the gap (Phase 1).** This PRD authors the `neon-corridor` calibration scene with the
   PRD-638 pipeline: a textured wall (a brick albedo whose mean is not its `color`), emissive strips,
   a 5 cm emitter and a point lamp. The harness
   `giCache.ts` already raycasts on the CPU, so it can test both causes without GPU work: once with
   flat colour and sun only (today), once with the albedo texel at the hit UV and the lamp added.
   **Gate:** continue to Phase 2 only if the textured variant moves an L7 region by more than the
   PRD-631 noise floor, and to Phase 3 only if the lamp does. The verdict goes under `## Decisions`.
2. **Albedo and emissive at the hit (Phase 2).** A `SurfaceCache` object builds a material atlas: for
   each material in the `GPUSceneBVH` material table, its base colour and emissive maps, reduced to
   a small mip (64 × 64 start value, auto-sized from the atlas budget) and packed into pages. The
   trace kernel computes the hit UV from the triangle barycentrics, which `bvhIntersectFirstHit`
   already returns, and samples the atlas. A material without a map keeps its flat colour. This is
   a texture-space cache, not Unreal's card projection: the meshes already carry UVs, so cards would
   add a build step for no gain. The decision stays open in `## Decisions` until the judge sees it.
3. **Every light at the hit (Phase 3).** The kernel evaluates the scene's point, spot and rect lights
   at the hit, culled to the lights whose range reaches the probe, with one BVH shadow ray each.
   The cap is 8 lights per hit (start value), the brightest first. Unreal caches this lighting in
   the atlas and refreshes a fraction per frame. This PRD evaluates it per hit first. It adds a
   cached lighting page only if Phase 3 measures the per-hit cost above the PRD-603 probe budget.

**Names.** `SurfaceCache` with options in Unreal's terms: `atlasSize`, `cardTexelDensityScale` and
`directLightingUpdateFactor` where the cached path exists. Its manifest entry carries
`@alias lumen surface cache`, `@alias lumen scene` and `@alias mesh cards`, so an agent that knows
Unreal finds it.

**Where each part lives.** The atlas, the UV lookup and the light loop are mechanism in
`packages/core/src/render/surface-cache.ts`, beside the trace. Every colour, texture and light comes
from the game's materials and lights. The cache owns none.

**Honest reporting.** `TN_SURFACE_CACHE` reports atlas bytes, pages in use, the materials that fell
back to flat colour and why, and lights skipped by the cap.

## Acceptance Criteria

- [ ] AC-1 [local]: On the `neon-corridor` scene, the L7 cells on the owned engine are within the PRD-631 thresholds of Unreal Epic in every region that Phase 1 found sensitive. proof: `pnpm unreal-look:compare --scene gi:neon-corridor --layer L7` — Evidence 2026-10-21 (not met): with the cache every one of the 10 L7 cells is closer to Unreal and none is within the 0.01 dP50 target. The best cell is the `neon` back wall at 0.048. This scene has no thresholds yet (`--write-thresholds` needs an Unreal-against-Unreal run), so every verdict reads `report`.
- [ ] AC-2 [local]: The Surface Cache adds no more than 25% to the PRD-603 traced refresh time per probe on the `neon-corridor` scene, on a named WebGPU adapter. proof: the PRD-603 probe-cost playtest on the same scene, with and without `surfaceCache` — Evidence: pending.
- [x] AC-3 [local; needs a built desktop host]: The new conformance row `surface-cache-albedo` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests surface-cache-albedo` — Evidence 2026-10-21: web lane pass on the NVIDIA adapter (turing); desktop lane pass against that reference, pixelMismatchRatio 0 and perceptualDeltaE 0 (tolerance 0.02 and 5.0), with `node packages/runtime-native/conformance/run-conformance.mjs --target desktop --only-tests surface-cache-albedo --reference <web run>`. The host was the `tn-linux-jsprofile` build of 2026-09-19, which runs the Three.js engine: it predates the owned engine, and no fresh `pnpm native:build` ran for this row. The row's own assertions (decoded texel, colour factor, metal term, mapped and flat counts) throw before any pixel is read, so the numbers match on that host. **Owned-engine result 2026-10-22 (parityaudit-lane):** `pnpm parity --target desktop --engine threenative --only-tests surface-cache-albedo` (V8 engine player, RTX 2080, web reference from the same run): pass, pixel mismatch 0, delta E 0 (tolerance 0.02 / 5), no GPU validation error, owned frame viewed. The proof above ran the legacy `mystral` host. **Re-proved with the fixed runner, 2026-10-22 (ownedbind2-lane):** `pnpm parity --target desktop --engine threenative` at `fbfd286b6` (runner fix `5883fc179`, which steps the player clock: before it every owned desktop capture was the first frame), V8 engine player, RTX 2080, upstream web reference from the same slot (adapter nvidia): pass, pixel mismatch 0, delta E 0, non-uniform frame.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Material atlas at the hit | A game passes `surfaceCache` to the traced radiance cache (PRD-603) | Replaces the flat material table for materials with maps | AC-1, AC-2 |
| Local lights at the hit | The same object, every traced ray | New. Sun-only stays when a scene has no local lights | Phase 3 |
| Manifest entry | `engine_search_capabilities "lumen surface cache"` | New entry | Phase 2 |

## Execution Phases

#### Phase 1: Which hit data changes the picture
**Status:** IN PROGRESS (2 of 3 boxes)
**Files:** `tools/unreal-reference/gi/neon-corridor/{scene.py,criteria.md}` (new), `tools/unreal-reference/gi/scenes.json`, `scripts/unreal-look/scaffold/render/giCache.ts`
- [ ] `neon-corridor` is ready to calibrate: authored and captured in Unreal, recreated with direct light matching (PRD-646), and its PRD-647 criteria written. proof: `pnpm unreal-look:capture --engine unreal --scene gi:neon-corridor --check-cvars` and `pnpm unreal-look:compare --scene gi:neon-corridor --layer L1` — Open 2026-10-21: the scene, its Unreal captures and its criteria exist. The direct light does not match yet. Re-measured 2026-10-21 on epic head 2174a4e2f with a Wasm pair built from that head and the local-exposure gate of this lane (see `## Decisions`): at L1 the owned engine is above Unreal in 6 of the 10 surface cells (the left wall, the floor and the brick wall in both cells), level with it on the back wall (122 against 122 and 120 against 120) and 1 to 2 levels below it on the ceiling. dP50 is 0.00 to 0.21 and CIEDE2000 0.4 to 3.9 against the 0.01 target. PRD-646 owns the rest. `--check-cvars` was not run again here.
- [x] The L7 region change from textured albedo at the hit is recorded under `## Decisions`. proof: `pnpm unreal-look:compare --scene gi:neon-corridor --layer L7`, flat against textured — Result 2026-10-21: over the 10 surface cells the mean dP50 against Unreal L7-Epic is 0.29 flat and 0.16 textured. The mean CIEDE2000 is 14.5 flat and 10.0 textured. All 10 cells move toward Unreal. Two runs of each arm are bit-identical. The table is under `## Decisions`.
- [x] The L7 region change from the point lamp at the hit is recorded under `## Decisions`. proof: the same command, sun-only against sun and lamp — Result 2026-10-21: this scene has no sun, so the arms are the lamp at the hit and no lamp at the hit (`?giLights=0`). The lamp adds 6 to 9 levels of p50 to every L7 cell. The mean dP50 is 0.16 with the lamp and 0.10 without it. See `## Decisions`.

#### Phase 2: Albedo and emissive from the material atlas
**Status:** DONE
**Files:** `packages/core/src/render/surface-cache.ts` (new), `packages/core/src/render/probe-trace.ts`, `packages/core/src/index.ts`, `packages/core/__tests__/surface-cache.spec.ts` (new), `packages/engine-mcp/__tests__/search.spec.ts`
- [x] A hit on a mapped material returns the atlas texel at the hit UV, and an unmapped material returns its flat colour. proof: `pnpm exec vitest run packages/core/__tests__/surface-cache.spec.ts` — Result 2026-10-21: 15 of 15 pass (red first: the module did not exist). The same hit through the harness bake, `pnpm exec vitest run scripts/__tests__/unreal-look-gi-cache.spec.ts -t "mapped wall"`: a closed furnace whose wall is a white factor under a 77/255 grey map reads `e (1 - rho^3) / (1 - rho)` with rho = 77/255 (a flat wall reads rho = 1, three times the light); `unreal-look-bake-rays.spec.ts`: the ray's UV equals three's Raycaster UV over 4000 random rays, mirrored and BackSide faces included.
- [x] A capability search for "lumen surface cache" returns `SurfaceCache`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts` — Result 2026-10-21: 55 of 55 pass with the regenerated manifest (453 entries). Negative control: the same test fails against the HEAD manifest.

#### Phase 3: Local lights at the hit
**Status:** IN PROGRESS (the Verification waits on AC-1)
**Files:** `packages/core/src/render/probe-trace.ts`, `packages/core/__tests__/surface-cache.spec.ts`, `packages/runtime-native/conformance/scenes/shared/surface-cache-albedo.js` (new), `packages/runtime-native/conformance/registry.json`
- [x] A point lamp lights the hit through its range and shadow ray, and the 9th-brightest light is skipped and counted. proof: `pnpm exec vitest run packages/core/__tests__/surface-cache.spec.ts` — Result 2026-10-21: the `SurfaceLights` cases pass (inverse square, window, cosine and shadow ray; no shadow ray behind the surface or past the range; the 8 brightest kept, the 9th skipped and counted on every hit; a spot lights only inside its cone).
**Verification:** AC-1 to AC-3. The change alters what reaches the screen, so a PRD-647 round on `neon-corridor` at `high` compares flat (BEFORE) against Surface Cache (AFTER), with Unreal Epic as the target. It must return IMPROVEMENT against BEFORE, and the `neon` and `textured` cells must move toward MATCH. NEUTRAL or REGRESSION means fix the cause and judge again.

## Decisions

- 2026-10-20 (PRD authoring): Unreal emissive has no separate emitter path. It lights the world only
  through rays that hit the emissive surface. This PRD keeps that model, so a tiny bright emitter is
  tested through the `neon` pose and the PRD-641 `neon` motion run, not with a special sampler.
- 2026-10-21 (surface lane): **Texture-space cache, as the Solution says.** Each material's base colour and
  emissive maps are box-reduced to a square tile (64 texels start value, times `cardTexelDensityScale`, halved
  until all tiles fit `atlasSize`, never below 2 or above 512). A hit reads the tile at its UV, through the
  texture's own flip, wrap mode and `matrix`. No cards: the meshes carry UVs already. Unreal's cards fix a
  different problem (a mesh with no usable UV set); the decision stays open for the judge as the Solution asks.
- 2026-10-21 (surface lane): **The consumer today is the harness bake, not `probe-trace.ts`.** PRD-603 Phase 2 is
  not built: there is no `probe-trace.ts`, and `GPUSceneBVH` packs no UVs, so the GPU kernel cannot read the
  atlas yet. `SurfaceCache` is renderer-agnostic JS (`packages/core/src/render/surface-cache.ts`, no imports)
  whose `albedo` and `emissive` methods answer one hit (`SurfaceLights.shade` lights it). The first consumer is
  `scripts/unreal-look/scaffold/render/giCache.ts` (the CPU probe bake): `bakeRays` returns the hit UV and the
  material slot, and `installGi({ surfaceCache })` reads the cache. When PRD-603 Phase 2 lands, its kernel packs
  the same tiles into one atlas texture and samples them at the barycentric UV; the tile layout and the report
  fields stay. AC-2 is bound to that kernel and stays open until then.
- 2026-10-21 (surface lane): **A defect found on the way: the installed material dropped its maps.** `installGi`
  swapped each mesh material for a `MeshStandardNodeMaterial` copy that kept colour, roughness and emissive
  but not `map`, `emissiveMap`, `normalMap`, `roughnessMap` or `metalnessMap`, so a textured wall drew its
  colour factor at L7. No scene before `neon-corridor` had a map. Fixed in the same change, with a spec.
- 2026-10-21 (surface lane): **The harness keeps its own light loop.** `giCache.ts` `surface()` already gathers
  the sun and every point light with one shadow ray per 0.5 m cell, with three's inverse square and window.
  `SurfaceLights` is the same model with a cap (8, brightest first, skipped count reported), for the GPU
  kernel. Replacing the harness loop would only add a diff in a file the GI lane owns, so it stays.
- 2026-10-21 (surface lane): **Calibration scene pipeline learned textures.** `scene.json` names a material's
  albedo texture, `gi/export.py` imports it as an sRGB Texture2D and binds it, and `validateSceneExport` checks
  the texture both ways (glb has one and json does not, or the reverse). An emissive above 1 is read through
  `KHR_materials_emissive_strength`, as Unreal's glTF exporter splits it; before this the export failed with
  "material MI_Cyan differs between scene.json and scene.glb".
- 2026-10-21 (surface lane): **The owned engine hides a glTF map's pixels, so the game hands them over.** On the
  owned engine `material.map.image` of a glTF texture is a plain object with a width and a height. The first
  `neon-corridor` capture ran with `mappedMaterials` 0 and a `fallbacks` row that named `MI_Brick` as
  `unreadable-image`, so its AFTER frames equalled the flat ones. `SurfaceCache.from` now takes an
  `images(material, slot)` callback for a map whose own image has no pixels. The calibration scene reads the
  images again from the glb it loaded (`scripts/unreal-look/scaffold/render/glbImages.ts`). The asset pipeline
  moves a glb's images out to `shared/images`, so the reader follows the image `uri` as well as a buffer view.
  After it the report reads `mappedMaterials` 1, `flatMaterials` 6 and no fallback. The other fix is a pixel
  getter on the engine's texture binding (`bindings_material.cpp` has only `image.width` and `image.height`).
  It changes the ABI of both engines, so it is not taken here.
- 2026-10-21 (surface lane): **Textured albedo at the hit moves all 10 L7 cells toward Unreal.** The brick map is
  red-brown (mean linear albedo 0.34 red, 0.13 green, 0.10 blue, luminance 0.18), so a ray that lands on the
  brick wall now returns far less light than the white factor did, and the wall bounces a warm cast. Cells are `neon` and `textured` poses by region. Values are p50 of
  the display level, then dP50 and CIEDE2000 against Unreal L7-Epic. Two runs of each arm are bit-identical.

  | Pose, region | Unreal | Flat (`?giMaps=0`) | Cache |
  |---|---:|---:|---:|
  | `neon` floor | 140 | 186, 0.329, 18.5 | 165, 0.179, 14.0 |
  | `neon` ceiling | 115 | 157, 0.365, 17.1 | 135, 0.174, 12.4 |
  | `neon` left wall | 152 | 200, 0.316, 18.5 | 170, 0.118, 9.7 |
  | `neon` brick wall | 73 | 101, 0.384, 12.9 | 90, 0.233, 9.2 |
  | `neon` back wall | 188 | 212, 0.128, 8.2 | 197, 0.048, 4.9 |
  | `textured` floor | 149 | 197, 0.322, 17.7 | 181, 0.215, 14.0 |
  | `textured` ceiling | 148 | 178, 0.203, 10.1 | 163, 0.101, 6.7 |
  | `textured` left wall | 164 | 204, 0.244, 16.9 | 183, 0.116, 11.5 |
  | `textured` brick wall | 75 | 112, 0.493, 16.6 | 101, 0.347, 12.5 |
  | `textured` back wall | 186 | 211, 0.134, 8.6 | 197, 0.059, 5.2 |

  The plain walls and the floor take the brick's warm cast, which Unreal's frames also show, and the room is
  darker and closer to Unreal. The strips' cyan and magenta cast on the walls is missing in both arms (the
  emissive lane). A fresh read-only judge returned IMPROVEMENT on both poses.
- 2026-10-21 (surface lane): **The lamp at the hit is not the cause of the remaining excess.** With the lamp left
  out of what a ray returns (`?giLights=0`; the direct frame keeps the lamp) every L7 cell loses 6 to 9 levels of
  p50 and gets closer to Unreal: the mean dP50 falls from 0.16 to 0.10, and the `neon` back wall reads 188 against
  Unreal's 188. Unreal's own bounce includes the lamp, so the lamp stays in the rays. The excess comes from the
  direct light: at L1, with no bounce at all, the owned engine is above Unreal in most surface cells (p50 55
  against 42 on the `neon` left wall, 78 against 68 on the `textured` floor), and the lamp's bounce scales with
  the same lamp level. PRD-646 direct light matching is the first suspect for this scene. The next note
  corrects how large that excess is. An empty lamp list
  stops the bake in a scene with no sun and no sky (`installGi` returns nothing), so the switch keeps the lamp's
  place and sets its ray intensity to 0.
- 2026-10-21 (surface2 lane): **The L1 direct light sits above Unreal mainly because of local exposure, which the
  calibration scene did not switch off below L9.** Unreal draws L1 to L8 with `ShowFlag.LocalExposure 0` (PRD-631).
  The `high` preset turns the stage on since the finishing chain became the default (`ff837b1f2`), and
  `CalibrationScene.ts.in` never turned it off, so it lifted the dark regions. On epic head `2174a4e2f` with a
  fresh Wasm pair, `neon-corridor` L1 read `neon` Floor 78, Wall_Left 69 and Wall_Brick 26 against Unreal 55, 42
  and 11. With the stage off it reads 60, 51 and 13 (Back 122 against 122). The mean dP50 of the 10 surface cells
  at L1 falls from 0.48 to 0.08. The earlier "above in all 8 cells" came from this lift plus a small real excess in
  the floor and the left wall. The gate is `localExposureEnabled: level >= 7` (`?localExposure=0|1` forces it).
  **L7 and L8 keep the stage, on purpose.** A first version switched it off at L7 too. On `neon-corridor` L7 that
  was neutral (brick wall closer, back wall further, mean dP50 0.17 in both arms) and the sunlit room was
  identical. On `cornell` L7 on head `93a13713f` it broke 14 bounds of the re-cut L7-high locks (`Back` deltaE 7.49
  against 4.33, `Wall_Red` dP50 0.133 against 0.056, `Box_Tall` dP50 0.128 against 0.104). The L7 cache is brighter
  than Unreal's, and the stage's highlight compression hid part of that: a level `Back` at L7 was two errors that
  cancelled. Open: remove the stage at L7 and L8 in the same change that removes the GI excess (the gather lane).
  Judges (criteria first, two runs per arm, on the final gate): L1 overall IMPROVEMENT. `neon-corridor` `neon` and
  `textured` IMPROVEMENT (Wall_Brick dP50 1.36 to 0.18 and 1.07 to 0.07), `sunlit-room` six poses NEUTRAL. The
  L7 rounds of the first version are on PR #541 and no longer apply.
- 2026-10-21 (surface2 lane): **A washed-out neon-corridor L1 on the merged head was a stale Wasm pair, not the
  head.** The pair copied at lane spawn (17:16) lacked the C++ of PRD-636 (`b75c036d7`, `a7ad05dba`). With the head's
  JS on that pair, L1 read p50 220 to 245 on the walls against Unreal 42 to 122. A pair built from the head
  (`cmake --preset wasm`, 2 minutes) gives the numbers above. See the memory `lane-wasm-pair-trails-the-epic-cpp`.
