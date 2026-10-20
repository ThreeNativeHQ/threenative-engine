---
prd_contract: v1
---

# PRD-650 — A lamp's shadow is as sharp as the pixels it covers, and softens with the lamp's size

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: spot and point shadows use one fixed map per light, redrawn every frame, with a filter width that ignores the lamp's size, while Unreal sizes each lamp's shadow from the pixels it covers, caches it and widens its penumbra with the source radius.
**Complexity:** 7 (HIGH) — 6–10 files across core and the native engine (+2), a per-light resolution choice and a per-light cache are new state (+2), the native engine and the browser are separate build boundaries (+2), native proof (+1); risk override: a per-light cache must never show a stale shadow, so Phase 2 proves invalidation before any visual claim.
**Owner:** João
**Depends on:** [PRD-649](PRD-649-shadow-calibration-scenes-are-built-in-unreal-and-judged-until-parity.md) Phase 2 (the `lamp-room` scene and `swing` run). Builds on the source-angle filter of [PRD-634](../look/PRD-634-sun-shadows-reach-the-horizon-and-soften-with-distance-from-the-caster.md) Phase 2. Takes over the local-light scope of [PRD-457](../rendering/PRD-457-virtual-shadows-scale-by-measurement.md) Phase 3 (see `## Decisions`). Coordinates with [PRD-VQ-06](../../rendering/PRD-VQ-06-many-local-lights.md), which owns unshadowed light lists.

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
   [PRD-572](../../done/PRD-572-shadow-casters-sort-themselves-into-static-and-moving.md): moving
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

- [ ] AC-1 [local]: On `lamp-room` at `high`, a PRD-647 round returns no REGRESSION against BEFORE, and MATCH or CLOSE against Unreal on `spot`, `spot-soft`, `point` and `rod`. proof: `pnpm unreal-look:calibrate --scene shadow:lamp-room --tier high --before <commit>` — Evidence: pending.
- [ ] AC-2 [local]: In the `swing` run, a still lamp redraws its map 0 times in frames 0 to 59 and after frame 130, and the moving box's shadow never lags its box by more than 1 frame. proof: `pnpm unreal-look:calibrate --scene shadow:lamp-room --run swing` with the `TN_SHADOW_REFRESH` counters — Evidence: pending.
- [ ] AC-3 [local]: The `spot-soft` penumbra width is within 25% of Unreal's at the 10 cm radius. proof: `pnpm unreal-look:compare --scene shadow:lamp-room --metric penumbra` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Footprint-sized lamp atlas | Any `SpotLight` or `PointLight` with `castShadow` | Replaces the fixed per-light `shadow.mapSize`, which becomes a reported override | Phase 1 |
| Per-lamp cache | The same lights, every frame | Replaces the every-frame redraw | AC-2 |
| `light.shadow.sourceRadius` | `templates/*/src/render/` lamp setup | Replaces the fixed 5-tap footprint for lamps | AC-3 |

## Execution Phases

#### Phase 1: Resolution follows the footprint
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/renderer.cpp`, `packages/runtime-native/src/engine/renderer/shadows/` (lamp atlas), `packages/three-native/src/` (the override report), native engine tests
- [ ] A lamp 2 m from the camera gets a finer map than the same lamp at 20 m, a moving lamp is one step coarser, and an over-budget atlas steps the smallest footprint down first. proof: red-green native engine test `native_engine_lamp_atlas`.
- [ ] `lamp-room/rod` on the owned engine shows the 1 cm rod's shadow, which the fixed 512 map loses. proof: `pnpm unreal-look:calibrate --scene shadow:lamp-room --tier high --before <commit>` (cell `rod`).

#### Phase 2: A cache per lamp
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/renderer.cpp`, `packages/core/src/render/` (shared caster sort), native engine tests
- [ ] A still lamp with still casters redraws 0 times over 300 frames, a caster moving inside its radius redraws it, and a caster moving outside its radius does not. proof: red-green native engine test `native_engine_lamp_cache`.
- [ ] The shadow markers report lamp redraws and lamp shadow GPU time apart from the sun's levels, and the totals reconcile with the renderer's shadow submissions on one mixed-light frame. proof: red-green parser test in `packages/core/__tests__/virtual-shadow.spec.ts`.
- [ ] AC-2 holds. proof: the AC-2 command.

#### Phase 3: `sourceRadius`
**Status:** IN PROGRESS
**Files:** `packages/core/src/render/soft-shadow.ts`, `packages/core/__tests__/soft-shadow.spec.ts`, `packages/runtime-native/src/engine/shader/standard.cpp`, `packages/runtime-native/conformance/registry.json`
- [x] The perspective and cube filters widen linearly with the caster gap and with `sourceRadius`, and fall to one hard tap at 0. proof: `pnpm exec vitest run packages/core/__tests__/soft-shadow.spec.ts`. — Evidence 2026-10-20: `sourceRadiusShadowFilter` (core TSL, spot and point) and the owned engine's `lampSoftShadowFactor`; soft-shadow.spec.ts 6/6 (`lampPenumbraTangent` doubles with the gap and the radius, 0 at radius 0), shadow-node.spec.ts 6/6; red-green native test `native_engine_lamp_source_radius`: a 1 m penumbra at radius 0.5 m measures 0 px with the filter selection off, 7 px (point cube) and 8 px (spot) with it on; three's PCF and radius 0 measure 0 px.
- [ ] The native engine matches the browser within tolerance. proof: `pnpm parity --target desktop --only-tests soft-shadow-source-radius`.
- [ ] AC-1 and AC-3 hold, with the sheets posted on the PR. proof: the AC-1 and AC-3 commands.
**Verification:** AC-1 to AC-3.

## Decisions

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
