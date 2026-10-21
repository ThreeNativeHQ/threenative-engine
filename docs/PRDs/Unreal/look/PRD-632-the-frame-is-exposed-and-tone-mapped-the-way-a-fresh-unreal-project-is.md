---
prd_contract: v1
---

# PRD-632 — The frame is exposed and tone-mapped the way a fresh Unreal project is

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: the templates tone-map with stock three.js ACES at a hand-set exposure, auto exposure is off, and no light carries a physical unit.
**Complexity:** 6 (MEDIUM) — template render source in 13 templates (+2), a new tone curve that must also run on the native engine (+2), physical light units that change every authored intensity (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-631](PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 3 (the L1 and L9 rows). Turns on the histogram meter that [PRD-571](../../BLOCKED/requires-physical-device/PRD-571-exposure-meters-a-histogram-and-ignores-the-sun.md) shipped opt-in.

## Context

Tone and exposure set the brightness and the colour of every other layer. They are layer L1 of the
PRD-631 ladder, so this PRD runs first.

**ThreeNative today** (starter `high`, `packages/create-threenative/templates/starter/src/render/`):

- Stock three.js `ACESFilmicToneMapping` (`worldEnvironment.ts:79`): the rational RRT/ODT fit, with
  exposure divided by 0.6. The C++ engine ports the same fit (`packages/runtime-native/src/engine/shader/tonemap.cpp:27`).
- A fixed exposure multiplier of 0.62, applied before bloom (`quality.ts:104`). Other templates use
  0.60, 0.66 and 0.9.
- Auto exposure is off. The histogram meter in `exposure.ts` / `exposureGraph.ts` ships in generated
  source with a 10/90 percentile, 2 stops/s opening and 4 stops/s closing, limits of ±12 stops, and
  a `1 + uv.y` weight.
- The sun is `DirectionalLight(0xfff1e0, 4.5)`, "matched by eye" (`lighting.ts:19`). The sky photo
  and environment are scaled by 2.5. No intensity has a unit.

**Unreal 5.8.3, fresh desktop project** (source read 2026-10-19):

| Setting | Default | Source |
| --- | --- | --- |
| Tonemapper | Filmic: slope 0.88, toe 0.55, shoulder 0.26, black clip 0, white clip 0.04 | `Engine/Source/Runtime/Engine/Private/Scene.cpp:440-448` |
| Gamut and blue | Expand gamut 1, blue correction 0.6, tone curve amount 1 | `Scene.cpp:436` |
| Curve shape | Log-domain straight segment with sigmoid toe and shoulder in AP1, plus glow and desaturation steps. It is not a rational fit | `Engine/Shaders/Private/TonemapCommon.ush:110-206` |
| Auto exposure | On, histogram method | `Engine/Source/Runtime/Engine/Private/SceneView.cpp:183-190` |
| Range | −10 to +20 EV100 ("extend default luminance range", set by the project generator) | `Scene.cpp:500-505`; `Engine/Source/Editor/GameProjectGeneration/Private/GameProjectUtils.cpp:148` |
| Metering | Ignore the lowest 10% and the highest 10% of the histogram | `Scene.cpp:494` |
| Speed | 3 stops/s brightening, 1 stop/s darkening | `Scene.cpp:520` |
| Bias | +1 EV | `SceneView.cpp:197`; `Scene.cpp:516` |
| Physical camera | Applied: 1/60 s, ISO 100, f/4; lens attenuation 0.78 | `Scene.cpp:490,523,607`; `Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessEyeAdaptation.cpp:104` |
| Light units | Sun in lux, point lights in candela | `Engine/Source/Runtime/Engine/Private/SceneView.cpp:248` |

Two gaps follow. **The curve:** ACES compresses the highlights and saturates the shadows
differently from Unreal's filmic curve. **Exposure:** a fixed 0.62 cannot follow a scene from noon
to a room interior, and Unreal adapts by default.

### Where the change goes

The tone curve and the exposure settings decide how the frame looks. Under the root `AGENTS.md`
rule "(b) vetoes (a)", they ship as generated source in each template's `src/render/`, not in
`packages/core`. Light units are different: converting lux and EV100 to a renderer multiplier is
plumbing every game repeats, so it belongs in core, with the values chosen in template source.

## Solution

1. **A filmic tone node in template source.** Write a TSL function with Unreal's parameters: slope,
   toe, shoulder, black clip and white clip, using the published straight-line-plus-sigmoid shape.
   Write it from the description, not from Unreal code. Add it as `tonemapMode: "filmic"` next to
   `aces`, `agx` and `neutral`, and make it the template default only after Phase 3. A game keeps
   `"aces"` as the named override.
2. **Exposure in EV100.** Core converts EV100 to the renderer multiplier with the standard
   photometric formula: exposure = 1 / (1.2 × 2^EV100). The physical-camera term and the lens
   attenuation are measured on the L1 cells, not assumed. The template sets the sun in lux and the
   sky in nits, read from PRD-631's `template-actors.json`. A game that sets a unitless intensity
   still works, and `TN_RENDER_CHAIN` reports that the frame is unitless.
3. **Auto exposure on by default** with Unreal's metering: 10/90 percentiles, 3 stops/s brightening
   and 1 stop/s darkening, the −10 to +20 range and the +1 bias. The PRD-571 histogram already
   implements the percentiles. This PRD changes its speeds, its range and its default. The
   `1 + uv.y` weight stays, because Unreal has no counterpart and the sky test passes without it.
   The `low` tier keeps a fixed exposure, set to the metered mean of its scene.

## Acceptance Criteria

- [ ] AC-1 [local]: The L1 cells of the starter match the Unreal L1 cells within the PRD-631 thresholds, in all 12 poses. proof: `pnpm unreal-look:compare --layer L1` — Evidence: pending.
- [ ] AC-2 [local]: With the sun moved from 60° to 4°, the adapted exposure of the starter follows the Unreal L9 exposure within 0.5 EV in each pose. proof: `pnpm unreal-look:compare --layer L9 --metric exposure` — Evidence 2026-10-21 (open, measured): Unreal exposure shift per cell = median EV of the Floor region in the L9 EXR minus the same in the L8 EXR (`captures/unreal`, real-time frames). Engine shift = the last `TN_AUTO_EXPOSURE` `exposureStops` of the cell in the capture log (`lockcap`, lane head 6ebcc8f6c). Engine minus Unreal, in EV: sun60 exterior +0.07, sun60 spheres +0.15, sun60 backlit +0.30, sun15 exterior +0.08, sun15 spheres +0.33, sun04 exterior -0.28, sun04 spheres -0.20, sun15 backlit -0.41, sun04 backlit -0.69. So 8 of 9 cells hold 0.5 EV and sun04 backlit does not. The error has a pattern: the engine exposure spans 2.76 stops from sun60 to sun04 exterior, Unreal 3.11. The engine meters a frame that varies less with the sun than Unreal's, so the HDR sky or ambient level is the next suspect. The engine writes no EXR, so the cause needs an engine HDR dump (not built). The `--metric exposure` column for the engine shows a dash for that reason.
- [ ] AC-3 [local]: A visual judge subagent returns IMPROVEMENT for the filmic, auto-exposed starter against the current starter, with the Unreal frames as the target. proof: judge verdict on the PRD-631 contact sheet, recorded here — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Filmic tone node | `templates/*/src/render/worldEnvironment.ts` → `tonemapMode: "filmic"` | Replaces `"aces"` as the template default. ACES stays as the named override | Phase 2 |
| EV100 exposure and light units | `templates/*/src/render/lighting.ts` sets lux; core converts | Replaces the hand-set `exposure: 0.62` and `DirectionalLight(…, 4.5)` | Phase 2 |
| Auto exposure default | `templates/*/src/render/exposure.ts` `enabled: true` at `high` and `medium` | Replaces PRD-571's opt-in default | Phase 3 |

## Execution Phases

#### Phase 1: The curve and the units
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/starter/src/render/tonemap.ts` (new), `packages/core/src/render/exposure-units.ts` (new), `packages/core/__tests__/exposure-units.spec.ts`
- [ ] The filmic node maps the scene-linear L1 EXR cells to the Unreal L1 PNG cells within the thresholds when both use the same exposure. This isolates the curve. proof: `pnpm unreal-look:curve --layer L1 --out tools/unreal-reference/captures/curve-l1` then `pnpm unreal-look:compare --layer L1 --threenative tools/unreal-reference/captures/curve-l1`. Result 2026-10-20 (Track A, CPU only, Unreal EXR to our `filmicToneMap` to sRGB, against the Unreal PNG): with the shipped `expandGamut: 1` 81 of 84 region rows pass, worst deltaE 11.63 and worst dP50 0.138 (Box_Red, three spheres cells); with `--gamut 0` 81 of 84 pass, worst deltaE 1.66 and worst dP50 0.0136 (the same three Box_Red rows, thresholds 1 and 0.01). L2 with gamut 1: 44 of 84, worst deltaE 9.27; with gamut 0: 60 of 84, worst deltaE 2.28, the misses are one 8-bit level in shadows (dP50 0.03 on a value near 30). A per-pixel fit of the expansion amount over 354 L1 and L2 samples gives 0 for every pixel that is not clipped (the emitter clips in all channels, so it fixes nothing), so a fresh Unreal frame carries no gamut expansion that our amount function reproduces. Pre and post saturation (0.96, 0.93) are already the best of a 25-point grid (RMS 1.48 levels). Box stays open: three rows miss the thresholds by 1.5 deltaE and the harness default is not yet set to 0 (needs the L2 sky captures first, because the sky red excess that the expansion hid comes back).
- [x] EV100 to multiplier round-trips, and the defaults convert as stated. proof: `pnpm exec vitest run packages/core/__tests__/exposure-units.spec.ts`. Result 2026-10-19: 3/3 pass (round trip; EV0 -> 1/1.2; f/4 1/60 s ISO 100 -> log2(960); RangeError on bad input).
- [ ] The curve applies Unreal's blue correction (0.6) and gamut expansion (default 0, 1.0 as the named override, see Decisions 2026-10-21) before the tone curve, so a saturated blue sky stays blue instead of shifting toward purple. proof: `pnpm exec vitest run packages/create-threenative/__tests__/tonemap.spec.ts` on the JS reference, then the L1 sky region inside thresholds with `pnpm unreal-look:compare --layer L1`.

#### Phase 2: The starter matches L1
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/starter/src/render/{quality,lighting,sky,worldEnvironment,exposure}.ts`
- [ ] The starter sun is in lux and the sky is in nits, with the values taken from `template-actors.json`. proof: `pnpm unreal-look:compare --layer L1`.
- [ ] Auto exposure runs with Unreal's metering at `high` and `medium`, and AC-2 passes. proof: `pnpm unreal-look:compare --layer L9 --metric exposure`.

#### Phase 3: Default in every template, native included
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/`, `packages/runtime-native/conformance/scenes/shared/filmic-tonemap.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The filmic curve renders on the desktop native engine within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests filmic-tonemap`.
- [ ] All templates use filmic, EV100 and auto exposure, and the template gate passes. proof: `pnpm test:templates`.
- [ ] Every affected template's `AGENTS.md` (and mirror) states the filmic curve, EV100 lux lighting and auto exposure, with `tonemapMode: "aces"` and fixed exposure as the overrides, so a new project's agent knows the default and how to override it. proof: `rg -l 'tonemapMode: "filmic"' packages/create-threenative/templates/*/AGENTS.md` lists every affected template, and `pnpm sync:agents --check` exits 0.

## Decisions

- 2026-10-21 (Track A): the harness filmic curve has no gamut expansion by default (`expandGamut` 0, 1 stays the override). Evidence: `pnpm unreal-look:curve` on Unreal's own L1 and L2 EXR cells (worst L1 deltaE 11.63 with 1, 1.66 with 0; L2 rows passing 44 of 84 with 1, 60 of 84 with 0) and a per-pixel fit of the amount over 354 samples that needs 0 wherever a pixel is not clipped. The earlier default hid a red excess of the harness atmosphere (27 percent at a 60 degree sun) that belongs to PRD-633. The fog's sky-light fit was refit without the expansion. Judge on the L9 sheets (PR #541 comment 6314982174): NEUTRAL on 8 of 8 frames for the whole bloom, fog and cloud change set, with no gain on sky or floor, so no box of this PRD is ticked by it.

- 2026-10-19: Unreal's tone curve is a look, so it ships as template source. The EV100-to-multiplier
  conversion is plumbing, so it ships in core.
- 2026-10-19: The `low` tier keeps a fixed exposure. Unreal's mobile hardware targeting also turns
  auto exposure off (`Engine/Source/Editor/HardwareTargeting/Private/HardwareTargetingModule.cpp:235`).
- 2026-10-19 (external visual review of the first three.js/Unreal sheet, checked against source):
  Unreal's tonemapper also applies `BlueCorrection = 0.6` and `ExpandGamut = 1.0` by default
  (`Engine/Source/Runtime/Engine/Private/Scene.cpp:436-437`, applied in
  `Engine/Shaders/Private/PostProcessCombineLUTs.usf`). The filmic curve shipped without them; a box
  now owns them. The review's "use AgX or an Unreal LUT" is rejected: the target is Unreal's own
  curve and parameters, not a look-alike.
- 2026-10-19: the live 5.8.3 level's sun is 6.0 lux, 6500 K, source angle 0.7357° (`template-actors.json`).
- 2026-10-19 (owner impression "three.js has a light grey tone; on Unreal I see things better",
  measured): the gap is already there at L2, before fog and post: floor 126 vs 214 and frame
  contrast (luma std-dev) 22.7 vs 39.9, exterior sun60. Owners: exposure here, the sun-to-sky ratio
  in PRD-633 (the starter lights with a photo environment at 2.5, not with the sky the sun lights).

### Engine compatibility repair (2026-10-19)
Complexity: 6 → MEDIUM; risk override: none. Reuse the shared TSL compiler and output pass; game source retains the curve.
- [x] Generic CustomToneMapping compiles in the output pass, before colour encoding. proof: facade registration red (missing library) → green; native_engine_tonemap_operators red (missing refusal) → green; explicit renderOutput and RTT/SMAA live custom uniforms covered. GPU appearance remains unverified.
- [ ] Mutable texture node values refresh material and post bindings on the next draw. proof: facade vitest / native_engine_abi_tsl_call; implementation complete; facade red (TN_NATIVE_TEXTURE_VALUE_UNSUPPORTED) → green, native ABI checks shared/copied binding replacement and stable graph keys. A GPU draw/readback still needs to prove cache refresh visually.
- [ ] Wasm web engine rebuild, facade suite and typecheck pass. proof: requested CMake target / vitest / tsc; Wasm tn-native-engine-web exit 0; 37/37 selected C++ tests pass; facade 32 files / 237 tests pass excluding run-native.spec.ts; direct tsc exit 0 after generation with node --import tsx. Full suite attempted but interrupted: its fake-driver spawnSync probe times out after 5 s in this sandbox. Package typecheck launcher hits IPC EPERM; direct compiler passes.
Desktop execution and visual qualification: not run (no desktop build configured here, sandbox blocks local server IPC). V8 facade/adapter wiring implemented and JS syntax checked; V8 C++ compilation and a desktop render remain unverified. Native AutoExposure still separately refuses TempNode with TN_NATIVE_UNSUPPORTED_TEMPNODE. Read-only review found intermediate custom uniform omission; fixed and regression-tested, reviewer confirmed resolved. No screenshot or visual-judge claim. Tested current dirty task diff on feat/unreal-look-epic; unrelated concurrent edits retained.
