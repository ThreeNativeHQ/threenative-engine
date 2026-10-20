---
prd_contract: v1
---

# PRD-562 — Distant land takes the colour of the sky it is seen through

**Status:** NOT STARTED
**Priority:** P2 — AC-1 to AC-3 are open: `Atmosphere.aerialPerspective` mixes every pixel toward one zenith colour, and no template uses the atmosphere at all.
**Complexity:** 4 (MEDIUM) — 1–5 implementation files (1), a new GPU resource with per-frame view-space state (+2), template adoption (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-633](../look/PRD-633-the-sky-is-an-atmosphere-and-it-lights-the-scene.md) puts the atmosphere in the templates; the match proof is the L3 row of [PRD-631](../look/PRD-631-an-unreal-reference-scene-measures-the-default-look.md). Builds on the LUT stack that [PRD-248](../../done/PRD-248-the-atmosphere-is-luts-the-sky-is-the-games.md) shipped. Composes with [PRD-560](../../done/PRD-560-height-fog-follows-the-ground.md) height fog: this PRD is kilometre-scale air, and PRD-560 is ground mist.

## Context

`packages/core/src/atmosphere/` already builds the Hillaire-style LUTs: transmittance 256×64,
multi-scattering 32×32 and sky-view 192×108 (`luts.ts:34-37`). Its aerial-perspective method
(`index.ts:233-253`) does not use them for the haze:

- The haze amount is `1 - exp(-distanceKm × extinction)`, where `extinction` is one scalar, the mean
  of the Rayleigh and Mie coefficients. It is clamped at 0.98.
- The haze colour is one sample, `radiance(vec3(0, 1, 0))`, the zenith, unless the game passes its own.
  So distant land toward the sun and away from the sun hazes to the same colour. A low sun does not
  warm the far hills, and a looking-down view hazes like a looking-up view.

No template constructs `Atmosphere`, and no game calls its `aerialPerspective` method
(`rg "aerialPerspective"`, 2026-10-12). One example builds an `Atmosphere`:
`examples/strata-terrain-preview/src/render/atmosphere.ts:26`. It writes its own depth-reconstructed
haze at `atmosphere.ts:87`, because the method above gives it no direction or height term. The starter
mist disables aerial perspective while it lives
(`packages/create-threenative/templates/starter/src/render/volumetricFog.ts:54`). [PRD-VQ-07](../../done/PRD-VQ-07-volumetric-fog.md)
deliberately shipped "no mandatory froxel engine" for local mist. This PRD adds one small
view-space volume for atmosphere-scale haze only. It is not a general volumetric-fog grid.

### What Unreal does (UE 5.8.3, read 2026-10-09)

- **A camera-aligned 3D volume holds in-scattered light (RGB) and transmittance (A).** The defaults
  are 32×32 texels across the screen, 16 depth slices over 96 km, and at most 2 ray-march samples per
  slice. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/SkyAtmosphereRendering.cpp:180-196`.
  Unreal fixes the range at 96 km. It does not follow the camera far plane. Beyond the range, it
  reuses the last slice (cvar text at `SkyAtmosphereRendering.cpp:183-185`).
- **The slices are spaced by the square root of distance,** so near slices are thin and far slices
  are thick. A lookup converts linear depth to a slice coordinate with `sqrt`.
  `UE 5.8.3: Engine/Shaders/Private/SkyAtmosphereCommon.ush:66-72`.
- **Near the camera, the contribution fades to zero** under the first half slice, and over a near
  fade range, so the camera's own position is never hazed.
  `UE 5.8.3: Engine/Shaders/Private/SkyAtmosphereCommon.ush:74-81`.
- **The apply step is one trilinear 3D fetch per pixel.** Colour scales by the fade weight, and
  alpha keeps the transmittance consistent.
  `UE 5.8.3: Engine/Shaders/Private/SkyAtmosphereCommon.ush:104-108`.
- **Scalability:** the lowest effects tier (`EffectsQuality@0`) uses 8 slices and 1 sample per slice. The next tier
  uses 16 slices and 1 sample. The tier after that uses 16 slices and 2 samples.
  `UE 5.8.3: Engine/Config/BaseScalability.ini:812-814, 841-843, 870-872`.

## Solution

**The volume is mechanism. The look stays the game's.**

- `Atmosphere` gains the volume as a compute pass that it owns, beside its LUTs:
  - The texture is a 32×32×N `rgba16float` storage 3D texture, where N is 16, or 8 at the `low`
    tier.
  - Each texel integrates in-scatter and transmittance along its view ray, from the camera to its
    slice depth, using the existing transmittance and multi-scattering LUTs. The sun direction is the
    one the game already passes.
  - The pass runs once per frame, because the volume follows the view.
- **Auto by default:** the volume's depth range comes from the camera's `far`, so a game sets no
  depth constant. A named `aerialPerspectiveDepth` override exists, and `TN_ATMOSPHERE` reports the
  depth it used and where the value came from.
- `aerialPerspective(scenePass, depth, inScatteredRadiance?)` keeps its signature. Its body samples
  the volume with the square-root slice mapping and the near fade. The single-zenith-sample body is
  deleted, because no template or example consumes it. The optional `inScatteredRadiance` now
  scales the volume's in-scatter instead of replacing it. It stays the game's tint and exposure hook,
  so the package still decides no colour.
- **First consumer: the racing template.** Its eye-level haze reference is `FogExp2` density 0.0024,
  and its `FogExp2` density is now lowered by `distanceDensity()` in `sky.ts` because
  [PRD-560](../../done/PRD-560-height-fog-follows-the-ground.md) added `heightFog.ts`. The racing
  template keeps its photographed sky and background. It adds an `Atmosphere` for the haze only, in
  its own `src/render/sky.ts` and `postprocessing.ts`, tinted toward the photograph's horizon through `inScatteredRadiance`. Slice count
  and tint per tier live in its `quality.ts`.

Risks:

- three's compute path must write a 3D storage texture on WebGPU and on the native host. Phase 3
  proves the native side.
- Double haze with PRD-560 height fog. The racing template calibrates both against one judged
  capture, and neither term is removed silently.

## Acceptance Criteria

- [ ] AC-1 [local]: The racing frame with volume aerial perspective is judged at or above the current photographed-sky `FogExp2` frame, and far terrain toward a low sun reads warmer than far terrain away from it. proof: `pnpm visuals:ab --before <current racing> --after <volume AP racing> --raters 3` — Evidence: pending.
- [ ] AC-2 [local]: The volume compute and apply cost at most 0.3 ms GPU together at 1080p on the RTX 2080 browser WebGPU lane. proof: `TN_FRAME_BUDGET` p50 delta from `node packages/playtest/dist/runner/cli.js perf`, aerial perspective on against off — Evidence: pending.
- [ ] AC-3 [local]: On the Pixel 8 at the `low` tier (8 slices), they cost at most 0.5 ms GPU. proof: `node packages/playtest/dist/runner/cli.js perf --logcat <serial>`, on against off — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Aerial-perspective volume | racing `src/render/postprocessing.ts` → `atmosphere.aerialPerspective(scenePass, depth)` → volume compute + 3D fetch | Replaces the single-zenith-sample body of `index.ts:233-253`, which no game calls. The strata example's own composite (`atmosphere.ts:87`) is a later candidate to delete | Phase 1, AC-1 |

## Execution Phases

#### Phase 1: The volume in the core atmosphere
**Status:** NOT STARTED
**Files:** `packages/core/src/atmosphere/index.ts`, `packages/core/src/atmosphere/luts.ts`, `packages/core/__tests__/atmosphere.spec.ts`
- [ ] The slice mapping round-trips depth to slice coordinate and back within 0.1% across the depth range. The near fade is 0 at the camera and 1 past the first half slice. proof: `pnpm exec vitest run packages/core/__tests__/atmosphere.spec.ts`.
- [ ] The volume is created as 32×32×16 `rgba16float` (8 slices at `low`), its depth follows `camera.far` unless overridden, and `TN_ATMOSPHERE` reports both values. proof: `pnpm exec vitest run packages/core/__tests__/atmosphere.spec.ts`.

#### Phase 2: Racing adopts it
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/racing/src/render/sky.ts`, `packages/create-threenative/templates/racing/src/render/postprocessing.ts`, `packages/create-threenative/templates/racing/src/render/quality.ts`, `packages/create-threenative/templates/racing/AGENTS.md` (and mirror)
- [ ] The racing template renders volume aerial perspective over its photographed sky, and the template gate passes. proof: `pnpm test:templates` (racing).
- [ ] The starter L3 cells (height fog plus aerial perspective) match the Unreal L3 cells within the PRD-631 thresholds. proof: `pnpm unreal-look:compare --layer L3`.

#### Phase 3: Native
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/aerial-perspective.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The desktop native host fills the volume to match the browser reference within tolerance for a fixed camera and sun. proof: `pnpm parity --target desktop --only-tests aerial-perspective`.

## Decisions

- 2026-10-12 (Unreal source review): The Context claim "no example constructs `Atmosphere`" was wrong. `examples/strata-terrain-preview` builds one and hand-writes its own haze, so the method has a second, unserved caller. The plan stays the same. The strata composite is a follow-up candidate, not a box here.
- 2026-10-12 (Unreal source review): Unreal fixes the volume range at 96 km and reuses the last slice beyond it. This PRD keeps the range at `camera.far` because a game sets no constant. The racing frame must still show haze past `far`, so the apply step clamps the slice coordinate to 1 and does not fade to clear.
- 2026-10-12 (Unreal source review): Template paths in this PRD now name the real folder, `packages/create-threenative/templates/`.
- 2026-10-19 (PRD-631 reference plan): Layer L3 of the Unreal reference ladder is height fog plus aerial perspective, so this PRD owns that row. Unreal's default height fog is density 0.02 and falloff 0.2, each divided by 1000 in the renderer per centimetre (`Engine/Source/Runtime/Engine/Private/Components/ExponentialHeightFogComponent.cpp:92`; `Engine/Source/Runtime/Renderer/Private/SceneCore.cpp:404`). That is 0.002 per metre and a 0.02 per metre falloff. The starter uses 0.0021 and 0.08 per metre (`templates/starter/src/render/heightFog.ts:27`), so the density already matches and the falloff is four times steeper. Unreal's volumetric fog is off by default (`ExponentialHeightFogComponent.h:136`), so the starter mist staying off matches, and L3 does not include it. Added one Phase 2 box.
