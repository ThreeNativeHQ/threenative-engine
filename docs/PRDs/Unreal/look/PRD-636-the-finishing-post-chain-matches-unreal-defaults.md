---
prd_contract: v1
---

# PRD-636 — The finishing post chain matches Unreal's defaults

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: the template bloom, vignette, grade and motion settings were tuned by eye, and three of them run opposite to Unreal's defaults (thresholded bloom, a contrast grade, no motion blur).
**Complexity:** 5 (MEDIUM) — template post source in 13 templates (+2), a local-exposure stage that is new to the chain (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-631](PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 3 (the L9 row) and [PRD-632](PRD-632-the-frame-is-exposed-and-tone-mapped-the-way-a-fresh-unreal-project-is.md): bloom and local exposure act on the exposed scene-linear frame, so they cannot be compared before exposure matches. Anti-aliasing and temporal reconstruction belong to [PRD-539](../performance/PRD-539-low-resolution-temporal-reconstruction-quality-and-cost.md).

## Context

Layer L9 is the last rung of the PRD-631 ladder: everything a fresh Unreal project adds after
lighting.

| Stage | ThreeNative starter `high` | Unreal 5.8.3 default | Unreal source |
| --- | --- | --- | --- |
| Bloom | `BloomNode`, strength 0.22, radius 0.6, **threshold 1**: only the sun disk and emissives bloom | Sum of Gaussians, intensity 0.675, **no threshold**: every pixel blooms a little. Six stages: sizes 0.3/1/2/10/30/64 % × size scale 4, tints 0.3465/0.138/0.1176/0.066/0.066/0.061 | `Engine/Source/Runtime/Engine/Private/Scene.cpp:453-470` |
| Vignette | 0.22, `smoothstep(0.55, 1.02, r)` | 0.4, cosine-fourth law | `Scene.cpp:541` |
| Local exposure | none | Bilateral grid, highlight and shadow contrast 0.8 (set by the project generator), detail 1, blurred-luminance blend 0.6 | `Scene.cpp:525-532`; `Engine/Source/Editor/GameProjectGeneration/Private/GameProjectUtils.cpp:155` |
| Motion blur | off | Amount 0.5, at most 5% of screen width, desktop only | `Scene.cpp:646`; `Engine/Source/Editor/HardwareTargeting/Private/HardwareTargetingModule.cpp:250` |
| Grade | 9³ LUT: contrast 1.06, small RGB gains (starter only) | Neutral: every saturation, contrast, gamma and gain is 1; white balance 6500 K | `Scene.cpp:403-451` |
| Grain | 0.0039, animated (starter only) | 0 | `Scene.cpp:552` |
| Chromatic aberration, lens flare, depth of field | off | off (fringe 0; flare off by project feature; focal distance 0) | `Scene.cpp:452,537,606`; `Engine/Source/Runtime/Engine/Private/SceneView.cpp:228` |

Template values: `packages/create-threenative/templates/starter/src/render/quality.ts:104-167`,
`worldEnvironment.ts:897-992`, `grade.ts:112-143`. Platformer, racing and sailing use other values.

## Solution

All of it is look, so all of it lives in template `src/render/`. Core keeps only the chain
plumbing it already owns (`packages/core/src/render/chain.ts`).

1. **Bloom in Unreal's shape.** Six Gaussian stages at Unreal's relative sizes and weights, with no
   threshold, at half resolution. Phase 1 first checks whether three.js `BloomNode` (five mips) can
   reach the L9 cells with tuned weights. A new bloom node is written only if it cannot.
2. **Vignette** at Unreal's strength and falloff.
3. **Local exposure**: a small bilateral-grid stage with highlight and shadow contrast 0.8. It is
   new, so Phase 1 measures its cost first. It stays off at `low`, as Unreal turns it off on
   mobile (`Engine/Config/BaseDeviceProfiles.ini:411`).
4. **Motion blur** on at `high` on desktop, using the velocity buffer from
   [PRD-269](../../done/PRD-269-motion-vectors-or-the-temporal-filters-lie.md). It stays off on
   phones.
5. **Grade and grain go neutral** by default. Each template keeps its LUT and grain as a named
   option, so an art direction can turn them back on.

## Acceptance Criteria

- [ ] AC-1 [local]: The starter L9 cells match the Unreal L9 cells within the PRD-631 thresholds in all 12 poses. proof: `pnpm unreal-look:compare --layer L9` — Evidence: pending.
- [ ] AC-2 [local]: A visual judge subagent returns IMPROVEMENT against the current starter, with the Unreal frames as the target. proof: judge verdict on the PRD-631 contact sheet — Evidence: pending.
- [ ] AC-3 [local]: The finished chain holds the `high` frame budget on the RTX 2080 browser lane. proof: `node packages/playtest/dist/runner/cli.js perf` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Unreal-shaped bloom | `templates/*/src/render/worldEnvironment.ts` bloom stage | Replaces the thresholded `BloomNode` settings | Phase 2 |
| Local exposure | new stage before the tone curve in `worldEnvironment.ts` | New | Phase 2 |
| Motion blur default | `quality.ts` `high` preset on desktop | Turns on an existing opt-in stage | Phase 3 |
| Neutral grade and grain | `quality.ts`, `grade.ts` | The LUT and grain become named options | Phase 3 |

## Execution Phases

#### Phase 1: Measure what the stock nodes can reach
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/bloom-fit.ts` (new)
- [ ] `BloomNode` with fitted weights is scored on the L9 cells against Unreal, and the outcome (keep it or write a six-stage node) is recorded under `## Decisions`. proof: `pnpm unreal-look:compare --layer L9 --stage bloom`.
- [ ] The local-exposure stage cost is measured at 1080p on the RTX 2080 browser lane. proof: `node packages/playtest/dist/runner/cli.js perf`.

#### Phase 2: The starter matches L9
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/starter/src/render/{worldEnvironment,quality,grade}.ts`
- [ ] Bloom, vignette and local exposure are in place, and AC-1 passes. proof: `pnpm unreal-look:compare --layer L9`.

#### Phase 3: Every template, native included
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/`, `packages/runtime-native/conformance/scenes/shared/local-exposure.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] Local exposure and the new bloom render on the desktop native engine within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests local-exposure`.
- [ ] Motion blur is on at desktop `high` and off on phones, and the template gate passes. proof: `pnpm test:templates`.
- [ ] Every template defaults to the neutral grade and no grain, with the LUT kept as an option. proof: `pnpm test:templates`.
- [ ] Every affected template's `AGENTS.md` (and mirror) states the Unreal-shaped bloom, vignette, local exposure, motion blur and neutral grade, with the LUT (`grade.cube`) and grain as the named options, so a new project's agent knows the default and how to override it. proof: `rg -l 'grade.cube' packages/create-threenative/templates/*/AGENTS.md` lists every affected template, and `pnpm sync:agents --check` exits 0.

## Decisions

- 2026-10-19: Chromatic aberration, lens flare and depth of field stay off. Unreal's effective
  defaults are off too.
- 2026-10-19 (external visual review, checked): the emissive sphere's wide, low halo is bloom
  (threshold and radius, this PRD). Its light on the floor in Unreal is Lumen GI from an emissive
  surface (layer L7), owned by the GI PRDs, not by a default point light inside the mesh.

## Performance (2026-10-20)

Question: does the Unreal-look overlay (`scripts/unreal-look/scaffold/render/`) still hold the `high` frame budget (60 fps, 16.7 ms)? No box above is ticked. This is a measurement, not an acceptance result. AC-3 stays open because the lane below cannot present at display rate.

**Lane.** C++ Wasm engine in Chromium, headed on a private Xvfb at 1920x1080 (`TN_XVFB_SCREEN=1920x1080x24`, `--size 1920x1080`, scale 1, 4x MSAA). Adapter `nvidia` / `turing` (RTX 2080), never SwiftShader. Overlay: commit `1f103f09c` plus the harness hook in `52fca3bb8` (`--measure <s>`, `--size`, `--off <stage>`). Pose `sun60/exterior` (and `sun60/interior` where listed). Hold: 30 s after the 8 to 30 s settle, window 1 dropped by `playtest perf --file`. Meter: `TN_FRAME_BUDGET`, `gpuMs` sampled 1 frame in 8. Every run held the shared capture lock. The host was never idle: 1-minute load 12 to 37 on 24 cores in the valid rows, so the reader marks every absolute `invalid-absolute`.

**Read this first.**
- Xvfb presents a 1080p frame in 50 to 117 ms. The presented period (`presented`, 50 to 117 ms) is the Xvfb copy, not the engine. **No fps claim is made.** The loop also skips about 50% of renders under its 60 fps cap, so the callback p50 is diluted. The CPU render column is the p95, which stays on rendered frames.
- GPU time is the signal. During the holds the GPU sat at P5 (`nvidia-smi`: about 0.9 to 1.1 GHz SM, memory 810 to 5600 MHz, 22 to 35% utilisation). At P2 boost the same work takes less. Treat GPU ms as an upper bound at these clocks. Repeat runs of the same arm differ by up to 2 ms on the p50 and by 30% on the mean.
- Rows marked `x` ran at host load above 45 and are not used.

### Steady-state frame cost, exterior pose

| Arm | Runs | GPU ms mean (per run) | GPU ms p50 | GPU ms p95 | CPU render p95 ms | Host load |
| --- | --- | --- | --- | --- | --- | --- |
| L1 floor (sun, fixed exposure, tonemap) | 1 (+1 x) | 4.0 | 3.8 | 7.2 | 1.0 | 17 to 19 |
| Stock starter template, Play scene, auto scale | 2 | 12.4, 12.4 | 11.9, 11.4 | 13.0, 23.8 | 2.5, 2.4 | 13 to 17 |
| L9, every overlay stage off (stock shadow map, CPU sky, SMAA, vignette) | 1 (+1 x) | 5.5 | 4.6 | 12.6 | 1.6 | 16 to 20 |
| **L9 full** | 4 | 23.3, 22.8, 30.9, 21.6 | 23.2, 23.0, 24.6, 21.2 | 24.7, 24.3, 44.0, 24.8 | 16.2, 14.9, 15.9, 11.0 | 14 to 37 |
| L9 full, interior pose | 2 | 24.1, 21.7 | 25.2, 21.1 | 26.3, 29.7 | 11.8, 15.6 | 14 to 21 |

The stock starter is a different scene (the Play arena). It is a reference point only. L9 full is about 2x the stock starter and 4x the all-off floor on the same scene.

### GPU ms by stage (ablation, exterior pose, one run each, delta against the L9 full p50 of about 23 ms)

| Stage switched off | GPU ms mean / p50 / p95 | Delta p50 | Host load | Reading |
| --- | --- | --- | --- | --- |
| GTAO (full-res + denoise) | 10.2 / 7.6 / 19.9 | **-15.5** | 14 to 17 | Largest cost |
| Bloom (Unreal sum of Gaussians) | 14.9 / 12.8 / 22.2 | **-10.3** | 5 to 7 | Second cost (the first run, load 49, is void) |
| GI cache lookup (bake still skipped) | 17.8 / 18.2 / 22.1 | -4.9 | 12 to 17 | Third cost, also CPU: render p95 16 to 8 ms |
| SSR | 26.1 / 21.7 / 37.1 | -1.4 | 16 to 26 | Inside noise |
| Auto exposure (and local exposure) | 26.5 / 21.4 / 36.4 | -1.7 | 5 to 12 | Inside noise |
| Local exposure | 29.8 / 22.3 / 40.6 | -0.8 | 12 to 27 | Inside noise |
| Clouds | 28.0 / 24.6 / 40.8 | +1.6 | 7 to 9 | No saving visible |
| GPU sky to CPU bake | 31.6 / 25.3 / 43.3 | +2.1 | 30 | No saving visible; load 30, low confidence |
| Virtual shadow maps to stock 4096 PCF map | 30.5 / 34.8 / 38.3 and 30.0 / 34.7 / 37.5 | +11.6 | 30; 22 to 52 | Stock map costs more; two runs agree on the p50, both at high load |
| SSGI | 25.0 / 23.2 / 41.4 | +0.0 | 16 to 23 | **No-op.** The engine drops the stage at build in every L9 run: `TN_RENDER_CHAIN` lists `ssgi` as dropped, `TN_ABI_ARGUMENT TN_TSL_POST_INPUT: denoise input must be a texture node`. SSGI costs nothing because it does not run. |

Stage deltas do not sum to the L9 total: removing GTAO also removes the denoise passes that SSR and bloom sample, and the p50 noise is about 2 ms.

### Startup (page start to first L9 frame)

| Run | Host load | Page start to scene ready | GI cache bake (`TN_GI_CACHE`) | Bake share |
| --- | --- | --- | --- | --- |
| L9 full | 16 | 153 s | 137 s | 89% |
| L9 full | 15 to 21 | 215 s | 195 s | 91% |
| L9 full | 23 to 37 | 273 s | 250 s | 92% |
| L9 minus bloom, quiet host | 5 to 7 | 121 s | 106 s | 87% |
| L9 all off (no GI cache) | 16 to 20 | 9.5 s | none | 0% |
| L1 | 17 | 6 to 12 s | none | 0% |

The bake is one synchronous CPU job in the scene `enter`. It scales with host load (106 s at load 5 to 7, 250 s at load 23 to 37). Everything else in startup is 16 to 23 s. Sky bake cost is below 1% of startup: `CPU environment sky 64x32` took 140 to 580 ms and `GPU sky LUT submission` 26 to 154 ms (GPU completion is unmeasured).

### What this means for the template defaults

- L9 does **not** hold the `high` budget on this lane: about 23 ms GPU at P5 clocks against 16.7 ms, and about 15 ms of CPU render p95 on the Wasm engine. The overshoot is real in order of magnitude. Its exact size at boost clocks is unverified.
- Three costs carry nearly all of it: GTAO (about 15 ms), bloom (about 10 ms) and the GI cache lookup (about 5 ms). The other stages are inside the 2 ms noise.
- To hold `high`, the defaults must leave out full-resolution GTAO with a denoise (use the `medium` sample count or half resolution), must price the Unreal bloom (a cheaper pyramid, or fewer than its six Gaussian stages), and must not bake the GI cache at every start (a 105 to 250 s bake: cache it, ship it baked, or cut the rays). With GTAO alone off the GPU time is about 8 ms median.
- Do not claim SSGI in any default: it is dropped by the engine at present.

### Not verified

- Presented fps and the boost-clock GPU time need a real display and a GPU that clocks up. Neither was available: the lane is Xvfb on a shared host with a GPU at P5.
- Bloom, clouds, GTAO, GI, SSR, exposure and VSM deltas are one run each, exterior pose only. VSM and GPU sky ran at load 22 to 52. The VSM reversal (stock map slower) repeated once with the same p50 and still needs a run on a quiet host. A repeat of L9 full on a quiet host (run `c-L9`, load 9 to 52) was void.
- Interior and the other sun poses were not ablated. Motion blur is not in the L9 harness. The native desktop engine, Android and the `medium` and `low` tiers were not measured.
- Per-stage GPU timestamps are not exposed by the engine. The ablation is the only attribution here.
- Raw logs: `perf-out/` under the lane scratchpad, not committed.
