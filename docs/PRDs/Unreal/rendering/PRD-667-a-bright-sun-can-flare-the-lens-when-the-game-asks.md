---
prd_contract: v1
---

# PRD-667 — A bright sun can flare the lens, and bloom can take any kernel, when the game asks

**Status:** NOT STARTED — deferred behind its Phase 1 gate. Both features are off in a fresh Unreal project. Revisit when Phase 1 passes, or when a game asks for lens ghosts or a custom bloom kernel (a star or streak shape, a cinematic capture).
**Priority:** P3 — AC-1 to AC-3 are open: no template can turn on lens ghosts or a kernel-shaped bloom. Unreal ships both off, so the default look does not change.
**Complexity:** 4 (MEDIUM) — 6–10 implementation files (2), a new GPU FFT module (+2); risk override: none
**Owner:** João
**Depends on:** PRD-636 (`docs/PRDs/Unreal/look/`, on the Unreal-look epic branch). It owns the default sum-of-Gaussians bloom, and this PRD composes on that bloom. Its 2026-10-19 decision keeps the lens flare off by default, and this PRD does not change that.

## Context

### What Unreal does (UE 5.8.3, read 2026-10-21)

**Lens flares are off in a fresh project.** The project setting `r.DefaultFeature.LensFlare` is 0,
and when it is 0 the view sets the flare intensity to 0.
`UE 5.8.3: Engine/Source/Runtime/Engine/Private/SceneView.cpp:227-233, 2096-2099`. The settings
under that switch are:

- **Defaults:** intensity 1, white tint, bokeh size 3% of the view width, threshold 8.
  `UE 5.8.3: Engine/Source/Runtime/Engine/Private/Scene.cpp:536-540`. Eight per-ghost tints. Each
  alpha (0.6 down to 0.15) sets that ghost's scale. `Scene.cpp:637-644`.
- **Pass 1, scatter:** every pixel of a downsampled scene that is brighter than the threshold draws
  one bokeh-shaped quad, additively, into a target with a guard band of 2× so that the bokeh does
  not clip. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessLensFlares.cpp:164-200`.
  The shape is the engine's default bokeh texture unless the settings give one (`:414-432`).
- **Pass 2, ghosts:** the scattered texture is drawn eight times as quads that scale about the screen
  centre. Each scale is `(alpha × 7 − 3.5) × 2`, so a small alpha gives a negative scale, which
  mirrors the ghost through the centre. Each ghost takes its tint and the intensity divided by the
  guard-band area. `PostProcessLensFlares.cpp:318-345`.
- **Coupling:** the flare intensity is multiplied by the bloom intensity, and the result is added
  into the bloom output (`:294, 441`). A flare is off when the quality is 0, the tint is black,
  or the size or intensity is 0 (`:387-397`).
- **Scalability:** `r.LensFlareQuality` is 0 at `PostProcessQuality@0` and `@1`, 2 at `@2` and `@3`,
  and 3 at `@Cine`. `UE 5.8.3: Engine/Config/BaseScalability.ini:573, 595, 630, 667, 707`.

**Convolution bloom is not the default method.** The default is the sum of Gaussians
(`Scene.cpp:453`). Unreal's own enum text says the FFT method is for cinematics and too expensive
for games. `UE 5.8.3: Engine/Source/Runtime/Engine/Classes/Engine/Scene.h:54-60`. Under that method:

- **Defaults:** intensity 1, scatter dispersion 1, size 1 (the kernel spans the screen width),
  centre (0.5, 0.5) (`Scene.cpp:472-475`). Bright-pixel boost: min 7, max 15000, multiplier 15, and
  buffer scale 0.133 (`Scene.cpp:480-483`). The kernel is an engine texture
  (`UE 5.8.3: Engine/Config/BaseEngine.ini:162`).
- **Sizing:** the image is padded by half the kernel width so that the convolution does not wrap,
  and each axis rounds up to a power of two. The renderer picks the transform order that writes less
  memory. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessFFTBloom.cpp:741-795`.
- **The FFT keeps a whole scan line in group-shared memory,** up to 4,096 samples.
  `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/GPUFastFourierTransform.cpp:21-24, 950-956`.
  4,096 complex float32 samples are 32 KB. The WebGPU default for
  `maxComputeWorkgroupStorageSize` is 16 KB, so a ThreeNative FFT needs several passes per axis.

Unreal LOC: 2,729 lines in the feature map row "Bloom and lens flare", plus 2,837 lines of the GPU
FFT (`GPUFastFourierTransform.cpp` and `.usf`).

### What ThreeNative does today

- Every template's bloom is three's `BloomNode`, applied in
  `packages/create-threenative/templates/*/src/render/worldEnvironment.ts:905`. On this branch the
  starter `high` tier uses strength 0.22, radius 0.6 and threshold 1
  (`packages/create-threenative/templates/starter/src/render/quality.ts:106-110`). PRD-636 replaces it
  with Unreal's six-Gaussian bloom on the epic branch.
- No template or package uses a lens flare (`rg -i lensflare packages examples`, 2026-10-21).
  [PRD-343](../../rendering/PRD-343-a-light-smaller-than-a-pixel-is-still-a-light.md) ships no
  flare on purpose.
- Pinned three 0.185.1 ships `three/addons/tsl/display/LensflareNode.js`. It is a screen-space
  "pseudo lens flare" that reads a bloom texture and draws ghosts that pivot around the centre.
  This is the same idea as Unreal's pass 2, without the bokeh scatter of pass 1.
- `RENDER_CHAIN_STAGE_ORDER` has `bloom` and no flare stage (`packages/core/src/render/chain.ts:19-37`).
- `packages/create-threenative/capabilities.json` has no lens-flare or convolution entry.

## Solution

**Both features are named options that are off by default, as in Unreal. Ghost tints, sizes,
threshold and kernel are the game's.**

| Unreal piece | ThreeNative module | Layer |
| --- | --- | --- |
| Lens flare ghosts, eight tints, threshold, intensity × bloom intensity | `lensFlare(bloomNode, options)` in `packages/create-threenative/templates/starter/src/render/lensFlare.ts` (new). It uses three's `LensflareNode` if Phase 1 judges it close. It adds into the bloom stage output. | template |
| Bokeh scatter (one quad per bright pixel) | Only if Phase 1 judges the stock node not close: a bright-pixel scatter pass in `packages/core/src/render/bright-pixel-scatter.ts` (new). The bokeh shape and size come from the game. | core |
| GPU FFT (multi-pass per axis on WebGPU) | `packages/core/src/render/fft.ts` (new). | core |
| Convolution bloom: kernel, boost, intensity | `bloomConvolution.ts` in the starter's `src/render/` (new). It replaces the bloom stage body when the game turns it on. | template |
| `r.LensFlareQuality` per tier | The starter's `quality.ts`: off at `low` and `medium`, as in Unreal. | template |

- **Port size:** about 500 to 650 ThreeNative lines with tests. The flare is about 60 lines with the
  stock node, or about 200 lines with the scatter pass. The FFT is about 350 lines, and the
  convolution bloom is about 80 lines.

## Acceptance Criteria

- [ ] AC-1 [local]: With the flare option on and the sun in frame, a fresh visual judge rates the ThreeNative frame CLOSE to an Unreal frame with `r.DefaultFeature.LensFlare=1` at the same pose. Criteria: the ghosts lie on the line through the sun and the screen centre, their order and tints match, and none shows with the sun out of frame. proof: same pose in both engines, headed `--browser-recipe webgpu`, two runs per arm, fresh read-only judge subagent — Evidence: pending.
- [ ] AC-2 [local]: The flare costs at most 0.3 ms GPU at 1080p on the RTX 2080 browser WebGPU lane, and the option off allocates and dispatches nothing. proof: `TN_FRAME_BUDGET` p50 delta from `node packages/playtest/dist/runner/cli.js perf`, on against off — Evidence: pending.
- [ ] AC-3 [local]: The desktop native host renders the flare to match the browser reference within tolerance. proof: `pnpm parity --target desktop --only-tests lens-flare` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Lens flare option | starter `src/render/worldEnvironment.ts` bloom stage → `lensFlare(bloomNode, options)` when the game turns it on | New, off by default | Phase 2, AC-1 |
| Convolution bloom option | starter bloom stage → `bloomConvolution(scene, kernel)` when the game turns it on | New, off by default. The sum-of-Gaussians bloom of PRD-636 stays the default | Phase 3 |

## Execution Phases

#### Phase 1: The gate
**Status:** NOT STARTED
**Files:** `examples/wasm-engine-boot/src/flare-page.ts` (new probe)
- [ ] The stock `LensflareNode` over the starter bloom is captured beside an Unreal frame with the flare on, at the same sun pose, and costed at 1080p. A fresh judge rates it CLOSE or NOT CLOSE against the AC-1 criteria. The result goes under `## Decisions`: keep the stock node if CLOSE and at most 0.3 ms, or add a scatter-pass box to Phase 2. proof: capture pair, judge verdict and `node packages/playtest/dist/runner/cli.js perf` (`TN_FRAME_BUDGET` p50 delta).
- [ ] A multi-pass FFT convolution of a 1024×512 padded image is costed on the RTX 2080 browser lane. The result goes under `## Decisions`: Phase 3 continues only if it costs at most 2 ms; otherwise Phase 3 is deferred with that number. proof: `node packages/playtest/dist/runner/cli.js perf` on the probe page.

#### Phase 2: The lens flare option
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/starter/src/render/lensFlare.ts` (new), `packages/create-threenative/templates/starter/src/render/worldEnvironment.ts`, `packages/create-threenative/templates/starter/src/render/quality.ts`, `packages/create-threenative/__tests__/lens-flare.spec.ts` (new), `packages/create-threenative/templates/starter/AGENTS.md` (and mirror)
- [ ] The option is off by default and builds no node. When it is on, it uses Unreal's eight tints, threshold 8 and size 3%, and it is off at `low` and `medium`. proof: `pnpm exec vitest run packages/create-threenative/__tests__/lens-flare.spec.ts`.
- [ ] AC-1 passes on the visual judge, and the starter template gate passes with the option off. proof: the AC-1 capture pair, judge verdict posted on the PR, and `pnpm test:templates` (starter).
- [ ] AC-3 passes on the desktop native host. proof: `pnpm parity --target desktop --only-tests lens-flare`.

#### Phase 3: The convolution bloom option
**Status:** NOT STARTED
**Files:** `packages/core/src/render/fft.ts` (new), `packages/core/src/index.ts`, `packages/create-threenative/templates/starter/src/render/bloomConvolution.ts` (new), `packages/runtime-native/conformance/scenes/shared/fft-bloom.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A single bright pixel convolved with a test kernel reproduces the kernel image within tolerance in the browser, with no wrap at the frame edge. proof: `node packages/playtest/dist/runner/cli.js examples/wasm-engine-boot/playtests/fft-bloom.playtest.json --browser-recipe webgpu`.
- [ ] The desktop native host matches the browser reference within tolerance. proof: `pnpm parity --target desktop --only-tests fft-bloom`.

## Decisions

- 2026-10-21 (filing): Both features stay off by default because Unreal ships them off. This keeps PRD-636's 2026-10-19 decision. Each is a named option on the bloom stage, so a game turns it on without package edits.
