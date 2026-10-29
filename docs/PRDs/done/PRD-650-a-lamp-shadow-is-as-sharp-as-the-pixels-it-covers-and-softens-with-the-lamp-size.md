---
prd_contract: v1
---

# PRD-650 — A lamp's shadow is as sharp as the pixels it covers, and softens with the lamp's size

**Status:** DONE 2026-10-22 — the owned-engine desktop and Wasm proof of the source-radius row passes (ownedbind-lane)
**Priority:** P2 — a lamp's penumbra follows its source radius, a still lamp keeps its map, and each lamp map is sized from the pixels it covers as in Unreal, and the native desktop engine matches the browser on the source-radius row.
**Complexity:** 7 (HIGH) — 6–10 files across core and the native engine (+2), a per-light resolution choice and a per-light cache are new state (+2), the native engine and the browser are separate build boundaries (+2), native proof (+1); risk override: a per-light cache must never show a stale shadow, so Phase 2 proves invalidation before any visual claim.
**Owner:** João
**Depends on:** [PRD-649](../Unreal/shadows/PRD-649-shadow-calibration-scenes-are-built-in-unreal-and-judged-until-parity.md) Phase 2 (the `lamp-room` scene and `swing` run). Builds on the source-angle filter of [PRD-634](../Unreal/look/PRD-634-sun-shadows-reach-the-horizon-and-soften-with-distance-from-the-caster.md) Phase 2. Takes over the local-light scope of [PRD-457](../Unreal/rendering/PRD-457-virtual-shadows-scale-by-measurement.md) Phase 3 (see `## Decisions`). Coordinates with [PRD-VQ-06](../rendering/PRD-VQ-06-many-local-lights.md), which owns unshadowed light lists.

## Context

**ThreeNative today:**

- **Native engine (the default engine):** a spot light draws one 2D depth map and a point light
  draws a six-face cube (`packages/runtime-native/src/engine/renderer/renderer.cpp:2485`). Both
  maps take the light's authored `shadow.mapSize` and are reallocated only when that size changes.
  No shadow update policy appears in the renderer, so each map is redrawn every frame.
- The receiver reads them with the 5-tap Vogel PCF (`packages/runtime-native/src/engine/shader/standard.cpp:707-722`)
  and the cube with `pointShadowFactor` (`standard.cpp:780-820`). The penumbra width is a constant
  in texels.
- **Core:** `sourceAngleShadowFilter` (`packages/core/src/render/soft-shadow.ts:69`) is
  directional only. It assumes an orthographic map.
- No light carries a source radius. three.js has no such property.

**Unreal 5.8.3** (source read 2026-10-20; clean-room summary, no code copied):

| Behaviour | Default | Source |
| --- | --- | --- |
| Shadow method for lamps | Virtual shadow map: a spot is 1 map, a point is 6 (one per cube face), 16384² virtual each, sharing the sun's page pool | `Engine/Source/Runtime/Renderer/Private/Shadows/ShadowSceneRenderer.cpp:343-470` |
| Resolution | Pages marked from the depth buffer at the mip the pixel footprint needs; LOD bias 0 for a still lamp, +1 for a moving one (Epic) | `Engine/Config/BaseScalability.ini:260-261` |
| Penumbra | SMRT: rays in a cone of `SourceRadius / distance`, 8 rays × 4 samples at Epic; a radius of 0 gives one hard tap | `Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapProjectionSpot.ush:306,344-347`; `BaseScalability.ini:264-265` |
| Source radius | 0 for a new point or spot light | `Engine/Source/Runtime/Engine/Private/Components/PointLightComponent.cpp:31` |
| Caching | Static and dynamic page layers; a caster's move invalidates only lights whose radius it touches | `Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapCacheManager.cpp:199` (`Cache.CPUCullInvalidationsOutsideLightRadius` 1) |
| Far lamps | A lamp that needs only its coarsest mip updates at most once per frame, throttled | `r.Shadow.Virtual.DistantLightMode` 1, `MaxDistantUpdatePerFrame` 1 |

So a fresh Unreal lamp casts a sharp shadow whose texel matches the screen, and turns soft only
when the game sets a source radius.

## Solution

1. **Resolution follows the footprint (Phase 1).** Each shadowed spot or point light picks its map
   size each frame from its projected footprint: the largest screen-space size of one shadow texel
   over the receivers it lights, rounded to a power of two between 256 and the platform limit. A
   moving light takes one step coarser, as in Unreal. All lamp maps share one atlas, sized by the
   tier's budget (PRD-652). Over the budget, the smallest-footprint lamps step down first.
   `shadow.mapSize` set by the game becomes an override, reported as overridden.
2. **A cache per lamp (Phase 2).** A lamp's map is redrawn only when the lamp moves, its footprint
   changes size, or a caster inside its radius changes. The casters reuse the static/moving sort of
   [PRD-572](PRD-572-shadow-casters-sort-themselves-into-static-and-moving.md): moving
   casters draw into a per-lamp mover layer, and static ones stay cached. A lamp off screen and out
   of reach of visible receivers is not redrawn.
3. **`sourceRadius` softens the shadow (Phase 3).** `light.shadow.sourceRadius` (metres, default 0,
   Unreal's name and default) drives a blocker search and a variable-radius filter in perspective
   and cube space: the penumbra is `gap × sourceRadius / blockerDistance`, floored at one texel. At
   0 the filter is the single hard tap. The filter is a mechanism: the radius is a game value.
   It ships as a core TSL filter for the `engine: "threejs"` override and as the native engine path
   for the default engine.

**Look is untouched.** The atlas, cache and filter decide no colour, bias or radius. Templates that
set a lamp radius do it in `src/render/`.

**Left out on purpose:** rect and area lights (three's `RectAreaLight` casts no shadow, and Unreal's
default rect light shadows through the same path, so it waits for a game that asks), hardware
ray-traced lamp shadows and MegaLights (both off in a fresh Unreal project), and lamp contact
shadows (off in Unreal, declined in PRD-561).

## Acceptance Criteria

- [x] AC-1 [local]: On `lamp-room` at `high`, a PRD-647 round returns no REGRESSION against BEFORE, and MATCH or CLOSE against Unreal on `spot`, `spot-soft`, `point` and `rod`. proof: `pnpm unreal-look:calibrate --scene shadow:lamp-room --tier high --before <commit>` — Evidence 2026-10-21: I ran the judge tool (`scripts/unreal-look/judge.ts`, Sonnet, layer L5, tier high, `--expect improvement`) directly on 2 runs per arm, not the `calibrate` wrapper. BEFORE is the epic's lamp code (e23c6e92e) on the same tree, AFTER is 3b8ff1b78. OVERALL IMPROVEMENT, no REGRESSION on any pose: `spot-soft` IMPROVEMENT, `spot`, `point` and `rod` NEUTRAL; against Unreal all four are CLOSE. The cornell L6 round is OVERALL IMPROVEMENT. Verdict and sheets: PR #541 comment 6332486803. The first AFTER arm (before the back-face bias) read REGRESSION on `point`, the dotted line along the crate's far foot; the bias removed it.
- [x] AC-2 [local]: In the `swing` run, a still lamp redraws its map 0 times in frames 0 to 59 and after frame 130, and the moving box's shadow never lags its box by more than 1 frame. proof: `pnpm unreal-look:calibrate --scene shadow:lamp-room --run swing` with the `TN_SHADOW_REFRESH` counters — Evidence 2026-10-22: the `swing` capture with the owned engine's lamp counters (the `TN_LAMP_SHADOW` fields) reads 0 redraws in frames 0 to 59, 0 after frame 130, and a redraw on the first moved frame (lag 0). See the Phase 2 AC-2 box.
- [x] AC-3 [local]: The `spot-soft` penumbra width is within 25% of Unreal's at the 10 cm radius. proof: `pnpm unreal-look:compare --scene shadow:lamp-room --layer L5 --metric penumbra --captures <root>` — Evidence 2026-10-21: owned engine, NVIDIA WebGPU, two runs with byte-identical frames: 12.62 px against Unreal's 10.61 px, ratio 1.189 on 18 matched edge rows. The epic's estimator measured 19.54 px, ratio 1.831. On `cornell` L6 (6 matched rows) the ratio moves from 0.44 to 0.75. The hard `spot` and the 5 cm `point` edges are unchanged (ratios 1.68 and 1.54: the one-tap PCF edge, which Phase 1 narrows). Re-measured 2026-10-21 on the merged tree with the bias (BEFORE and AFTER captured on the same tree): spot-soft 15.19 px before, 9.17 px after, against Unreal's 10.46 px, ratio 1.45 to 0.88.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Footprint-sized lamp atlas | Any `SpotLight` or `PointLight` with `castShadow` | Replaces the fixed per-light `shadow.mapSize`, which becomes a reported override | Phase 1 |
| Per-lamp cache | The same lights, every frame | Replaces the every-frame redraw | AC-2 |
| `light.shadow.sourceRadius` | `templates/*/src/render/` lamp setup | Replaces the fixed 5-tap footprint for lamps | AC-3 |

## Execution Phases

#### Phase 1: Resolution follows the footprint
**Status:** DONE
**Files:** `packages/runtime-native/src/engine/renderer/renderer.cpp`, `packages/runtime-native/src/engine/renderer/shadows/` (lamp atlas), `packages/three-native/src/` (the override report), native engine tests
- [x] A lamp 2 m from the camera gets a finer map than the same lamp at 20 m, a moving lamp is one step coarser, and an over-budget atlas raises one global bias, so the lamp nearest its next coarser mip steps down first. proof: red-green native engine test `native_engine_lamp_atlas`. — Evidence 2026-10-22: `shadows/lamp_resolution.h` ports Unreal's local-light footprint and mip rule; the renderer sizes each spot or point map from its visible lit receivers (`renderer.cpp`, the `lampSizes` block). At 256² the spot reads 256 at 2 m and 128 at 20 m, 128 while it moves, and 256 again 12 still frames later; red with the size choice disabled: 512 at both distances and 512 moving (`CHECK failed: near > far`, `moving * 2 == still`). Over a budget of 1024² + 512², footprints of 17 and 30 texels give 1024 and 512. A `shadow.mapSize` other than three's 512² stays fixed and adds `TN_LAMP_SHADOW_MAPSIZE_OVERRIDE` to the diagnostics. 5 repeat runs read the same sizes. `ctest -L native-engine -j4`: 466/468 pass; `native_engine_render_shadows` was red until its two lamp fixtures took the override (see Decisions), and `native_engine_player_async_bridge` timed out under load and passes alone.
- [x] `lamp-room/rod` on the owned engine shows the 1 cm rod's shadow, which the fixed 512 map loses. proof: `pnpm unreal-look:calibrate --scene shadow:lamp-room --tier high --before <commit>` (cell `rod`). — Evidence 2026-10-22: owned engine, NVIDIA Turing WebGPU, L5, 2 runs per arm. The rod's shadow line is 10 px wide at the fixed 512 map (both runs), 6 px with the footprint size (both runs), and 6 px in Unreal (row-averaged profile, y 200 to 520). The 512 map keeps the line but blurs it to almost twice Unreal's width. Judge (judge.ts, Sonnet, `--expect improvement`): IMPROVEMENT overall, rod IMPROVEMENT, spot, spot-soft and point NEUTRAL, CLOSE to Unreal. Against the harness's old 1024 override: NEUTRAL on all 8 L5 and L9 frames (1 BEFORE run). Sheet and verdicts: PR #541 comment 6336292053 (https://github.com/ThreeNativeHQ/threenative-engine/pull/541#issuecomment-6336292053).

#### Phase 2: A cache per lamp
**Status:** DONE
**Files:** `packages/runtime-native/src/engine/renderer/renderer.cpp`, `packages/core/src/render/` (shared caster sort), native engine tests
- [x] A still lamp with still casters redraws 0 times over 300 frames, a caster moving inside its radius redraws it, and a caster moving outside its radius does not. proof: red-green native engine test `native_engine_lamp_cache`. — Evidence (2026-10-20): point + spot lamp, 300 still frames: 0 shadow draws (red with the skip disabled: 2100); caster moved outside range: 0 (red: 7); moved inside: 7; kept map pixels equal the fresh map's on all channels. The signature is the lamp cameras, map size and target, and each caster's key, matrix, geometry version, pipeline and cut; a GPU-deformed caster redraws every frame. `ctest -R native_engine_` only baseline reds (update_scaling under -j8, world_cells known red).
- [x] The shadow markers report lamp redraws and lamp shadow GPU time apart from the sun's levels, and the totals reconcile with the renderer's shadow submissions on one mixed-light frame. proof: red-green parser test in `packages/core/__tests__/virtual-shadow.spec.ts`. — Evidence 2026-10-22: `lampShadowMarker`/`readLampShadowMarker` (`TN_LAMP_SHADOW`, core `virtual-shadow.ts`) fail closed when sun draws + lamp draws differ from the renderer's shadow draws; spec "lamp shadow marker (PRD-650)" red 3 before the parser, green after, file 128/128. The owned engine counts `lampRedraws` and `lampShadowDraws` per frame and times lamp passes in their own GPU segment (`kGpuLampShadowSegment`); native tests `native_engine_lamp_cache` (first frame 2 lamp redraws, a sun-only frame 0) and `native_engine_gpu_timer_splits_lamp_shadows` (first frame sun 0.005 ms, lamp 0.008 ms, cached frame lamp 0; red with the lamp segment off) pass. The web facade reads them as `info.engine.shadows` (three-native spec 23/23).
- [x] AC-2 holds. proof: the AC-2 command. — Evidence 2026-10-22: `swing` run on the owned engine (crate moves 2.2 m in frames 60 to 120, 180 frames, `pnpm unreal-look:capture --engine threenative --scene shadow:lamp-room --motion swing --layers L5`, lamp counters from `renderer.info.engine.shadows` each frame, `swingRedraws` in `scripts/unreal-look/motion.ts`): 0 lamp redraws in frames 0 to 59, 0 after frame 130, and 3 redraws a frame from the first moved frame (lag 0 frames, bound 1). One run; the Unreal half of the swing run is PRD-649 work (shadowscenes-lane). PR #541 comment 6336292053.

#### Phase 3: `sourceRadius`
**Status:** DONE
**Files:** `packages/core/src/render/soft-shadow.ts`, `packages/core/__tests__/soft-shadow.spec.ts`, `packages/runtime-native/src/engine/shader/standard.cpp`, `packages/runtime-native/src/engine/renderer/renderer.cpp`, `packages/runtime-native/conformance/registry.json`
- [x] The perspective and cube filters widen linearly with the caster gap and with `sourceRadius`, and fall to one hard tap at 0. proof: `pnpm exec vitest run packages/core/__tests__/soft-shadow.spec.ts`. — Evidence 2026-10-20: `sourceRadiusShadowFilter` (core TSL, spot and point) and the owned engine's `lampSoftShadowFactor`; soft-shadow.spec.ts 6/6 (`lampPenumbraTangent` doubles with the gap and the radius, 0 at radius 0), shadow-node.spec.ts 6/6; red-green native test `native_engine_lamp_source_radius`: a 1 m penumbra at radius 0.5 m measures 0 px with the filter selection off, 7 px (point cube) and 8 px (spot) with it on; three's PCF and radius 0 measure 0 px. Re-proved 2026-10-21 for the nearest-blocker estimator and `penumbraScale` (default 0.6): soft-shadow.spec.ts 6/6 and shadow-node.spec.ts 6/6; `lamp_source_radius` and `lamp_source_radius_wall` pass at scale 1 and 0.6; the new `lamp_source_radius_crate` counts the floor pixels that the hard filter shades and the soft filter lights: 1374 without the receiver's own ray, 2 with it.
- [x] A box's far foot under a lamp stays dark with three's derived `shadowSide`, and the lamp-room crate's foot has no lit dots. proof: red-green native engine tests `native_engine_contact_shadow_foot` and `native_engine_lamp_source_radius_crate`. — Evidence 2026-10-21: the lamp's depth pass stores back faces 8 depth steps nearer (`kLampBackFaceBias` in `renderer.cpp`). At bias 0 the foot leaks 0.859 of the open floor and the crate shows 8 isolated lit pixels with the hard filter and 3 with the soft filter. At bias 8 the leak reads 0.000, the lit floor stays at 1.000, and both counts read 0. The 395 `native-engine` ctests pass except `native_engine_template_post_packages` and `native_engine_template_post_starter`, which are red on the epic. The `engine: "threejs"` path keeps the tie, because three has only a receiver-side bias.
- [x] The native engine matches the browser within tolerance. proof: `pnpm parity --target desktop --only-tests soft-shadow-source-radius`. — Evidence 2026-10-22 (lane/lamp a15fe1049, the epic merged in, NVIDIA RTX 2080): `pnpm parity --target web --only-tests soft-shadow-source-radius` passes (3.9 s), then `pnpm parity --target desktop --only-tests soft-shadow-source-radius` passes on the `tn-linux` host: pixel mismatch 0 and perceptual deltaE 0 against the browser frame (tolerance 0.08 and 10), no GPU validation errors, a non-blank frame with both penumbrae. The scene sets `shadow.mapSize` 1024, so the footprint rule keeps that size on both halves. The row keeps `desktopGate: false`; making it a CI gate is a separate change. **Unticked 2026-10-22 (parityaudit-lane).** The proof above ran the legacy `mystral` host on upstream three, not the owned engine, which is the desktop default since 2026-10-15. On the owned engine (`pnpm parity --target desktop --engine threenative --only-tests soft-shadow-source-radius`, V8 engine player, epic head c82595f3c) the row fails at the bundle step with `TN_NATIVE_ENGINE_UNBOUND` for `three/tsl:cubeTexture` and `three:LessEqualCompare`, so it renders no frame. Tick this box again when the row bundles, renders and passes on the owned engine. On the owned engine on web the same row passes (`node conformance/run-conformance.mjs --target web --engine threenative --only-tests soft-shadow-source-radius --reference <upstream three capture dir>`, Wasm engine in Chromium on the RTX 2080): pixel mismatch 0.0159, delta E 0.0154 against 0.08 / 10, no page error, both penumbrae drawn (frame viewed). Only the desktop V8 engine player cannot build the scene. **Re-ticked 2026-10-22 (ownedbind-lane).** On the owned engine (`pnpm parity --target desktop --engine threenative --only-tests soft-shadow-source-radius` and `--target web --engine threenative`, lane/ownedbind 829831f19, V8 engine player and the web Wasm engine, NVIDIA RTX 2080, reference = the upstream-three web capture) both pass: desktop pixelMismatchRatio 0.0159, deltaE 0.015; Wasm 0.0159, 0.015 (tolerance 0.08, 10). Before the fix the bundle stopped with TN_NATIVE_ENGINE_UNBOUND (core's soft-shadow.ts names cubeTexture, Stack, shadow and the depth compare constants); the V8 facade now binds the constants and refuses the three-only TSL names at use, as on Wasm (`native_engine_player_imports`, core-look entry).
- [x] AC-1 and AC-3 hold, with the sheets posted on the PR. proof: the AC-1 and AC-3 commands. — Evidence 2026-10-21: sheets and verdicts in PR #541 comment 6332486803 (L5 and L9, four poses, close-ups, cornell L6).
**Verification:** AC-1 to AC-3.

## Decisions

- 2026-10-22 (Phase 1, lamp-lane): the size rule is Unreal's, not a fitted curve. A lamp's footprint is a camera
  pixel's radius at the receiver's depth, projected into the lamp's map in mip-0 texels of a 16384² virtual map
  (`Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapProjectionCommon.ush:96-120`); the mip is
  floor(log2(footprint) + bias), clamped to 0 to 7 (`Engine/Shaders/Shared/VirtualShadowMapDefinitions.h:178-183`);
  the bias is 0 still and 1 moving at Epic (`Engine/Config/BaseScalability.ini:260-261`), lerped by a mobility
  factor that falls to 0 over the 10 frames after the lamp last moved (`Shadows/ShadowScene.cpp:20-25,199-217`). Our maps are
  dense, not paged, so the finest mip over the lamp's visible lit receivers sizes the whole map. A lamp seen for the first
  time is still (Unreal starts a movable light as moving), so a still lamp draws its first map once at its still size.
- 2026-10-22 (Phase 1): over the budget, Unreal raises one global bias for every light
  (`VirtualShadowMaps/VirtualShadowMapCacheManager.cpp:183-187,696-721`), not a per-lamp order. We take the smallest bias
  that fits, so the lamp nearest its next coarser mip steps first and a bias of 1 halves every map; the box text says so now
  in place of "the smallest footprint first". The budget is Epic's pool (4096 pages of 128², `BaseScalability.ini:257`)
  times the 0.85 load factor, held by the lamps alone because the sun has its own atlas. Each lamp keeps its own texture:
  one packed atlas would need cube faces in a 2D atlas and new shader addressing, and nothing measured asks for it yet.
- 2026-10-22 (Phase 1): `shadow.mapSize` at three's default 512² means "size it for me"; any other value is the game's
  override, kept and named in the renderer diagnostics. The C++ `LightShadow` cannot see a write of 512 through the
  `mapSize` alias, so an explicit 512² is still automatic. The compatibility fixtures `shadows-spot` and `shadows-point`
  now set 1024² so they keep proving three's PCF at a fixed size; their goldens were re-recorded.
- 2026-10-22 (Phase 1): the size rule ships in the owned engine only. `engine: "threejs"` keeps three's fixed `mapSize`:
  three gives a core helper no per-frame hook on a lamp's map without a ShadowNode subclass, and no game on that path asks.
- 2026-10-20 (slicing): the local-light half of PRD-457 Phase 3 (a many-light fixture and separate
  local-light counters) moves here, because this PRD builds the lamp atlas and cache that it would
  measure. PRD-457 keeps the directional page-cost gate.
- 2026-10-20 (slicing): the default `sourceRadius` is 0, as in Unreal, so a fresh lamp shadow is
  sharp. Softness is a game choice made in `src/render/`.
- 2026-10-20 (Phase 3): the radius rides on `sourceRadiusShadowFilter({ sourceRadius })` as
  `light.shadow.filterNode`, the shape of `sourceAngleShadowFilter`, because three's `LightShadow`
  has no field a filter could read. The browser cube compares each search tap at four depths
  (three r185 gives a depth texture one sampler, and WGSL has no integer load on a cube); the owned
  engine reads the cube's raw depths through a second, non-comparison binding.
- 2026-10-21 (Phase 3): the penumbra comes from the nearest blocker, not the average of every blocker
  in the cone. The first pass shrinks the cone to the nearest blocker's penumbra, and the last pass
  averages only the blockers whose own penumbra reaches the receiver. The average made spot-soft 1.9
  times as wide as Unreal's on `lamp-room` and 0.92 of the geometric width on `cornell`, so no one
  constant fitted both scenes. The receiver's own ray is a tap of every pass and counts whenever it
  is blocked: three's derived `shadowSide` stores back faces, which leaves a floor point behind a box
  with a blocker of no reach, and a 1 cm rod falls between the Vogel taps.
- 2026-10-21 (Phase 3): a lamp's depth pass stores back faces 8 depth steps nearer the lamp (`kLampBackFaceBias`). The `lamp-room` crate stands on the floor and its bottom face lies in the floor's plane. The -Y cube face stores the same axial depth for both, so a floor pixel beside the crate's far foot ties with the stored back face to the last bit. The tie lit a dotted line of single pixels along the foot, and with three's own filter it leaks 0.859 of the open floor behind cornell's tall box. The bias sits on the caster and not on the receiver. A lamp that culls front faces stores only the back faces of closed volumes, so the receiver's own surface is not in its map, while a receiver-side bias would shade every double-sided receiver. A front-face or double-sided map keeps bias 0, so `material.shadowSide` set to `FrontSide` or `DoubleSide` skips it. `engine: "threejs"` keeps the tie, since three's `ShadowNode` offers only the receiver-side bias.
- 2026-10-21 (Phase 3): `penumbraScale` is the share of the geometric penumbra a lamp keeps, in (0, 4].
  It defaults to 0.6, and 1 gives the geometric penumbra. Unreal's local-light ray test casts 8 rays
  of 4 samples at Epic (`Engine/Config/BaseScalability.ini:264-265`) and keeps 0.47 to 0.69 of the
  geometric width on `lamp-room` and `cornell`. Both engines take the value: the core filter and the
  owned engine's `ShadowPenumbraScale` uniform.
