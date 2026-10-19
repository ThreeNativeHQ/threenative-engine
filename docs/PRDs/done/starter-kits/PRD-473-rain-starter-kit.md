---
prd_contract: v1
---

# PRD-473 — Rain: the storm kit (TEMPEST, rebuilt on engine abstractions)

**Status:** DONE (2026-10-01) — all three phases and AC-1..AC-5 verified; one owner taste call (the visual score) recorded under Blocked on
**Complexity:** 7 → HIGH; risk override: none
**Owner:** João (visual taste calls and the final PR screenshots)
**Depends on:** None

## Context

`/home/joao/Downloads/tempest.html` (718 lines, single file, no assets) is a complete coastal storm
study: volumetric clouds ray-marched through a 3D noise volume, a procedurally ray-marched shoreline
with conifers, street luminaires, a guardrail and a lit cabin, a wet road and sea with real-time
reflections and rain ripples, 16 000 camera-anchored rain streaks, branching lightning with
distance-delayed synthesized thunder, four quality tiers, a full weather panel and synthesized
rain/wind/thunder audio. Every pixel is generated at runtime; the only imagery in the PR will be
captures of the reference and of the kit.

This PRD absorbs every abstraction the source contains into the engine's public vocabulary and
delivers the starter kit `rain`, which reproduces the complete study — not a narrowed subset — using
engine abstractions. Templates live under `packages/create-threenative/templates/<name>` and register
themselves through `kit.json` (`packages/create-threenative/src/index.ts:251`).

### What the source actually contains (read 2026-09-30, complete inventory)

| Group | Source constructs (all of them) |
| --- | --- |
| A. Simulation | seeded mulberry32 `rng`; `clamp`/`mix`; exponential weather easing (τ≈0.67 s); weather record `{rain, cloud, wind, fog, exposure, wet}`; four presets `drizzle/storm/supercell/clearing`; `sanitizeWeather` clamped validation; sim clock with `dt` clamped to 0.08 s; auto-strike scheduler (`nextStrike = t + 8 + rand·16`, gated on `cloud > 0.35`) |
| B. Camera | free-fly state `{position, yaw, pitch}` + `home`; WASD/arrows planar move with diagonal normalisation; `Q`/`E` altitude; `Shift` sprint 23 m/s vs 6 m/s; position clamps `x −100…220, y 1.65…110, z −350…90`; drag-to-look yaw/pitch with pitch clamp `−0.7…1.25`; cinematic orbit mode cancelled by manual input; FOV 55°, aspect from viewport; `basis(yaw,pitch)` forward/right/up |
| C. Render passes | **sky/cloud** reduced-res pass (0.4–0.75×), 32/48/64/88 steps by tier, blue-noise jitter, sky gradient + sun disc/glow + flash term; cloud density from a multiscale 64³ RGBA noise volume, flattened condensation base 145–815 m; 5-tap light march with ×1.7 step growth; multiple-scattering approximation; strike-position cloud glow. **world** SDF raymarch (148 steps, adaptive epsilon): fbm+ridge heightfield, road curve, coast, island, one bounded procedural conifer per spatial cell, six repeating luminaires (pole/neck/lamp + emissive underside), guardrail with posts, cabin with lit window and antenna; ground/water with puddle mask (fbm × wetness), 3×3 hashed expanding ripple rings, micro-bump and wave motion, road stripes/edge lines with wear, water albedo and roughness, Fresnel-weighted reflection, sky-texture-offset reflection plus a 36-step secondary reflection march with emissive lamp hit; hemisphere ambient + sun + six cone point lights with specular + strike-direction flash lighting; height-dependent aerial perspective with advected fbm rain curtains; custom `gl_FragDepth` write for particle depth. **rain**: 16 000 quads in a 66×30×66 volume wrapped to a 12 m camera cell, velocity `(wind·20, −(14…22), wind·2)`, projected stretched quads, near/far opacity fades, flash-lit. **bolt**: additive ribbons with core+halo from branching geometry. **bloom**: 5×5 threshold bright pass at ¼ res. **post**: 12 animated refractive lens droplets near the screen edges, 5-tap luma-edge AA, bloom add, exposure multiply, ACES, cool-shadow/warm-highlight grade, vignette, gamma 2.2, dither. Targets: sky, world+depth, bloom; HDR when `EXT_color_buffer_float`; resolution scale and particle count per tier; identical GLSL behind a Three.js `RawShaderMaterial` (GLSL3) driver and a raw WebGL2 driver |
| D. Audio | rain hiss loop (noise → highpass 1800 / lowpass 11 000) with gain from rain; wind loop (pink noise, 35–350 band) with gain from wind + slow LFO; thunder: 7 s generated buffer = crack `exp(−22t)` + rumble `low·(1−e^{−4t})·e^{−0.66t}` with 9 Hz tremolo, distance lowpass, distance gain, scheduled at `distance / 343`; master gain + compressor; suspend/resume on pause and hidden; mute; pending-voice tracking and clearing; gesture unlock, no autoplay |
| E. Interface | topbar (brand, status dot, panel toggle, pause, capture, fullscreen, help); panel with 3 presets, 4 sliders (`rain` mm/h, `cloud` %, `wind` km/h, `fog` %) with readouts, auto-lightning switch, cinematic switch, strike button; "Rendering & accessibility" details (disable flashes, lens droplets, exposure, surface wetness, renderer/HDR readout); quality select (Performance/Balanced/High/Ultra); hero title block; sound pill; telemetry footer (precipitation, wind, fps) and compass heading; `aria-live` toast; help dialog with Escape/backdrop close and photosensitivity warning; hide-interface + restore button; staged loading overlay with progress text; keys `L X H P F R Space W A S D Q E Shift`, `blur` clears keys; responsive breakpoints at 900 px / 620 px / 800 px height; `prefers-reduced-motion` |
| F. Automation API | `window.tempest`: `setWeather`, `setPreset`, `triggerLightning`, `setSafe`, `render`, `step(dt)`, `setQuality`, `stop`, `capture`, `frames`/`flash`/`sizes`; URL params `?still`, `?offline`, `?quality` |

### Reference captures (root lane, 2026-09-30)

The unchanged `tempest.html` was loaded in Chromium via Playwright with `?still&offline&quality=high` and
captured at three viewports: [reference desktop](../../../verification/visuals/rain/reference-desktop.png)
(1440×900), [reference tablet](../../../verification/visuals/rain/reference-tablet.png) (1024×768) and
[reference mobile](../../../verification/visuals/rain/reference-mobile.png) (390×844). A 2026-10-01 re-capture
of the same file on this machine's RTX 2080 (ANGLE/Vulkan, headed) differs from the committed references by a
mean 0.27% per pixel, so the committed set stands as the reference. The kit's own captures and the comparison
are in AC-5.

### Capability lookups actually run (2026-09-30, `threenative-engine-mcp` over `packages/core/capabilities.json`)

Launched from this lane as a stdio MCP server (`node_modules/.bin/tsx packages/engine-mcp/src/index.ts`,
the same entry `threenative-engine-mcp` installs); 1 request-scope search plus 20 mechanic-scope
searches, then `engine_capability_detail` on 20 hits.

| Query (scope) | Result actually returned |
| --- | --- |
| the whole TEMPEST study (`request`) | `RenderChain`, `readRenderChainReport`, `readRenderChainObservation`, `useUiIntent`, `sendUiIntent`, `connectUiBridge`, `publishUiState`, `UiLayer`, `advanceFixedStep`, `assertCaptureNotBlank`, `InstancedBatch` |
| emit GPU particles for falling rain, spray, impact bursts (`mechanic`) | `GPUParticles3D` |
| wet ground, puddle mask, ripple normals, sky reflections (`mechanic`) | `Heightfield`, `WaterSurface3D`, `RippleField`, `ssr` (three addon), `loadTerrainSplat` |
| post chain with bloom, exposure, tone mapping (`mechanic`) | `RenderChain`, `Daylight`, the generated `worldEnvironment` file entry |
| free-fly camera, WASD, drag look, altitude keys (`mechanic`) | `InputMap`, `captureMouse`, `PointerEvents3D`, `defineGame` |
| weather sliders and presets driving render parameters (`mechanic`) | `UiLayer`, `sendUiIntent`, `publishUiState`, `useUiState` |
| ripple rings from impacts on water (`mechanic`) | `RippleField`, `WaterSurface3D` |
| sky, sun and weather (`mechanic`) | `Atmosphere`, `Daylight` |
| quality tiers scaling resolution and step counts (`mechanic`) | `readRenderChainReport`, `readRenderChainObservation`, `Atmosphere` |
| **ray march a 3D noise volume for volumetric clouds** (`mechanic`) | **no results** |
| **upload a 3D data texture and sample it in a shader** (`mechanic`) | **no results** |
| **generate branching lightning ribbon geometry** (`mechanic`) | **no results** (only `UAssetError`, `getPlatform`, `softCircleDataTexture` by lexical accident) |
| **synthesize rain/wind/thunder audio instead of loading files** (`mechanic`) | **no synthesis capability** — `AudioBus` plays buffers, `@threenative/assets` has file passes |
| **honour a reduced-motion preference / reduce flashing** (`mechanic`) | **no results** |
| capture a screenshot as PNG (`mechanic`) | `CanvasLayer`, `GameCanvas` — no download/capture capability |

`GPUParticles3D` constraint: "geometry, color, and timing remain supplied by the game".
`RenderChain` constraint: "stage factories own colour, strength, and all other appearance choices",
"authored stages declare exactly one before or after anchor". `Atmosphere`: "deliberately creates no
mesh, material, or scene light". `AudioBus`: "create buses before playing clips and dispose them
with the game".

Re-run 2026-10-01 against the regenerated `packages/create-threenative/capabilities.json` (`searchCapabilities`
/ `capabilityDetail` from `packages/engine-mcp/src/index.ts`): the three searches that returned nothing now land
on the kit's generated source — "ray march a 3D noise volume for volumetric clouds" → `createNoiseVolume`,
"generate branching lightning ribbon geometry" → `createStormLightning`, "falling rain streaks around the camera"
→ `createStormRain` — and `capabilityDetail` resolves `createWeatherWorld`, `createNoiseVolume`,
`createStormLightning`, `createStormRain` and `createStormAudio` to files that exist under
`templates/rain/src/` (package `template:rain`).

## Solution

**Framework (packages/) — what this PRD changed there, and why each belongs there:**
- `packages/core/src/audio.ts` + the native audio graph (`packages/runtime-native/src/audio/*`): a bus
  compressor and gain target ramps, so the study's master compressor and `setTargetAtTime` smoothing exist on
  every target (the wip slice; 33 core audio tests, native audio graph tests, conformance `94-audio-context`).
  Proven in the game: `storm-audio` reports `compressor: true`, `unsupported: []` and three live voices on
  the native desktop host.
- `packages/playtest`: a web-only scenario field `reducedMotion: "reduce"` (emulated before navigation), so a
  game that honours the preference can prove it — the harness owns scenario plumbing.
- Repo gates: `scripts/visual-gate.ts` asks for soft shadow-map settings only from a light that casts a
  shadow (a ray-marched kit has no shadow map); the assets default-config test lets a kit declare per-clip
  audio overrides; `scripts/render-chain-capabilities.ts` lists the kit's generated-source entries.

**The kit owns (generated source, `templates/rain/`):** every appearance and every rule of the study. The
coast, clouds and sea are the source's own ray-march, transpiled from `tools/tempest-{world,clouds}.frag` by
`tools/generate-shaders.mjs` into TSL; the bloom and post grade are transcribed TSL; the 64³ noise volume
is generated byte-for-byte from the source's seed; rain streaks and the bolt are one instanced draw each
with their own vertex stage; the weather maths, presets, flash envelope and `distance / 343` delay are
`src/state.ts`; sound is the source's DSP baked offline into three WAVs played through `AudioBus`; the
interface is React in `src/ui/`. Named colours and lights are uniforms set from `src/render/{palette,sky,
lighting,materials}.ts`; the player's four tiers are `STUDY_TIERS` in `src/render/quality.ts`.

**Not admitted to the framework** (recorded so a later reader does not re-argue): the noise volume, the
presets (a preset system is outranking rule 5), the flash envelope and bolt generation, the study tiers,
runtime audio synthesis, the lens/grade stage and the source's second render backend.

### Abstraction map (source → disposition, as built)

| Source abstraction | Disposition |
| --- | --- |
| seeded RNG, clamp/mix easing, sim clock | `defineGame({ seed: 607 })` → `ctx.random`; easing, clamp and the 0.08 s step in `src/state.ts` |
| free-fly camera, drag look, cinematic orbit, FOV | `InputMap` (`move` vector, `ascend`/`descend`/`boost` buttons, `look` `pointerRelative`) + rig in `src/render/camera.ts`, FOV 55° |
| pause / hide / sound / photosensitivity keys | the game's input map (`pause`, `hideUi`, `sound`, `safe`) through `intentPatch`; F and P stay in the UI realm (browser APIs) |
| weather state, presets, sliders, readouts, telemetry, compass | game state published through the UI bridge; UI reads `useUiState`, writes `useUiIntent` |
| cloud volume + density + light march | `src/render/noise-volume.ts` (`Data3DTexture`) + transpiled ray-march in `clouds-shader.ts`, a `PassNode` at the tier's resolution share |
| terrain, road, coast, island, trees, luminaires, rail, cabin, wet road, puddles, ripples, reflections, aerial perspective | the source's SDF ray-march transpiled into `world-shader.ts`, one screen quad marked `alwaysRender`, depth written for the rain and bolt |
| rain streaks | `src/render/rain.ts`: one instanced draw, stateless closed form; `GPUParticles3D` inspected and not used (it owns position through a compute node; the source rain has no lifetime) |
| lightning bolt, flash, scene light, cloud glow | `src/render/lightning.ts` + `flashAt` in `src/state.ts`; the strike's entry point lights the coast and the clouds in their shaders |
| bloom, AA, exposure, ACES, grade, vignette, lens drops, dither | one authored `RenderChain` stage (`stormPost`) in `postprocessing.ts`; built-in stages off at every engine tier |
| quality tiers | `STUDY_TIERS` (cloud scale/steps, rain budget, reflections); the drawing buffer is the engine's adaptive resolution |
| rain hiss, wind, thunder with distance delay | `src/audio/storm.ts` over `AudioBus` with the compressor; the delay is kit code |
| reduced motion / photosensitivity | UI reads `matchMedia` once and sends `setSafe`; `safe` gates every strike at one door |

### Repo registration a new kit must make (each one is a gate, not a chore)

`kit.json`, the six render-layer files (`scripts/visual-gate.ts`), `quality.ts` and its documentation
(`scripts/check-template-quality.ts`), the conventions applicability row, the `rain` rows in the
capability-recall corpus, the CI matrices, a README row, `playtests/survives.playtest.json` and a bounded
`playtests/performance.playtest.json`, and `native-playtests/*.playtest.json`.

## Acceptance Criteria

- [x] AC-1 [local]: a project scaffolded from `--template rain` boots into the storm and one panel intent changes the rendered frame, not only the readout. proof: `node packages/playtest/dist/runner/cli.js
  <generated-rain-project>/playtests/storm.playtest.json --url http://127.0.0.1:5373
  --server-command "pnpm --dir <generated-rain-project> exec vite --host 127.0.0.1 --port 5373 --strictPort" --browser-recipe webgpu --headed`
  — pass 2026-10-01 (final sweep at 47ccaef41): Drizzle + slider + drag on a paused storm change 92.98% of pixels; the same pause with no input changes 0.48%
- [x] AC-2 [local]: a strike raises the flash value, brightens the scene and lands a `thunder` cue in the audio ledger at the source delay, while `safe` and `prefers-reduced-motion` suppress every flash. proof: the same runner on `playtests/lightning.playtest.json`
  — pass: safe strike flash 0 and strikes 0; strike status `flashing`; thunder pending at 36 ticks, one `thunder` cue after; delay 0.9968 s for 341.9 m (= distance/343). `flash.playtest.json`: a held strike (flash ≥ 0.5) changes 97.5% of pixels. `reduced-motion.playtest.json` (`reducedMotion: "reduce"`): key, button and 700 ticks of auto-lightning give flash 0 and strikes 0; the same scenario without the emulation fails (strikes 2)
- [x] AC-3 [local]: rain is registered everywhere a template must be registered — CI matrices, capability-recall brief, applicability row, docs, visual score. proof: `pnpm budgets && pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts
  scripts/__tests__/primary-docs.spec.ts scripts/__tests__/check-template-conventions.spec.ts`
  — `pnpm budgets` exit 0; the three specs 3 files / 136 tests pass. The visual *score* is the owner's taste call and is recorded under Blocked on, not claimed
- [x] AC-4 [local]: every row of the source inventory above (A simulation, B camera, C render passes, D audio, E interface, F automation API) is present in the rendered kit, checked one row at a time rather than by assertion. proof: the per-row table under "AC-4 — the inventory, row by row" below
- [x] AC-5 [local]: the kit is captured at the same three viewports as the reference and the PR embeds both sets side by side, stating the comparison the owner actually sees — including any row where it differs, with nothing inferred. proof: `docs/verification/visuals/rain/reference-*.png` beside `docs/verification/visuals/rain/kit-*.jpg`, and the side-by-sides `docs/verification/PRD-473/compare-*.jpg`; comparison under "AC-5" below

### AC-4 — the inventory, row by row (paste into the PR body)

All browser runs: headed `--browser-recipe webgpu`, adapter NVIDIA Turing, zero console/network/runtime
diagnostics. The repo's own template gate, `TN_TEMPLATE_ONLY=rain pnpm test:templates` (packed tarballs,
fresh scaffold, `pnpm test` over the production preview plus the boot smoke), exits 0: "rain: scaffolded
playtests passed". Native: the built `mystral` host on `--target desktop` (Vulkan, RTX 2080, private Xvfb).

- **A. Simulation** — `src/state.ts` (presets, `sanitizeWeather`, easing τ 0.67 s, `flashAt`, `thunderDelay`), `src/scenes/Boot.ts` (clock clamped to 0.08 s, scheduler `t + 8 + rand·16` gated on cloud > 0.35), seed 607. Observed: `weather.playtest.json` Drizzle target 0.24, rendered rain eases to ≤ 0.32 (65.9% of pixels change); `auto-lightning.playtest.json` first automatic strike at t = 37.017 (28 + 9); `auto-lightning-clear.playtest.json` with cloud 0.09 no strike through t = 44.2; the API probe's `setWeather({ wind: 2 })` clamps to 1; 10 weather unit tests.
- **B. Camera** — `src/render/camera.ts`, input map in `src/game.ts`. Observed: `fly.playtest.json` W+Shift z 18 → −4.9 (23 m/s), E y 2.85 → 5.85, drag heading 355° → 308°; `cinematic.playtest.json` orbit moves x 1.8 → 2.85 and W hands it back (`cinematic` true → false); `survives.playtest.json` ArrowUp moves the player 6.0 m.
- **C. Render passes** — clouds (`clouds.ts`/`clouds-shader.ts`, noise volume byte-exact), world ray-march (`world.ts`/`world-shader.ts`), rain (`rain.ts`), bolt (`lightning.ts`), bloom and post (`postprocessing.ts`). Observed: `tiers.playtest.json` cloud target 864×540 / 691×432 / 576×360 / 1080×675 of 1440×900 at 64/48/32/88 steps, drops 9120/9120/4940/12160 (captures `docs/verification/PRD-473/tier-{performance,high,ultra}-1440x900.jpg`, performance drops the reflection march); `lightning-strike-1440x900.jpg` shows the branched bolt, lit coast and cloud glow; kit vs reference mean pixel difference 0.41% at 1440×900 (AC-5).
- **D. Audio** — `src/audio/storm.ts` over `AudioBus` + compressor; `tools/make-storm-audio.mjs` bakes the three clips. Observed: browser and native `lightning` scenarios — `storm-audio` loaded 3, compressor true, one `thunder` cue only after the strike's delay; native `unsupported: []`, 3 voices; pause/visibility/mute holds covered by 12 `rain-audio.spec.ts` tests.
- **E. Interface** — `src/ui/{GameUi,Hud,Menu,LoadingOverlay}.tsx`, `src/style.css`. Observed: kit captures at 1440×900, 1024×768, 390×844; `ui-help-*`, `ui-hidden-1440x900` (H hides panel and HUD, restore button shown), `ui-rendering-details-1024x768` (panel scrolls clear of the pill), `ui-mobile-panel-390x844`, `loading-curtain-1024x768` (staged curtain); `automation.playtest.json` (390×844: strike, X safe, H hide, P capture, Space pause); `loading.playtest.json` (curtain lifts, progress 1).
- **F. Automation API** — `src/ui/tempest.ts`. Observed (one-off Playwright probe on the production build, real GPU, 0 errors): `render()` resolves on a new frame; `setPreset("supercell")`; `setWeather`; `setQuality("low")` → `performance`, unknown name throws `TN_RAIN_QUALITY_UNKNOWN`; `stop()` holds the clock, `step(2)` advances it exactly 2 s; `triggerLightning` strikes (flash 0.68), `setSafe(true)` turns auto-lightning off and blocks the next strike; `sizes` 1440×900; `capture()` encodes 1440×900 (1.97 MB); `?still&quality=high` freezes the clock and picks `high` (every AC-5 capture).

### AC-5 — kit beside the reference

Same viewports, both frozen at t = 28 with `?still&quality=high`: [desktop](../../../verification/PRD-473/compare-desktop-1440x900.jpg),
[tablet](../../../verification/PRD-473/compare-tablet-1024x768.jpg), [mobile](../../../verification/PRD-473/compare-mobile-390x844.jpg);
kit frames alone in `docs/verification/visuals/rain/kit-{desktop,tablet,mobile}.jpg`.

| Viewport | Mean abs pixel difference | Pixels off by > 24/255 | Luminance q05/q50/q95, kit vs reference |
| --- | --- | --- | --- |
| 1440×900 | 0.41% | 0.30% | 0.190/0.329/0.544 vs 0.190/0.328/0.544 |
| 1024×768 | 0.52% | 0.87% | 0.191/0.311/0.553 vs 0.190/0.312/0.553 |
| 390×844 | 0.77% | 1.63% | 0.231/0.430/0.576 vs 0.231/0.432/0.577 |

What still differs, all seen in the images rather than inferred: rain streaks fall at a different phase
(the kit freezes one frame after t = 28); the compass reads `355°` where the reference's still page never
ran its readout and shows `N`; the frame-rate readout shows a number instead of `—`; the sound pill sits
lower on short windows and beside the key hints under 800 px of height (the reference draws the panel over
it at 1024×768); on phones the icon buttons are 44 px and the subtitle is hidden under 480 px. Three real
look differences were found by this comparison and fixed: a transposed fbm rotation (terrain ridges,
puddles and cloud shapes drifted; desktop difference 1.16% → 0.41%), a bloom pass that never got its
resolution and bloomed every highlight mirrored about the horizon, and the sky sampled upside down.

## Sandbox demo — Storm Chaser (2026-10-01)

A cold, user-like game on the kit, outside the workspace: `sandbox/rain-demo` in the shared sandbox repo
(commit `fbc56a8`, local, not pushed), scaffolded with `--template rain` from tarballs packed off feat/rain
at 74c910a4f (`sandbox/.packages/rain/*-rain-<sha>.tgz`). The game on top: log readings at two survey lamps,
then reach the field station within 75 s; a lightning strike within 500 m while you are in the open costs
one of three nerves, and a lamp post is shelter. Rules `src/chase.ts`, HUD `src/ui/ChaseHud.tsx`, light
pillars `src/render/beacons.ts` (the engine's `Billboard3D`), wired through the kit's `strike()` and frame.

| Scenario | Target | Result |
| --- | --- | --- |
| `playtests/chase-win.playtest.json` | browser, headed WebGPU (NVIDIA) | pass — lamp 1, lamp 2, station at their labelled steps; won with 71.3 s left; player moved 85.1 m; zero diagnostics |
| `playtests/chase-lose.playtest.json` | browser, headed WebGPU (NVIDIA) | pass — three strikes in the open: nerve 3 → 0, lost (`nerve`); "Run it again" restores 3 and `playing` |
| `native-playtests/chase-win.playtest.json` | `--target desktop`, feat/rain's built `mystral` host | pass — same route and outcome; flashes are suppressed there (the web view reports reduced motion), so the round is the clock and the route |

Friction (`sandbox/rain-demo/FRICTION.md`), fixed at its layer in feat/rain 1b326f19f: capability search
answered "countdown timer that ends the round" with `TracerPool3D` (the `Scheduler` now carries that
situation; recall row `rain.round-time-limit` red → green); every scaffold's `.gitignore` now ignores the
asset pipeline's compiled outputs (only starter had such rules, and missed the bake receipt; a new scaffold
test was red for rain); and the kit's `AGENTS.md` now says where gameplay attaches. Not fixable in a lane:
`pnpm build:desktop` fails at its last step on the unpublished 0.3.4 prebuilt (`prebuilt-lock.json` HTTP
404), so the native run used the engine checkout's host. Captures:
[desktop](../../../verification/PRD-473/sandbox-desktop-1440x900.jpg),
[tablet](../../../verification/PRD-473/sandbox-tablet-1024x768.jpg),
[mobile](../../../verification/PRD-473/sandbox-mobile-390x844.jpg),
[gameplay](../../../verification/PRD-473/sandbox-gameplay-1440x900.jpg),
[native desktop](../../../verification/PRD-473/sandbox-native-desktop-1280x720.jpg).

## Blocked on

- The template's human visual score in `docs/verification/visuals/scores.json` is the owner's taste call
  (João); rain has none, like sailing, puzzle and runner. Nothing in this PRD's proofs claims one.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Kit registration | `create-threenative --template rain` | new kit, no incumbent | AC-1 |
| Weather control surface | panel / keys → intents → `intentPatch` → `Boot.ts` uniforms | the source's inline DOM handlers | AC-1, AC-4 A |
| Volumetric clouds | `noise-volume.ts` → `clouds-shader.ts` pass → world sky and reflections | generated kit source | Phase 2, AC-5 |
| Storm post chain | `postprocessing.ts` → one authored `RenderChain` stage | the source's BLOOM + POST passes | Phase 2, AC-5 |
| Storm audio | `src/audio/storm.ts` → `AudioBus` (compressor) | the source's Web Audio graph | AC-2, Phase 3 |
| Capture | playtest captures; `window.tempest.capture` web-gated | the source's `canvas.toDataURL` | AC-4 F |

## Decisions

- 2026-09-30 (agent, this PRD): the seeded 3D noise volume generator is **generated kit source**, not a
  `packages/core` export — app maths a game could write portably, and it decides a look.
- 2026-09-30 (agent): the earlier `## Blocked on` entry claiming `api.github.com` was unreachable was
  withdrawn as unproven; the desktop-native run was then run (Phase 3).
- 2026-09-30 (agent, this PRD): runtime audio synthesis is not portable (no `AudioContext` on the native
  host), so the same DSP is baked offline into committed WAVs played through `AudioBus`.
- 2026-09-30 (agent): the source's raw-WebGL2 second driver is withdrawn; the engine's renderer already
  models WebGPU and WebGL2.
- 2026-09-30 (agent): the source's `canvas.toDataURL` button stays web-gated; every target's still image
  comes from the playtest capture path.
- 2026-10-01 (agent, this PRD): the study's look is its own ray-march, not `Heightfield`/`WaterSurface3D`/
  `RippleField`/`Atmosphere`/`Daylight`/`GPUParticles3D`, which the first plan named. Each was inspected:
  none draws an SDF coast, its reflections march or a stateless camera-wrapped rain, and rebuilding the
  study on them would change its look rather than port it. The earlier abstraction map is replaced above.
- 2026-10-01 (agent, this PRD): the source's fixed per-tier drawing-buffer scale (0.55/0.8/1/1.25) is not
  ported; the engine's adaptive resolution (`resolutionScale: "auto"`) measures the frame instead. The
  per-tier cloud resolution, steps, rain budget and reflection switch are ported exactly.
- 2026-10-01 (agent, this PRD): keyboard shortcuts live in the game's input map, not a browser keydown
  listener — the native host's web view never has keyboard focus (probe: X and Space did nothing natively).
  `M` (sound on/mute) is added so sound is reachable from the keyboard on every target.
- 2026-10-01 (agent, this PRD): on the native desktop host the web view reports `prefers-reduced-motion:
  reduce`, so the storm boots with flashes suppressed there; `native-playtests/lightning.playtest.json`
  asserts that and turns flashes on with `X`. It is a separate file from `playtests/lightning.playtest.json`
  because the desktop runner has no click injection and evaluates no visual assertions.

## Execution Phases

### Phase 1 — The kit exists and the storm answers the player

**Status:** DONE (2026-10-01)

Results (2026-10-01, a project scaffolded from local tarballs, headed `--browser-recipe webgpu`,
adapter NVIDIA Turing, zero console/network/runtime diagnostics in every run):
- `playtests/storm.playtest.json` pauses the simulation, then clicks Drizzle, drags the
  Precipitation slider and drag-looks: 92.9% of pixels change, against 0.48% for the same pause with
  no input (`playtests/paused.playtest.json`, elapsed unchanged). Preset `drizzle`, target and
  rendered rain 0.24 at the Drizzle step, ≥ 0.8 after the slider, heading 355° → 308°.
- `playtests/fly.playtest.json`: W+Shift for 60 ticks moves z 18 → −4.9 (23 m/s sprint), E for 30
  ticks y 2.85 → 5.85, a drag turns the heading; 86.1% of pixels change. The wip camera read
  `input.axis()` for key bindings and the raw pointer counter the tick had already spent, so
  sprint, Q/E and drag-look had never worked; it now reads `pressed()` and a `pointerRelative`
  binding.
- `survives` moves the registered player 6.0 m; `weather`, `automation`, `simulation` pass.
- The sky was sampled upside down because the generator's flip rule never matched the
  transpiler's spacing; the rule is fixed and the shader regenerated.
- The render-layer files `palette/sky/lighting/materials.ts` were another kit's leftovers with no
  importer; they now decide the storm's haze, sky, sun, fill, flash light, lamp and sea colours
  as shader uniforms (boot capture unchanged: mean delta 0.16/255).

**Files:** `packages/create-threenative/templates/rain/` — `kit.json`, `src/{main.ts,game.ts,state.ts,scenes/Boot.ts}`,
`src/render/{palette,camera,sky,lighting,materials,postprocessing,quality}.ts`,
`src/ui/{App,GameUi,Hud,Menu,LoadingOverlay}.tsx`, `playtests/{storm,paused,fly,cinematic,survives,performance,loading}.playtest.json`; registration
in `.github/workflows/ci.yml`, the capability-recall corpus, the conventions table and `README.md`.

- [x] Phase 1: the scaffolded rain kit boots into a storm whose panel, presets and fly camera change the rendered frame. proof: AC-1 command above (pass, 92.9% changed vs 0.48% null), `fly.playtest.json` (pass), `pnpm exec tsx scripts/visual-gate.ts --structural-only` (exit 0, rain passes) and
  `pnpm exec tsx scripts/check-template-quality.ts` (exit 0, 11 templates agree)

### Phase 2 — Sky, sea and rain: the look, built from generated source

**Status:** DONE (2026-10-01)

Results: `tiers.playtest.json` switches the panel's quality select through all four tiers and reads back
what was drawn — cloud target 864×540 (high, 0.6), 691×432 (balanced, 0.48), 576×360 (performance, 0.4),
1080×675 (ultra, 0.75) of a 1440×900 frame at 64/48/32/88 march steps, drops 9120/9120/4940/12160
(= round(budget × 0.76)); every tier capture shows coast, clouds, sea and rain, and `performance` drops
the reflection march. The kit-vs-reference comparison (AC-5) found and fixed three look defects
(transposed fbm `mat2`, the mirrored and unsized bloom, the inverted sky). `performance.playtest.json`
at 1920×1080: p95 frame 4.7 ms, ≤ 11 draws, ≤ 36,865 triangles.
**Files:** `templates/rain/src/render/{noise-volume,clouds,clouds-shader,world,world-shader,rain,
postprocessing,bloom-shader,post-shader,quality}.ts` · `tools/generate-shaders.mjs` ·
`playtests/tiers.playtest.json` · `scripts/render-chain-capabilities.ts` · the capability-recall corpus and
budget · regenerated manifests · `docs/verification/visuals/rain/kit-*.jpg`

- [x] Phase 2: the cloud volume, sea, wet road and rain streaks render at every tier inside the declared bounds, from generated source rather than a new engine export. proof: `pnpm exec tsx scripts/check-template-quality.ts` (exit 0); `pnpm build` regenerates the manifests (exit 0, 2026-10-01); `searchCapabilities`/`capabilityDetail` find the five Rain abstractions at existing `template:rain` paths and `pnpm caps:recall` exits 0 with every `rain.*` row recalled (66/73 overall); and
  `node packages/playtest/dist/runner/cli.js <generated-rain-project>/playtests/tiers.playtest.json --url http://127.0.0.1:5373 --server-command "pnpm --dir <generated-rain-project> exec vite --host 127.0.0.1 --port 5373 --strictPort" --browser-recipe webgpu --headed`
  — pass, captured at all four tiers (`docs/verification/PRD-473/tier-*.jpg`)

### Phase 3 — Lightning, thunder, and the finished study

**Status:** DONE (2026-10-01)

Results: browser `lightning.playtest.json` as in AC-2. The native desktop scout's "interface but no storm"
was the kit's stylesheet painting `body`: the native UI is a web view over the game, so an opaque body hid
it (red-green on the desktop host — background restored, UI over a flat `#0e1921`; removed, the storm under
the UI). The shortcuts X/H/Space never reached the native web view and now live in the game's input map.
`native-playtests/lightning.playtest.json` on the desktop host: a strike at boot is suppressed (this web
view reports reduced motion), `X` turns flashes on, `M` sound on, `L` strikes (status `flashing`, strikes
1), thunder is pending at 36 ticks and one `thunder` cue sounds after it, delay 0.9968 s; the capture
(`docs/verification/PRD-473/native-desktop-lightning-1280x720.jpg`) shows the bolt, the lit coast and the
toast "LIGHTNING · 0.34 km · thunder in 1.0 s". `native-playtests/boot.playtest.json` passes with the
`stormPost` stage at tier high (`docs/verification/PRD-473/native-desktop-boot-1280x720.jpg`).
**Files:** `templates/rain/src/render/lightning.ts` · `src/scenes/Boot.ts` · `src/game.ts` · `src/audio/storm.ts` ·
`src/ui/` · `playtests/{lightning,flash,reduced-motion,auto-lightning,auto-lightning-clear}.playtest.json` ·
`native-playtests/{boot,lightning}.playtest.json` · `packages/playtest` (`reducedMotion`)

- [x] Phase 3: a strike flashes the sky, lights the scene and schedules its thunder, the safety switches suppress it, and the same scenario passes natively. proof: `--target browser` run of
  `playtests/lightning.playtest.json` (pass) and `--target desktop` run of `native-playtests/lightning.playtest.json`
  (`node packages/playtest/dist/runner/cli.js <project>/native-playtests/lightning.playtest.json --target desktop --executable packages/runtime-native/build/tn-linux/mystral --project <project> --host-arg run --host-arg <project>/.threenative/build/game.js --host-arg --ui --host-arg <project>/.threenative/build/ui`, after `pnpm native:build` exit 0) — pass
