---
prd_contract: v1
---

# PRD-633 — The sky is an atmosphere, and it lights the scene

**Status:** PARTIAL
**Priority:** P2 — shipped templates remain unchanged: every template's sky and ambient light come from a fixed photograph, so the sun cannot move and the sky never tints the scene the way Unreal's default level does.
**Complexity:** 6 (MEDIUM) — template sky source in 13 templates (+2), a core sky-capture mechanism with an amortized refresh (+2), native proof of the LUT sky and the capture (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-631](../../done/PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 3 (the L2 row) and [PRD-632](PRD-632-the-frame-is-exposed-and-tone-mapped-the-way-a-fresh-unreal-project-is.md) (lux and EV100: an atmosphere sky in nits cannot be compared at a hand-set exposure). Uses the LUTs that [PRD-248](../../done/PRD-248-the-atmosphere-is-luts-the-sky-is-the-games.md) shipped. [PRD-562](../rendering/PRD-562-aerial-perspective-from-a-froxel-volume.md) adds the aerial perspective on top.

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
**Status:** PARTIAL
**Files:** `packages/core/src/render/sky-capture.ts` (new), `packages/core/__tests__/sky-capture.spec.ts`
- [x] The capture refreshes after a sun move larger than its threshold, not before, and spreads one refresh over the configured frames. proof: `pnpm exec vitest run packages/core/__tests__/sky-capture.spec.ts` — 2026-10-19: 12 GPU-free tests pass (exit 0), including invalid options, PMREM target reuse, renderer-state restoration/retry, lower-hemisphere mask and idempotent disposal.
- [ ] The captured environment of a fixed sky matches a direct PMREM of the same sky within tolerance. proof: `pnpm exec vitest run packages/core/__tests__/sky-capture.spec.ts`.
  GPU equivalence, visual judging, native and moving-sun performance remain unverified; these unit tests stub PMREM and do not establish pixel equivalence.

#### Phase 2: The starter matches L2
**Status:** PARTIAL — the starter and five kits ship the atmosphere sky (2026-10-30); AC-1 and the low-tier box are open.
`scripts/unreal-look/scaffold/render/sky.ts` preserves the starter exports and fog, uses Atmosphere radiance, SkyCapture environment and transmittance-tinted sun without changing intensity. Core typecheck and Biome pass. Starter `npx --no-install tsc --noEmit -p .` passes in `/tmp/sky-capture-starter-eseo8qtr`, copied from the cached starter with its installed dependencies plus current SkyCapture source (cache is outside writable roots). The template import guard scans template roots only, so core imports remain confined to the harness overlay. Atmosphere has no separate Mie absorption parameter: the overlay supplies extinction 0.003996 + 0.000444; separate scattering/absorption remains a limitation.

2026-10-21 (lane/sky): the harness sky now uses Unreal's own sample counts: 10 segments for the transmittance pass, 15 for multiple scattering, 4 to 32 for the sky view and one fixed 8 x 8 draw of directions for the distant sky light (`atmosphere.ts`, mirrored in `gpuSky.ts`). The `VIEW_DISTANCE_SKY_LIGHT_FIT` constants are gone. The fog density carries the ln2 factor of Unreal's line integral. The sun light takes Unreal's CPU transmittance (`sunLightTransmittance`), while the disc and the clouds keep the LUT value. The sun disc is hidden while a reflection capture renders (`skyDisc`, `reflectionCapture.ts`). Measured on the reference ladder (84 region rows a layer, same pose and sun, two runs an arm that match bit for bit): mean deltaE L2 3.59 to 3.07, L3 3.90 to 3.36, L4 4.16 to 3.50. The sun-facing wall at a 4 degree sun goes from deltaE 11.0 to 7.4. The floors at 15 and 4 degrees are darker than before (exterior LitFloor L* -1.6 to -3.9 against Unreal). The old, brighter sun hid a floor deficit that also shows at L1, where the atmosphere is off (sun 15 LitFloor p50 160 against Unreal 172). That deficit is not a sky fault and stays open.
**Files:** `packages/create-threenative/templates/starter/src/render/{sky,lighting,heightFog}.ts`
- [x] The starter draws the atmosphere sky with Unreal's coefficients, a sun disk and a transmittance-tinted sun. proof: `pnpm exec vitest run packages/create-threenative/__tests__/atmosphere-sky.spec.ts` — 2026-10-30, branch `prd/633-sky-atmosphere` at `10120ed4c`: 5 tests pass (red on the photo template: 3 of 3 failed). Sun colour at 48° (0.941, 0.783, 0.665), at 4° (0.454, 0.157, 0.025). Visual judge round 2 (fresh Opus, L9, three suns, two runs per arm): IMPROVEMENT overall, exterior and spheres CLOSE at every sun; PR #595 comments 6537826434 and 6538860814.
- [ ] AC-1 passes on the starter. proof: `pnpm unreal-look:compare --layer L2`. 2026-10-30 (`--baseline`, Wasm engine): mean deltaE over the 60 L2 regions 15.74 (photo) to 3.52 (atmosphere), sky regions 12.42 to 0.40, 7 of 60 regions pass. Open: floors, walls and the chrome sphere are 2 to 18 deltaE off.
- [ ] The starter's `low` tier uses a sky-view LUT with no capture refresh, and the template gate passes. proof: `pnpm test:templates` (starter).

#### Phase 3: Every template, native included
**Status:** PARTIAL — action-rpg, minimal, racing, runner and shooter default to the atmosphere sky (`a0be645e1`); rts, tower-defense and sailing keep their photo (see Decisions). Kit judge round 2 (four kits, spawn view): NEUTRAL, no artifact. The shooter's spawn capture came back blank in one arm of each round (photo and atmosphere alike), so it has no judged frame yet.
**Files:** `packages/create-threenative/templates/*/src/render/sky.ts`, `packages/runtime-native/conformance/scenes/shared/atmosphere-sky-capture.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The atmosphere sky and its capture render on the desktop native engine within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests atmosphere-sky-capture`.
- [ ] All photo-sky templates default to the atmosphere sky, and the template gate passes. proof: `pnpm test:templates`.
- [ ] Every affected template's `AGENTS.md` (and mirror) states the atmosphere sky and its capture, with `sky: "photo"` as the override, so a new project's agent knows the default and how to override it. proof: `rg -l 'sky: "photo"' packages/create-threenative/templates/*/AGENTS.md` lists every affected template, and `pnpm sync:agents --check` exits 0.

- [ ] The height fog takes its colour from the atmosphere, not from a fixed palette grey: Unreal's fog has no colour of its own (`FogInscatteringLuminance` black, `SkyAtmosphereAmbientContributionColorScale` white, `Engine/Source/Runtime/Engine/Private/Components/ExponentialHeightFogComponent.cpp:76-78`). The L3 horizon band (rows 30-40 %, exterior, sun60) matches Unreal's colour within the PRD-631 threshold; on 2026-10-19 it measured Unreal (159,184,208) vs three.js (130,131,145). proof: `pnpm unreal-look:compare --layer L3`. 2026-10-20, Wasm engine at c0683da2c (fog colour from the cloudless atmosphere, capture `engine-l3`): band median (219,226,231) vs Unreal (168,191,209), ΔE76 15.9 — the band is now the right hue family but too pale; the sky just above the horizon is whitish where Unreal's is light blue. 2026-10-21, lane/sky commit (see Phase 2 note): the band median (rows 30-40 %, exterior) against Unreal is deltaE76 1.5 at sun 60 and 1.2 at sun 15 (before: 7.0 and 9.7), so the box stays open at the deltaE 1 threshold. Open: the sun-to-sky ratio is still a temporary fit (`SKY_TO_SUN`).

## Decisions

- **2026-10-30, prd633-sky lane: the templates bake the environment on the CPU, not through `SkyCapture`.** The default engine (Wasm/native) takes the environment only as CPU pixels: `Renderer::beginEnvironment` rejects a GPU-only texture, so a cube render plus PMREM cannot feed it. `gpuSky.ts` bakes a 64 x 32 equirectangular copy of the same atmosphere model (`bakeSkyRadiance`, clouds included; about 96 ms in node) when the sun moves, and the GPU sky-view LUT node draws the background with the sun disc and the clouds. `SkyCapture` stays in core for `engine: "threejs"` games; the Phase 1 equivalence box is open because no template uses it.
- **2026-10-30, prd633-sky lane: the environment's lower half is the sunlit ground (`SKY_OPTIONS.ground`, default on).** Unreal's default level fills the shadow sides and a mirror's lower half with Lumen's floor bounce; its own sky light has a dark nadir (sky pass `Ground = false`, `Engine/Shaders/Private/SkyAtmosphere.usf:1109`). The templates have no GI, so the bake draws the atmosphere's sunlit ground (`GROUND_ALBEDO`, the multiple-scattering term) below the horizon instead. Judge round 1 without it: NEUTRAL (navy shadow sides, black chrome lower half); round 2 with it: IMPROVEMENT. The harness turns it off below L7, where Unreal has no GI: with it on, L2 went 3.52 to 5.24 mean deltaE (backlit wall p50 175 against Unreal 51). Open: a uniform sunlit ground cannot shadow itself, so faces in front of a backlit wall read warm grey where Unreal is cool lavender; that needs GI in the templates. `ground: false` is the override for a game that adds its own.
- **2026-10-30, prd633-sky lane: rts, tower-defense and sailing keep their own sky for now.** rts lights from a hemisphere and has no `scene.environment`, tuned to its reference frame (PRD-765). tower-defense uses the photograph as environment only, with a dark void behind the diorama. sailing draws the photograph on its own dome above the ocean, with separate `SKY_RANGE` and `FILL_RANGE`. Each needs its own migration and judge against its reference; the "all photo-sky templates" box stays open and names them.

- **2026-10-22, team-lead (stable-epic triage): `lane/sky2` stays out of the stable epic.** PRD-721 supersedes this lane. The exposure line takes the exposure derivation and excludes the lens fit. Next step: complete PRD-721, `docs/PRDs/Unreal/look/PRD-721-the-exposure-line-lands-once-the-cloud-sky-light-matches-unreal.md`, on the exposure line.

- **2026-10-22, team-lead (stable-epic triage): `lane/brdf` stays out of the stable epic.** PRD-721 supersedes this lane. The exposure line takes the exposure derivation and excludes the lens fit. Next step: complete PRD-721, `docs/PRDs/Unreal/look/PRD-721-the-exposure-line-lands-once-the-cloud-sky-light-matches-unreal.md`, on the exposure line.

- **2026-10-22, team-lead (stable-epic triage): `lane/sky-lens` stays out of the stable epic.** Commit `074c7552d` stays out. PRD-721 supersedes this lane. The exposure line takes the exposure derivation and excludes the lens fit. Next step: complete PRD-721, `docs/PRDs/Unreal/look/PRD-721-the-exposure-line-lands-once-the-cloud-sky-light-matches-unreal.md`, on the exposure line.

- 2026-10-21: the sun light takes Unreal's coarser CPU transmittance, and the sky and the disc take the LUT's. Unreal tints the light with `FAtmosphereSetup::GetTransmittanceAtGroundLevel` (15 start-point segments from 500 m) and reads the 10-sample LUT for the sky, so the two differ by design (`SkyAtmosphereCommonData.cpp`, `SkyAtmosphereRendering.cpp`). The 4 degree green and blue of the L2 frame sit on the CPU value.
- 2026-10-21: a reflection capture draws no sun disc, as in Unreal (`SkyAtmosphereRendering.cpp`: `SourceDiskEnabled = bIsReflectionCapture ? 0 : 1`). The chrome sphere keeps the sky and its clouds and loses the hard flare. A one-pixel black hole at the sun glint of the chrome sphere (layers L7 to L9) is not the disc: it also shows with the disc off. It appears from L7 on, where the GI materials replace the originals, and its cause is not found.

- 2026-10-21 (Expand Gamut, measured): Unreal's EXR frames carry Expand Gamut 1 (`Engine/Source/Runtime/Engine/Private/Scene.cpp:437` default, applied in `Engine/Shaders/Private/PostProcessCombineLUTs.usf:371-395` before the NoToneCurve branch), and the harness tone map had `expandGamut: 0` (1c94a05f4). Unreal L2 sky rows over the CPU sky bake (x 14.7 x tint), exterior x 610 to 670: sun60 red 0.79 to 0.82 without expansion and 0.98 to 1.01 with it, green and blue within 1%. A brute-force single-scatter integrator matches the sky model within 1 to 3% at sun60, so the sky model is sound and the red excess is the tone map (gamut-lane owns the fix). With expansion the sky still reads 1 to 3% low in green and blue at sun15 and 3 to 6% at sun04 (blue most). A bilinear 256x64 transmittance LUT changes nothing; a multi-scatter gain of 1.5 fixes sun04 and breaks sun60, so the rest stays open and is not fitted.
- 2026-10-21 (L9 locks, c571a3727): the base holds all 15 present L9 locks; c571a3727 breaks 4 (sun60 exterior Sky dP50 0.0438, sun60 spheres Sky 0.0657, sun60 spheres Sphere_RoughDielectric 0.0452, sun15 spheres Floor 0.0539; limit 0.0392). The Sky locks come from the missing Expand Gamut, the Floor and dielectric locks from Lambert diffuse where Unreal shades with EON (brdf-lane, PRD-653). The harness keeps `SUN_ILLUMINANCE` and `EMISSIVE_UNITS` with a 0.78 lens-attenuation fit and `SKY_TO_SUN` 0.78 until roughDiffuse lands; the fold-in is one commit. PR #541 comment 6331235132.

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
- 2026-10-19 (owner impressions, measured): "three.js horizon is grey, Unreal's is ocean blue". Unreal's
  level has no sky sphere and no ocean (`template-actors.json`); the blue band is its height fog lit
  by the atmosphere. Turning fog on moves Unreal's horizon from saturation 0.07 to 0.24; three.js's
  fog moves nothing measurable (L2 = L3). A box above owns it.
