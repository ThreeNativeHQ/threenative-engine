---
prd_contract: v1
---

# PRD-560 — Height fog follows the ground, and the sun shows through it

**Status:** LOCAL PHASES COMPLETE — all three acceptance criteria and all eight phase boxes are verified at starter `density: 0.0021`. Both complete golden paths, nine complete template macros, the fourth starter fog case and both fog-owner probes pass. Native and browser visual evidence is posted on [PR #482](https://github.com/ThreeNativeHQ/threenative-engine/pull/482#issuecomment-6107646751); [puzzle pairs and judgments](https://github.com/ThreeNativeHQ/threenative-engine/pull/482#issuecomment-6110648325) are also posted. Root typecheck, lint and 127 focused tests pass. The full local unit command is red for missing native build fixtures and stale dependency receipts; it is not a passing gate. Fresh complete CI remains required before merge. The Pixel 8 cost check stays deferred under `## Blocked on`.
**Priority:** P2 — before this PRD, 11 of 13 templates shipped distance-only fog, so no default scene had ground mist or a sun-side horizon.
**Complexity:** 3 (LOW) — 11+ template files (3), no new module, no package change; risk override: none
**Owner:** João
**Depends on:** None. Keeps the stream-edge guarantee of [PRD-461](../done/open-world/PRD-461-view-distance-basics.md) (done) and coexists with the starter mist from [PRD-VQ-07](../done/PRD-VQ-07-volumetric-fog.md).

## Context

Eleven templates set `scene.fog = new FogExp2(colour, density)` in `src/render/sky.ts`: starter,
action-rpg, minimal, platformer, puzzle, racing, rts, runner, sailing, shooter and snow
(`rg -l FogExp2 packages/create-threenative/templates/*/src/render/sky.ts`, 2026-10-09).
Tower-defense uses linear `Fog`. Rain sets no fog.

`FogExp2` reads only the distance to the fragment. So:

- A valley and a ridge at the same distance get the same haze. A scene has no ground mist.
- The fog colour is one palette constant. The horizon toward the sun and the horizon away from it
  are the same colour.

A streaming game's distance fog carries a guarantee that this PRD must keep.
[PRD-461](../done/open-world/PRD-461-view-distance-basics.md) (DONE, PR #470) ships game-owned linear
fog that is opaque at the prop ring, so the stream edge is never visible. The rule is "fog `far` ≤
`ring · cellSize`", and the ground must end beyond it (`docs/guides/world-streaming.md:143-170`). The
example's source is `examples/abyss-framework/src/render/worldFog.ts`. A height term that replaced
that distance term would leave the stream edge bare wherever the view ray stays above the fog layer:
a ridge, or a camera in flight.

three 0.185.1 ships `exponentialHeightFogFactor` (`three/src/nodes/fog/Fog.js:73-82`). It is not the
physical integral: it multiplies the fragment's depth below a height by the view depth. A fragment
above that height gets no fog, even when the view ray crosses the dense layer. It also ignores the
camera height.

### What Unreal does (UE 5.8.3, read 2026-10-09)

Unreal's exponential height fog is a closed-form line integral, not a ray march:

- Density falls off exponentially with height above a fog height. The integral of that density
  along the straight camera-to-fragment ray has a closed form: the density at the camera, times
  `(1 - 2^-(falloff * rayDeltaZ)) / (falloff * rayDeltaZ)`, times the ray length. When the ray is
  nearly horizontal the quotient goes to 0/0, so a first-order Taylor term replaces it. The exponent
  is clamped at -127 so `exp2` stays finite.
  `UE 5.8.3: Engine/Shaders/Private/HeightFogCommon.ush:205-213`.
- The density at the camera does not change across the frame, so the CPU computes it once per frame.
  The CPU also clamps the camera height relative to the fog height and clamps the exponent to the
  float range, for precision. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/FogRendering.cpp:370-405`.
- Transmittance is `exp2(-integral)`, floored by `1 - maxOpacity`. A cutoff distance turns fog off
  past a range, so the sky is not fogged twice.
  `UE 5.8.3: Engine/Shaders/Private/HeightFogCommon.ush:394-407`.
- Directional inscattering adds the sun colour, weighted by
  `pow(saturate(dot(viewDir, sunDir)), exponent)`. It integrates the same density, but only over the
  part of the ray past an inscattering start distance. So the sun glow is a distant-haze effect and
  does not tint nearby objects.
  `UE 5.8.3: Engine/Shaders/Private/HeightFogCommon.ush:355-368`.
- Component defaults: density 0.02, height falloff 0.2, max opacity 1, start distance 0,
  inscattering exponent 4, inscattering start distance 100 m (10000 UE units).
  `UE 5.8.3: Engine/Source/Runtime/Engine/Private/Components/ExponentialHeightFogComponent.cpp:80-98`.
  Unreal works in centimetres. This PRD recalibrates the values in metres against each template's
  current eye-level haze. It does not copy them.

The fragment cost is two `exp2` calls, one division and one `pow`. There is no march, no texture and
no extra pass.

## Solution

**The look ships as generated source** (rule 1(b)): the fog decides how the scene looks, so each
template's `src/render/sky.ts` owns it. Nothing changes in `packages/`.

- **The height term adds to the distance term and never replaces it.** The final transmittance is
  `T_distance × T_height`. `T_distance` is the game's existing distance fog: the template's current
  `FogExp2` curve through three's `densityFogFactor`, or a streaming game's linear near/far through
  `rangeFogFactor`. Both are exported from `three/tsl` (`three/src/nodes/fog/Fog.js:40, 57`). The
  product is never more transparent than either factor alone. So wherever `T_distance` reaches 0,
  at fog `far` and at the prop-ring corner, the frame stays fully fogged, and the PRD-461 guarantee
  holds unchanged. The sun-inscatter colour mixes in with the same combined opacity.
- `sky.ts` builds a TSL fog node and assigns it to `scene.fogNode`. three's `NodeManager.getFogNode`
  (`three/src/renderers/common/nodes/NodeManager.js:578`) applies `scene.fogNode` per material, in the
  same place `FogExp2` applies today. Transparent materials receive fog, and the background does not.
- The node computes the closed-form integral above, with the Taylor fallback and the exponent clamp,
  in metres. A per-frame uniform carries the camera-height density term. The sun lobe uses the
  template's existing `SUN_DIRECTION`. The non-directional colour is the template's current fog
  colour (for example `palette.skyLow`), so the eye-level look does not change.
- The named controls in `sky.ts` are: `density`, `heightFalloff`, `fogHeight`, `maxOpacity`,
  `startDistance`, `sunExponent`, `sunStartDistance` and `cutoffDistance`. Each control has a
  comment that says which way to move it. The pure math is exported from `sky.ts`, so a node-env
  spec can check it.
- Each template keeps its current eye-level haze. At camera height and the current reference
  distance, the combined transmittance matches the old `FogExp2` transmittance within 2%. The
  `FogExp2` density is lowered to make room for the height term at eye level. It is never removed.
- **Coexistence with the starter mist:** `STARTER_MIST` already owns the fog while it is enabled
  (starter `AGENTS.md`). Height fog yields to it the same way `FogExp2` does today. Only one fog owner
  exists at a time.

```mermaid
flowchart LR
  A[sky.ts setupSky] --> B[scene.fogNode = heightFog]
  B --> C[three NodeManager.getFogNode]
  C --> D[every material's output]
  E[per-frame camera-height density uniform] --> B
```

Risks:

- three may not apply `scene.fogNode` on a node material that sets its own `fog: false`. Phase 1
  checks the starter's materials.
- The native host must compile the same TSL fog node. Phase 2 proves it on the desktop target.

## Acceptance Criteria

- [x] AC-1a [local]: In the scaffolded starter, the height-fog frame is judged at or above the `FogExp2` frame by a fresh judge. proof: 2026-10-11, starter `density: 0.0021`. The proof uses twelve headed 1920x1080 WebGPU captures on adapter `nvidia`/`turing`. There are 2 arms, 3 poses (default, high, ridge), and 2 runs each. Figures: `~/.cache/prd-560-work/pr482-density-0021/figures/pr482-web-{default,high,ridge}-before-after.png`. The parent thread verified the crop comparisons. A fresh, read-only gauntlet critic (`/root/judge_density_trial`) returned overall IMPROVEMENT. Default is NEUTRAL in both runs. High is NEUTRAL in both runs, and keeps smooth ground and horizon. Ridge is IMPROVEMENT in both runs. No new artifact. Approved 2026-10-11. Historical: same-pose before/after captures (2 runs per arm, three poses: default, high, ridge; 1920x1080, headed, `--browser-recipe webgpu`, adapter `nvidia`/`turing`) given to a fresh read-only judge subagent with the intended effect — verdict 2026-10-09 on `density: 0.0012`: no regression in any of the three poses; re-judged 2026-10-10 on the shipped `density: 0.0018` with a fresh judge: default NEUTRAL, high NEUTRAL, ridge IMPROVEMENT, no new artefact. `pnpm visuals:ab` was not run: the fresh-judge protocol replaced it.
- [x] AC-1b [local]: Low ground reads hazier than a ridge at the same distance. proof: 2026-10-11, starter `density: 0.0021`. The fresh, read-only gauntlet critic (`/root/judge_density_trial`) judged the AC-1a captures: ridge IMPROVEMENT in both runs. The raised red cube has stronger face contrast and more saturation, while the low cube and ground stay hazier. Overall IMPROVEMENT, with sky and UI preserved. Approved 2026-10-11. Historical: same-pose captures and a fresh read-only judge, 2026-10-10 — verdict IMPROVEMENT on the ridge pose ("the raised cube is a clearly deeper, more saturated red and the ground cube is lighter and less saturated"; difference "clearly visible, moderate, not dramatic") and IMPROVEMENT overall; default and high poses NEUTRAL, no artefact. Measured, not graded: mean saturation of the low block vs the high block is 0.491 vs 0.603 with height fog and 0.407 vs 0.404 with `FogExp2`. The first judge on `density: 0.0012` returned "unclear, leaning intended" (saturation 0.461 vs 0.516), which is NEUTRAL under the owner rule, so the cause was fixed (see Decisions) and a fresh judge ran again. Unit proof: `pnpm exec vitest run packages/create-threenative/__tests__/height-fog.spec.ts` — 23/23; the new per-kit "ridge contrast" spec reads 0.052 (fails) at density 0.0012 and passes at 0.0018. Focused re-run at `density: 0.0021`: 23/23 (focused suite).
- [x] AC-2 [local]: At 1080p on the RTX 2080 browser WebGPU lane, height fog costs at most 0.1 ms GPU more than `FogExp2` in the same starter build. proof: 2026-10-11, `density: 0.0021`, headed 1920x1080, actual adapter `nvidia`/`turing`, same-page interleaved `scene.fogNode` toggle, two runs. Receipts: `~/.cache/prd-560-work/pr482-perf-density-0021/run/verified-out/toggle-r{1,2}.json`. Both runs exit 0.
  - Each run has 14 alternating 100-frame windows. The parent thread validated each window: positive, finite `gpuMain`. The comparison excludes row 0, the warm-up window.
  - Run 1: on 0.7333333333 ms, off 0.7142857143 ms, delta (on minus off) +0.019047619 ms. Run 2: on 0.7 ms, off 0.7428571429 ms, delta -0.0428571429 ms. Both deltas are within the +0.1 ms budget.
  - The `FogExp2` control on the same page keeps its lowered `distanceDensity`.
  - Coarse timing, sparse readback (87–88 stale frames per 100) and a shared host support the budget only. This result makes no FPS, speedup or CPU claim.
  - Historical, not a new claim: `density: 0.0018` receipts (2026-10-11, `~/.cache/prd-560-work/pr482-perf-integrated-run/`) met the budget, with deltas of -0.169 ms and -0.021 ms.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Height fog | scaffolded game → `setupSky()` in `templates/*/src/render/sky.ts` → `scene.fogNode` → three `NodeManager.getFogNode` → every material | Moves the `FogExp2` term of 11 templates into the node as `T_distance`, unchanged in shape. Tower-defense linear `Fog`, rain's no-fog and the PRD-461 streaming recipe stay unchanged. | AC-1, AC-2, Phase 1, Phase 3 |

## Execution Phases

#### Phase 1: Height fog in the starter
**Status:** COMPLETE (2026-10-11): the current starter golden path and fourth fog case pass; the mist arm and both owner probes pass.
**Files:** `packages/create-threenative/templates/starter/src/render/sky.ts`, `packages/create-threenative/templates/starter/src/render/heightFog.ts` (new: the template `__tests__/template.spec.ts` render-export rule needs each exported maths symbol to have a caller in another file, so the maths moved out of `sky.ts` and `sky.ts` keeps the look numbers), `packages/create-threenative/__tests__/height-fog.spec.ts` (new)
**Implementation:** Write the integral as a pure function, then the TSL node that uses it, and assign the node to `scene.fogNode`. Calibrate `density` and `heightFalloff` to the current eye-level haze.
- [x] The closed form matches a 4096-step numeric march within 1% for camera heights below, inside and above the layer, for rays from -89° to +89°, at exactly horizontal (the Taylor branch), and at the exponent clamp. proof: `pnpm exec vitest run packages/create-threenative/__tests__/height-fog.spec.ts` — 5/5 pass, 2026-10-09. The clamp case asserts finite and fully opaque, not equality: Unreal clamps the camera term only, so a march that clamps per sample differs by design.
- [x] The combined transmittance is never above the distance term alone. With PRD-461's recipe (linear near 128 m, far 256 m), it is 0 at fog `far` for a camera far above the layer. proof: `pnpm exec vitest run packages/create-threenative/__tests__/height-fog.spec.ts` — same 5/5 run.
- [x] The current `density: 0.0021` starter template gate passes with height fog on, and the mist-enabled arm shows one fog owner. proof: the starter is not in `pnpm test:templates`, so its four scaffolded scenarios `play`, `survives`, `production-readiness` and `fog` run on each arm with `--browser-recipe webgpu --headed`. Current results at `density: 0.0021`: canonical full starter golden path exits 0 (`/tmp/pr482-golden-starter-full.log`), including scaffold/install/MCP/dev/test/build/artifact stages and all three original scenarios. The existing fourth `fog` case separately exits 0 on private Xvfb, headed WebGPU, NVIDIA/Turing (`/tmp/pr482-starter-fog-final.log`). Earlier mist and owner receipts below remain source-equivalent: no starter appearance changed afterward. Historical failed height-fog attempt:
  - Height-fog arm: `play` fails only the frame-time p95 check (`maxFrameMsP95`, 120.3 ms against 33 ms, n = 281). `survives`, `production-readiness` and `fog` are unrun. The source build exits 0. Log: `~/.cache/prd-560-work/pr482-starter-runtime-0021/ready/logs/run-20261011T094058Z/play.log`.
  - Historical diagnosis: the earlier display/cadence attempt did not qualify the gate; the later canonical private-Xvfb golden path above does.
  - Height-fog owner probe: exit 0. The explicit assertion reads `scene.fog` true, `scene.fogNode` true and empty `errors[]`. Log: `~/.cache/prd-560-work/pr482-starter-runtime-0021/ready/logs/owner-20261011T094428Z/owner.log`.
  - Mist arm (`STARTER_MIST.enabled = true`), adapter `nvidia`/`turing`: all four scenarios report `pass: true` with empty `diag[]`. Assertion counts: `play` 8, `survives` 6, `production-readiness` 5, `fog` 1. Log: `~/.cache/prd-560-work/pr482-mist-current/ready/logs/run-20261011T092933Z`.
  - Mist owner probe: observed `scene.fog` false, `scene.fogNode` false and empty `errors[]`. Log: `~/.cache/prd-560-work/pr482-mist-current/ready/logs/owner-20261011T093056Z/owner.log`.
  - Both arms show current fog ownership. The later complete starter golden path and fourth fog case close this box.
  - Historical, not current: at `density: 0.0012` on 2026-10-09, both arms passed 4/4, with one mist-arm `play` rerun after a frame-time failure.
  - The twelve AC-1 visual captures do not prove these scenarios.

#### Phase 2: Native
**Status:** COMPLETE (2026-10-11): the native box is ticked at `density: 0.0021`; the phone-cost check remains under `## Blocked on`
**Files:** none beyond Phase 1, unless a defect needs a fix
- [x] The desktop native host renders the current `density: 0.0021` starter with height fog and a non-blank screenshot. proof: 2026-10-11, `native-render-chain` scenario, HUD on, NVIDIA GeForce RTX 2080, two runs. Both runs exit 0 with `pass: true`, six of six assertions passing, and zero console and runtime diagnostics. The grade stage reports `graphOutputChanged: true` in both runs.
  Critic: a fresh, read-only critic returned IMPROVEMENT in both pairs and overall. It found smoother clouds, material and blue highlights, aligned geometry, shadows and HUD, and residual dark speckle at the horizon.
  Figures: branch `prd-560-screenshots`, paths `pr482-final-0021/native-before-{1,2}.png` and `pr482-final-0021/native-after-{1,2}.png`. The before frames are the historical `density: 0.0018` control, so the pair cannot attribute every change to filtering. This is not a browser parity or cold-install claim. Antialias still drops with the pre-existing `build:Image is not defined`.

#### Phase 3: Every FogExp2 template
**Status:** COMPLETE (2026-10-11): all nine full template macros and the platformer golden path pass.

Current runtime checkpoint (2026-10-11, source `6fd23bdae`): the full scaffolded gates pass for minimal, action-rpg, runner and sailing on NVIDIA/Turing with headed WebGPU and the existing desktop display. Shooter reached `enemy-scale` without a failed scenario, then `enemy-stops-without-snapping` produced no result for over 20 minutes. Its browser was deliberately terminated; this attempt reports `TN_PLAYTEST_PAGE_CLOSED` and is not a passing gate. Its captured frame budget shows 1 FPS, host-gap p95 996.6 ms and render p95 9 ms. Xwayland subsequently reports a 0×0 screen with no outputs; the session is unlocked and the owned browser was focused. A user-activity wake request did not restore an output. The parent stopped only this job's verified process groups (exit 143), preserving the logs in `~/.cache/prd-560-work/pr482-rtx-current-gates/`. Remaining templates, both golden paths and the prepared starter-arm follow-up remain unverified. No timeout, viewport, assertion or performance budget was changed.

The targeted shooter render-work probe completes using the runner's existing performance arguments (`--disable-frame-rate-limit`, `--disable-gpu-vsync`) on NVIDIA/Turing. It fails only frame-time p95: 35 ms against 33 ms, 654 samples. A matched control, cloning that fixture and replacing only `src/render/sky.ts` with the original FogExp2 version from `b4e74627f`, also fails only frame-time p95: 34.4 ms against 33 ms, 614 samples. Both exit 1; one run per arm does not establish a regression or qualify the gate. Original scenarios, dependencies, viewport and limits are identical. Logs: `/tmp/pr482-shooter-render-work-perf.log` and `/tmp/pr482-shooter-fogexp2-control.log`; control provenance: `~/.cache/prd-560-work/pr482-shooter-fogexp2-control/provenance.txt`. These are render-work measurements, not physical presentation FPS. The complete `pnpm test:tone` gate separately exits 0 on the existing private-Xvfb harness: the intentional underexposure fails and restoration passes (`/tmp/pr482-tone-xvfb-current.log`).

Two targeted functional follow-ups remain failed/unverified: the unchanged shooter `enemy-stops-without-snapping` scenario on private Xvfb produced no result after over 200 seconds, then its verified owned browser was deliberately terminated (exit 2, `TN_PLAYTEST_PAGE_CLOSED`; `/tmp/pr482-shooter-functional-xvfb.log`). A public-runner invocation preserving the parsed WebGPU recipe and adding only the installed `PERFORMANCE_BROWSER_ARGS` was bounded externally to 180 seconds and timed out (exit 124; `/tmp/pr482-shooter-functional-unthrottled.log`). Neither changed product code, scenario assertions, viewport, or scenario timeouts; neither qualifies a gate. No processes remain with the owned fixture as their working directory. Stop this display/cadence approach after the third failed attempt: the assumption that presentation cadence alone explains this scenario's stall is doubtful. A question about the desktop's intended monitor state is pending; no cause is established by these attempts.

Subsequent tracing corrects the apparent-hang diagnosis: `PlaywrightTransport` already bounds bridge calls. A 60-second diagnostic logged 43 `advance` calls and 636 `sample` calls, completing 19 labelled checkpoints (`spawn-settle` through `patrol-18`) at roughly two seconds per checkpoint. `establishSceneSubject()` polls up to 30 times for a subject position between steps; the trace does not establish why that position is absent. No bridge deadlock was observed. With that measured progress, the unchanged full `enemy-stops-without-snapping` scenario was allowed to finish under a 300-second outer safety limit: exit 0, `pass: true`, five of five assertions, zero diagnostics, NVIDIA/Turing, original 1280×720 viewport (`/tmp/pr482-shooter-functional-finite.log`). This uses the parsed WebGPU recipe plus the existing `PERFORMANCE_BROWSER_ARGS`; no product source, scenario assertion, viewport or scenario timeout changed. It is functional proof, not physical presentation FPS or the full scaffolded macro gate. The remaining 14 shooter scenarios are now running through the public batch runner with the same arguments and all original assertions; no new Phase 3 box is ticked. Debian offload refused this job at 100°C (exit 75).

The remaining shooter batch is terminal (exit 1): 13 of 14 scenarios pass, including performance at p95 25.9 ms against 33 ms with 869 samples, 1177 draw calls and 420933 triangles at 1920×1080 on NVIDIA/Turing. Its only failure is `input-control`, with four mouse-input assertions failing on the existing desktop display. The unchanged `input-control` scenario then passes seven of seven assertions with zero diagnostics under the canonical CLI WebGPU recipe on a private Xvfb display, original 1280×720 viewport and the five original browser arguments (`/tmp/pr482-shooter-input-private.log`). A coverage audit compares all 34 shipped shooter scenario names with the original macro's earlier passing receipts, the completed 14-scenario batch, and the two isolated passes: 34/34 have passing receipts, with none missing. This is combined scenario coverage across documented browser modes, not a single canonical macro exit. No game or engine source was changed to obtain these passes. The four remaining template macro gates (puzzle, racing, rts, snow) are running without scenario filters (`/tmp/pr482-remaining-four-template-gates.log`); their boxes stay open pending completion.

Gate repair plan (complexity 1 → LOW; no risk override): the four-kit macro is terminal (exit 1), with racing, rts and snow passing and only puzzle's `the-room-is-actually-lit` screenshot assertion failing. Two matched FogExp2 controls fail the same original 50% dark-pixel ceiling (57.25%, 57.36%); two current height-fog runs fail at 57.40%, 57.35%. This does not establish a height-fog regression. The repair belongs to the puzzle template's game-owned `src/render/lighting.ts`, not an engine appearance preset. Use its existing cold rim light to improve the obscured region; retain the near-black floor, quiet ambient fill, warm lamps, geometry, fog, camera, post and original assertion. First trial doubles only the authored rim from 0.24 to 0.48 in a scratch copy. Required proof before adopting it: the original lit scenario twice, a fresh read-only visual judge returning IMPROVEMENT on same-pose before/after pairs, then the full 14-scenario puzzle macro and affected scaffold contracts. Capability search inspected the returned hits; no new system is needed for an existing Three.js light. No box is ticked for the trial.

The rim trial fails both original lit probes (57.16%, 57.18% dark pixels; the other ten assertions pass). It is not adopted. Stop that approach: the assumption that the rim materially illuminates this crop is unsupported. Inspection of the actual crop and authored materials points instead to the cyan phase-crate surfaces. Their existing emissive glass shell is the game-owned signal that these colliders can be walked through; it is deliberately separate from the edge cage. Replan within the same gate: trial only `phaseMaterial`'s emission multiplier in `src/render/materials.ts`, 0.34 → 0.5, from the unmodified fixture. Preserve opacity 0.55, edge-cage colour, all lights, near-black floor, geometry, physics, fog, camera, post and assertions. Keep the same two-run lit proof, fresh visual judge and full puzzle gate requirements before adopting this alternative. No product appearance change has been made.

The 0.5 emission trial also remains unadopted: both runs pass ten of eleven assertions but miss the original dark-pixel ceiling (51.28%, 51.41%). After these two failed approaches, replan from the measured pixel response rather than raising global light. Comparing each original frame with its 0.5 trial shows about 39.2% of the failed region responds by more than 0.015 encoded luminance; about 10% of the region still responds while below the 0.25 darkness threshold. A local linear-response estimate predicts roughly 47.35% dark pixels at 0.55 in both pairs. That is an inference, not a passing test. Permit one final bounded 0.55 emission trial with every other parameter unchanged; if it fails, stop appearance edits and revisit the response assumption. The same actual two-run probe, fresh visual judge and complete puzzle macro remain required. Independently, the shipped `pnpm --filter strata-terrain-preview bake` regenerated the ignored missing horizon input (4.01 seconds); root `pnpm typecheck` then exits 0 at unchanged product source. No tracked example file changed. Full platformer golden-path qualification is now running through the canonical harness.

Current qualification (2026-10-11): the canonical platformer golden path exits 0, all 15 original scenarios pass with empty diagnostics (`/tmp/pr482-golden-platformer-full.log`). Production performance on NVIDIA/Turing is 15.7 ms p95 against 33 ms, 158 samples; draw calls 563/600 and triangles 187008/190000. Its intentional malformed-package negative control fails as expected; the complete macro succeeds. The complete starter golden path also exits 0 (`/tmp/pr482-golden-starter-full.log`).

The puzzle correction is adopted: only `phaseMaterial` emission changes from 0.34 to 0.55; geometry, lights, opacity, edge cage and fog remain unchanged. Its actual generated-tree fingerprint is `edd2e8eb7e1602e23e42634afe2fc768ae8a2c4b8e9e1006c208aa9bab343ec3`. The original lit scenario passes 11/11 assertions in each of two NVIDIA/Turing runs at the original 1280×720 viewport, diagnostics empty. Dark-pixel ratios are 0.475297619047619 and 0.4741666666666667 against 0.5 (`/tmp/pr482-puzzle-phase-055-{1,2}.log`). A fresh Haiku critic and fresh read-only `/root/judge_puzzle_visibility` each return IMPROVEMENT for both pairs and overall. The Haiku critic notes busy overlap; the second critic finds it pre-existing, with no new or worsened artifact. Visual review alone does not establish physical playability. Four lossless labelled images, preserving original frame pixels, are published in screenshot commit `34455a622cc386943ffd482d6e48593fd2c79c3b`, previous 37 files retained, and [posted on the PR](https://github.com/ThreeNativeHQ/threenative-engine/pull/482#issuecomment-6110648325).

After adoption, the complete canonical puzzle macro exits 0 with all 14 original scenarios passing and empty diagnostics (`/tmp/pr482-puzzle-canonical-full.log`). The complete canonical shooter macro exits 0 with all 34 original scenarios passing and empty diagnostics (`/tmp/pr482-shooter-canonical-full.log`). Both use private Xvfb and the unchanged shipped WebGPU/performance recipes, scenarios, viewports and limits. These are complete macro receipts, superseding the earlier combined subset proof.

Final source checks: 127/127 focused tests (height-fog 23, template 38, scaffold 66), root `pnpm typecheck` and `pnpm lint` exit 0. The first focused attempt raced the macro's package build and failed for missing `packages/assets/dist/index.js`; it passes after package generation completes. Root `pnpm test` exits 1: native suite 23 failed, 1549 passed, 69 skipped; missing V8/QuickJS host/test executables, stale native SBOM dependency receipts and consequent absent pump observations. No fixtures were bypassed and no full-unit pass is claimed. Fresh CI must build and qualify these native inputs. Logs: `/tmp/pr482-puzzle-promoted-focused-final.log`, `/tmp/pr482-promoted-{typecheck,lint,full-tests}.log`.

**Files:** `src/render/sky.ts` in action-rpg, minimal, platformer, puzzle, racing, rts, runner, sailing, shooter, snow; each template's `AGENTS.md` (and mirrors)
- [x] Eight of the ten other templates (action-rpg, minimal, puzzle, racing, rts, runner, sailing, snow) use height fog, each within 2% of its old eye-level transmittance, and their template gates pass. proof: `pnpm exec vitest run packages/create-threenative/__tests__/height-fog.spec.ts` (eye-level spec over all 11 kits, 32/32 with the doc specs) and `TN_TEMPLATE_ONLY=<template> pnpm test:templates` on the RTX 2080 lane, 2026-10-09 to 2026-10-10 — pass for minimal, sailing and rain on the first run; puzzle, racing, rts, runner, action-rpg and snow passed on rerun. The first runs failed only `performance.maxFrameMsP95` (36.9 to 81.3 ms, host load 20 to 47 from other jobs), one Xvfb start timeout (runner) and one GPU device-lost (action-rpg). Unchanged tower-defense failed the same assertion in the same window (46.8 ms), and base templates from 6b18d913e failed action-rpg (36 ms plus 3 console errors) and shooter (90.8 ms) there too, so the failures belong to the lane.
  Current proof: full canonical macros pass for minimal, action-rpg, runner and sailing (`/tmp/pr482-minimal-rtx-real-display.log`, `~/.cache/prd-560-work/pr482-rtx-current-gates/template-playtests.log`), racing/rts/snow (`/tmp/pr482-remaining-four-template-gates.log`), and puzzle (`/tmp/pr482-puzzle-canonical-full.log`). All eight current gates pass; the prior results in the preceding paragraph are historical.
- [x] The shooter and platformer template gates pass with height fog. proof: canonical shooter macro exits 0 with all 34 original scenario summaries passing and empty diagnostics (`/tmp/pr482-shooter-canonical-full.log`). Canonical platformer golden path exits 0 with all 15 original scenarios passing, empty diagnostics, and scaffold/install/MCP/dev/test/build/artifact stages complete (`/tmp/pr482-golden-platformer-full.log`). These complete local hardware receipts supersede the earlier partial/failed attempts; fresh CI remains required before merge.
- [x] Each template's `AGENTS.md` names the fog controls and the mist ownership rule, and the mirrors are in sync. proof: `pnpm sync:agents --check && pnpm exec vitest run scripts/__tests__/primary-docs.spec.ts scripts/__tests__/sync-agent-docs.spec.ts`. — "agent docs in sync: 23 CLAUDE.md mirrors"; primary-docs and sync-agent-docs specs pass, 2026-10-10.
- [x] After raising density to 0.0018, the five gates named by `gates2.sh` pass: action-rpg, minimal, runner, sailing and shooter. proof: `TN_TEMPLATE_ONLY=<template> sh scripts/xvfb.sh pnpm exec tsx scripts/verify-template-playtests.ts`. The existing run has minimal and sailing exit 0; action-rpg exit 1 (inventory diagnostics not evaluated, GPU device loss, p95 49.7 ms > 33 ms), runner exit 1 (p95 59.6 ms > 33 ms), shooter pending. Logs: `/home/joao/.cache/prd-560-work/tt2/`. The earlier eight-kit proof above predates the stronger density; it does not complete this box. No retry after two frame-time failures on the loaded host.
  Current proof: all five complete canonical macros pass on NVIDIA/Turing: action-rpg/minimal/runner/sailing as recorded above, shooter 34/34 and exit 0 (`/tmp/pr482-shooter-canonical-full.log`). Other than the separately reviewed starter density and puzzle emission corrections, their render source remains unchanged. The preceding `tt2` receipts are historical failures, not the current result.

## Blocked on

- Pixel 8 main-pass cost: the height-fog starter costs at most 0.2 ms more than the `FogExp2` build. proof when run: `node packages/playtest/dist/runner/cli.js perf --logcat <serial>` on both Android builds. João must grant the Pixel (shared device lane); an emulator cannot hold a phone-GPU claim.

## Decisions

- 2026-10-10 (workflow inspection): `ci.yml` accepts pushes only to main/develop and skips the board for draft PRs; PR #482 targets develop and carries only `prd:75%`, so `native-release.yml` also refuses its expensive proof (requires main or `release-proof`). No push, ready, rebase, merge, dispatch or deploy was performed. A later merge of these template files into develop will trigger `site-docs.yml`, which dispatches the site's deployment workflow; keeping this run local avoids that trigger.
- 2026-10-10 (resume verification): keep the Pixel 8 cost under `Blocked on`; João owns the shared device grant, and no phone cost was measured. PR #478 is still OPEN, so no parent hashes were regenerated, and PR #482 remains draft. Existing local hash edits passed `scaffold.spec.ts`; integration after #478 still needs its final parent hashes.
- 2026-10-10 (resume verification): the starter's current `heightFog.ts`, `sky.ts` and `palette.ts` exactly match `/home/joao/.cache/prd-560-work/after-starter/src/render/`; the captured build contains density 0.0018. The arms have identical camera, scene and scenario sources; all 12 reports in `final/` pass at 1920x1080 on nvidia/turing, with two runs per arm per pose. All 12 `final/labelled/` images retain BEFORE/AFTER banners. The fresh-judge IMPROVEMENT handoff is `pr-comment2.md` in that same cache. Reused these captures without a new capture or judgement. The twelve existing comparisons are now on screenshot commit `487dccda66517e9975607cd780a1aef41fec49da`; its evidence-only push used the documented `TN_SKIP_PREPUSH=1` escape hatch after the product drift hook rejected the first upload. No product-source branch was pushed.
- 2026-10-10 (resume checks): `pnpm exec vitest run packages/create-threenative/__tests__/height-fog.spec.ts packages/create-threenative/__tests__/scaffold.spec.ts packages/create-threenative/__tests__/template.spec.ts scripts/__tests__/primary-docs.spec.ts scripts/__tests__/sync-agent-docs.spec.ts` passes 143/143 in 56.92 s, including pristine compiler checks for every template. `pnpm --filter create-threenative typecheck`, `pnpm check:docs` (3025 links), `pnpm sync:agents --check` (25 mirrors) and Biome on the nine dirty TypeScript files pass. Logs: `/tmp/prd560-{focused-gates,package-typecheck,check-docs,sync-agents,biome}.log`. Root `pnpm typecheck` fails at `examples/strata-terrain-preview/src/render/horizon.ts`: missing `../world/horizon.json` and consequent unknown types; no unrelated repair attempted (`/tmp/prd560-typecheck.log`). Laptop status refused work at 100°C, then 98°C; short deterministic checks ran locally while the already-running template job was preserved.
- 2026-10-10 (measurement scope correction): the -0.03 ms browser cost and desktop native screenshot predate the retune and cover `density: 0.0012` only. Current `density: 0.0018` browser cost and native rendering remain open; unchanged instruction count does not establish measured cost. No new visual judgment ran because the user-requested Claude visual-judge skill could not be located. Keep the PR draft for user inspection; no archive or merge.
- 2026-10-10 (agent, on a NEUTRAL judge): AC-1b read "unclear, leaning intended" at `density: 0.0012`. The cause was the split of the kept eye-level haze: the height term carried 60% of it and the identical distance term hid the difference at 330 m (5 points of opacity). A grid over `density` and `heightFalloff` showed `heightFalloff` near 0.08 is already the best value (0.05 and 0.12 both lose), and that a larger height share is what widens the gap. The seven kits whose old fog was `FogExp2` 0.003 at 150 m from 2 m up (starter, minimal, platformer, action-rpg, runner, shooter, sailing) now ship `density: 0.0018` (about 84% of that haze in the height term; the distance term stays, so the ground still ends in fog at a kilometre: 93% at 1 km). Racing already carries 86% at 0.0012, rts looks from 20 m, snow's fog is a 40 m blizzard and puzzle's is 12 m, so those four keep their values. Cost: at 330 m the total haze is lighter than the old quadratic fog (42% against 62% at 330 m along the horizon, because the height term grows linearly with distance); the eye-level haze at 150 m still matches within 2%. Rejected: raising `heightFalloff` (it lowers the ground cube's haze as much as the ridge's), and a pose with the camera above the layer (no mist to see there).
- 2026-10-10 (agent): the Phase 2 desktop proof names `scripts/verify-starter-desktop.mjs`, because the starter's `survives` scenario returns `TN_PLAYTEST_UNSUPPORTED_ON_TARGET` for its network diagnostics on `--target desktop`.
- 2026-10-10 (native screenshot defect): Severe posterization and speckle already appear in the original lossless capture, so JPEG compression is not the root cause. A fresh capture at `density: 0.0018` reproduces the defect on RTX 2080, Vulkan, driver 615.71.09. Disabling denoise does not remove it. Removing only `grade` from the scratch `authoredStageNames`, with grain kept, gives a smooth image. This points to the grade stage but does not prove the root cause. The captures are in `~/.cache/prd-560-work/`: `native/before-native.png`, `pr482-repro-20261010-230528/arm-a/out/after.png`, and `pr482-grade-isolate-20261010/arm-b/out/after.png`.

  The diagnostic scenario exits 1 because its expected stage-order assertions deliberately no longer match. This entry claims no gate pass. The scratch stage list now matches the original. The last Arm A `TN_RENDER_CHAIN` shows `grade` applied, so the earlier `lut:pending` marker is not final. PR #482 does not modify grade or postprocessing source.

  The feature omission is reproduced: `buildRequiredFeatures` in `context.cpp` does not request `Float32Filterable`, although the JS adapter advertises it. A one-line optional request and a regression assertion are implemented. The focused scratch probe exits 1 on host `b756382651baf8347434bdde63cae1b789d126f24f65d2c58ee11e16811ce23e` (`adapterHas=true`, `deviceHas=false`) and exits 0 on rebuilt host `61a2a88ca51094ef5db45324576f740ed13406156085218a099dcdcfad8e0c22` (`adapterHas=true`, `deviceHas=true`, `PROBE PASS`); logs `/tmp/cache/{old,fixed}-env.log`, with the matching NVIDIA driver environment. The complete WebGPU comprehensive binary remains red on an unrelated wgpu `invalid error filter` panic, reproduced without the fix; its new feature assertion passes on the fixed host. Corrected native images remain unverified. A fresh FogExp2 control with base `sky.ts` and `volumetricFog.ts`, mist disabled and no height-fog import, also reproduces the corruption: `pr482-base-control-20261010/artifacts/after.png`. Height fog is not required to trigger the defect. This control used the default packaged host; its exact embedded host identity remains unconfirmed.

  The Phase 2 native proof stays open, and this entry ticks no box. A non-blank check alone cannot accept a corrupted screenshot. The current `density: 0.0018` retune needs before and after captures at the same pose, two runs each. A fresh read-only judge must review them under the root owner protocol. The earlier `density: 0.0012` proof stays in the file as historical evidence.
- 2026-10-11 (native grading correction): Built before/after hosts from the same source, differing only by the optional `Float32Filterable` request: before `d63426bf…`, after `61a2a88c…`. The same current-density starter, pose and grading-on render chain ran twice per arm on RTX 2080/Vulkan. All four render-chain scenarios exit 0. Original frames and labelled figures are under `~/.cache/prd-560-work/pr482-native-final/runs-scene/`; banners preserve the original pixels exactly. A fresh read-only Haiku 5.5 max judge returns IMPROVEMENT for pair 1, pair 2 and overall: continuous sky/cube shading and clean walls replace posterization, colored stipple and pink floor flecks; no new artifact. Existing far-ground speckle remains. This judgment covers the grading correction, not visible height-fog preservation or palette parity.

  Scope: these captures use the supported `--host-arg --bypass-ui-loading` scene diagnostic because the local host was built with `TN_ENABLE_UI_OVERLAY=OFF`. The ordinary attempts failed UI attachment before the playtest bridge; doctor exits 0. HUD is absent in both diagnostic arms, so the full native consumer proof and Phase 2 box remain open. Antialias is still dropped with `build:Image is not defined`; grade is applied in the last render-chain marker in every run. The screenshot defect is not an intentional fog effect, and the base FogExp2 control reproduces it without height fog.

- 2026-10-11 (develop integration): PR #478 / PRD-571 histogram exposure landed on `develop` at `b4e74627f`. Its source merges cleanly with height fog; only the combined scaffold hashes conflict. Exposure changes the rendering baseline, so AC-1a, AC-1b, AC-2 and the eight-kit runtime box are reopened for the integrated candidate. Earlier receipts above remain historical, not current-candidate acceptance. Pure fog-math and instruction-sync boxes are unaffected. New visual, GPU-cost and native HUD captures must use the merged template render source.

- 2026-10-11: Combined exposure browser captures completed: three poses, two runs per arm, NVIDIA/Turing headed 1920x1080. Fresh read-only judge returned NEUTRAL overall (default neutral, high neutral/mixed, ridge improvement in both runs); the arena low band is not shown clearly. AC-1 and visual phase boxes remain open. Figures: `~/.cache/prd-560-work/pr482-integrated-web/figures/pr482-web-{default,high,ridge}-before-after.png`; verdict: `/tmp/pr482-web-integrated-judge.log`.

- 2026-10-11 (starter density 0.0021): the combined-exposure judge at `density: 0.0018` (entry above) returned NEUTRAL overall, and the arena low band was not shown clearly. That judge did not pass AC-1, so AC-1 stayed open. The starter alone now ships `density: 0.0021`. Other kits keep their existing values, because the integrated histogram exposure changed only the starter. The `0.0021` browser proof is recorded in AC-1a and AC-1b. Gates on the promoted source: 127 focused tests pass (height-fog 23, template 38, scaffold 66), and `pnpm capabilities:check` exits 0. AC-2 and the Phase 2 native box are reopened for a `density: 0.0021` refresh, and their `0.0018` receipts are historical.

- 2026-10-11 (CI repeatability): run 38125885242 timed out in native profiling, browser provenance capture and exposure cold boot. All three jobs passed in run 38123225094 with the same runtime source; the intervening commit changed the coverage report and PRD only. The isolated shooter asset suite passes locally (3 tests; compilation 37 seconds), while the later full CI run hit its 60-second compilation watchdog. Causes remain unproven; no assertion, sample count or timeout was relaxed.
