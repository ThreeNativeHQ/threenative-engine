---
prd_contract: v1
---

# PRD-633 — The sky is an atmosphere, and it lights the scene

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: every template's sky and ambient light come from a fixed photograph, so the sun cannot move and the sky never tints the scene the way Unreal's default level does.
**Complexity:** 6 (MEDIUM) — template sky source in 13 templates (+2), a core sky-capture mechanism with an amortized refresh (+2), native proof of the LUT sky and the capture (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-631](PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 3 (the L2 row) and [PRD-632](PRD-632-the-frame-is-exposed-and-tone-mapped-the-way-a-fresh-unreal-project-is.md) (lux and EV100: an atmosphere sky in nits cannot be compared at a hand-set exposure). Uses the LUTs that [PRD-248](../../done/PRD-248-the-atmosphere-is-luts-the-sky-is-the-games.md) shipped. [PRD-562](../rendering/PRD-562-aerial-perspective-from-a-froxel-volume.md) adds the aerial perspective on top.

## Context

Unreal's default level draws its sky from the **Sky Atmosphere** component. A **Sky Light** captures
that sky and lights the scene with it, and the sun is a Directional Light marked as the atmosphere
sun, tinted by the air it passes through. When the sun goes down, the sky, the ambient light and the
sun colour all change together. That coupling is a large part of the Unreal look.

**ThreeNative today:**

- Every photographed-sky template uses one Poly Haven JPEG, "Kloofendal 48d Partly Cloudy (Pure
  Sky)". It is the background, `scene.environment` through PMREM at intensity 2.5, the fog colour
  and the sun direction (`packages/create-threenative/templates/starter/src/render/sky.ts:4-46`).
  The sun disk is clipped in the JPEG.
- `packages/core/src/atmosphere/` builds Hillaire-style LUTs: transmittance 256×64, multiple
  scattering 32×32, sky view 192×108 (`luts.ts:27`). It exposes `radiance()` and
  `sunTransmittance()` (`index.ts:200-224`). No template constructs it.
- Nothing captures a procedural sky into `scene.environment`. Nothing tints the sun by atmospheric
  transmittance.

**Unreal 5.8.3** (source read 2026-10-19; the default level's values come from PRD-631's
`template-actors.json`):

| Setting | Default | Source |
| --- | --- | --- |
| Planet | Bottom radius 6360 km, atmosphere height 60 km, ground albedo about 0.4 linear | `Engine/Source/Runtime/Engine/Private/Components/SkyAtmosphereComponent.cpp:95-102` |
| Rayleigh | (0.005802, 0.013558, 0.033100) per km, scale height 8 km | `SkyAtmosphereComponent.cpp:98,108` |
| Mie | Scattering 0.003996 per km, absorption 0.000444 per km, scale height 1.2 km, anisotropy 0.8 | `SkyAtmosphereComponent.cpp:99,113` |
| Ozone | (0.000650, 0.001881, 0.000085) per km, tent peak at 25 km, width 15 km | `SkyAtmosphereComponent.cpp:120` |
| Multiple scattering | Factor 1 | `SkyAtmosphereComponent.cpp:128` |
| LUTs | Transmittance 256×64 (10 samples), multiple scattering 32×32 (15 samples), sky view 192×104 | `Engine/Source/Runtime/Renderer/Private/SkyAtmosphereRendering.cpp:135-247` |
| Sky light | Cubemap 128, lower hemisphere black, intensity 1. Real-time capture is false in the constructor. The default level's value is read in PRD-631 | `Engine/Source/Runtime/Engine/Private/Components/SkyLightComponent.cpp:309-331` |
| Sun | Atmosphere sun light, source angle 0.5357° | `Engine/Source/Runtime/Engine/Private/Components/DirectionalLightComponent.cpp:1050,1066` |

## Solution

1. **The atmosphere sky in template source.** Each template's `src/render/sky.ts` constructs
   `Atmosphere` with Unreal's coefficients as its starting values. The coefficients are a look,
   so they live in the template. The sky mesh samples `radiance()`. A sun disk is drawn from the
   sun's angular size and its transmittance. The directional light colour is
   `sunTransmittance(sunDirection)` times the sun's lux. The photo sky stays a named override:
   `sky: "photo"` in the template.
2. **A sky capture in core.** `SkyCapture` renders the atmosphere into a small cube (128 per face,
   to match Unreal) and prefilters it into `scene.environment`. Before it is written, the Phase 1
   capability search must show that no installed system already does this. The capture owns
   three things:
   - when to refresh: after the sun moves by more than a measured angle, never on a timer
   - spreading one refresh over several frames, so a sun moving every frame costs no frame spike
   - a black lower hemisphere, as in Unreal

   The appearance comes from the game's sky node. Core supplies only the mechanism.
3. **Fog colour follows the atmosphere.** The height fog takes its colour from the sky's horizon
   radiance, not from a sample of the photo.

## Acceptance Criteria

- [ ] AC-1 [local]: The starter L2 cells match the Unreal L2 cells within the PRD-631 thresholds in all 12 poses. proof: `pnpm unreal-look:compare --layer L2` — Evidence: pending.
- [ ] AC-2 [local]: At a 4° sun, the sky region and the lit floor both shift warm as in the Unreal cells: median colour difference within threshold per region. proof: `pnpm unreal-look:compare --layer L2 --sun 4` — Evidence: pending.
- [ ] AC-3 [local]: A sun moving 1° per frame costs no frame above the `high` budget, with the capture spread over frames. proof: `node packages/playtest/dist/runner/cli.js perf` on a moving-sun scenario — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Atmosphere sky in templates | `templates/*/src/render/sky.ts` → `new Atmosphere(...)` | Replaces the photo sky as the default. `sky: "photo"` stays as the named override | Phase 2 |
| `SkyCapture` | `sky.ts` → `scene.environment = capture.texture` | Replaces the PMREM of the fixed JPEG | Phase 1 |
| Transmittance-tinted sun | `lighting.ts` → `sunTransmittance()` | Replaces `0xfff1e0` | Phase 2 |

## Execution Phases

#### Phase 1: The sky capture
**Status:** NOT STARTED
**Files:** `packages/core/src/render/sky-capture.ts` (new), `packages/core/__tests__/sky-capture.spec.ts`
- [ ] The capture refreshes after a sun move larger than its threshold, not before, and spreads one refresh over the configured frames. proof: `pnpm exec vitest run packages/core/__tests__/sky-capture.spec.ts`.
- [ ] The captured environment of a fixed sky matches a direct PMREM of the same sky within tolerance. proof: `pnpm exec vitest run packages/core/__tests__/sky-capture.spec.ts`.

#### Phase 2: The starter matches L2
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/starter/src/render/{sky,lighting,heightFog}.ts`
- [ ] The starter draws the atmosphere sky with Unreal's coefficients, a sun disk and a transmittance-tinted sun, and AC-1 passes. proof: `pnpm unreal-look:compare --layer L2`.
- [ ] The starter's `low` tier uses a sky-view LUT with no capture refresh, and the template gate passes. proof: `pnpm test:templates` (starter).

#### Phase 3: Every template, native included
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/sky.ts`, `packages/runtime-native/conformance/scenes/shared/atmosphere-sky-capture.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The atmosphere sky and its capture render on the desktop native engine within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests atmosphere-sky-capture`.
- [ ] All photo-sky templates default to the atmosphere sky, and the template gate passes. proof: `pnpm test:templates`.
- [ ] Every affected template's `AGENTS.md` (and mirror) states the atmosphere sky and its capture, with `sky: "photo"` as the override, so a new project's agent knows the default and how to override it. proof: `rg -l 'sky: "photo"' packages/create-threenative/templates/*/AGENTS.md` lists every affected template, and `pnpm sync:agents --check` exits 0.

## Decisions

- 2026-10-19: Atmosphere coefficients and the sun disk are a look, so they go in template source.
  The capture refresh is plumbing every game repeats, so it goes in core.
- 2026-10-19: Stylised templates (platformer's gradient sky, sailing's dome) keep their own sky if
  PRD-631 shows that the atmosphere sky does not suit them. Each such template is recorded here by
  name.
- 2026-10-19 (external visual review, checked): the starter ties `scene.environmentIntensity` to
  `scene.backgroundIntensity` (both `SKY_RANGE` = 2.5, `templates/starter/src/render/sky.ts:50,61`),
  so the sky fill is too strong against the sun and shadows wash out. The atmosphere sky fixes the
  ratio by construction: the environment comes from `SkyCapture` of the same atmosphere the sun
  lights, at Unreal's sun lux, never from a separate intensity knob.
