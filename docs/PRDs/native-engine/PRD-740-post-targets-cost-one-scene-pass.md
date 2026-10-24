---
prd_contract: v1
---

# PRD-740 — The post targets cost one scene pass, and a steady frame records none of it

**Status:** NOT STARTED
**Priority:** P1 — Phase 3 is open: the merged pass and the compute cache must show their call counts on Hop Garden at tier high and pass the visual judge on three kits before they ship.
**Complexity:** 5 (MEDIUM) — 7 engine files, a shared render path (+2), a shader IR change (+1), a visual judge (+1)
**Owner:** João

## Context

On the web Wasm engine (`build/web/tn-native-engine-web.wasm`), Hop Garden at tier high on an RTX 2080
draws about 731 times a frame, with 1,417 `setBindGroup`, 79 submits and 78 render passes; the main
pass span p95 is 13.5 to 14.7 ms. With GTAO, SSR and SSGI off it draws 200 to 210 times. Most of
the difference is the post targets: each target a post effect reads (normal, metalness and
roughness, albedo, emissive) is one more full scene pass, and each pass encodes every opaque lit
draw again on every frame. The compute dispatches also create 30 to 43 bind groups a frame.

### What Unreal does (UE 5.8.3, read 2026-10-24; clean-room summary, no code copied)

- **One base pass writes the whole GBuffer.** The base pass pixel shader encodes the surface once and
  writes scene colour to the first target and the GBuffer to the next ones, with velocity as one more
  target when it is enabled (`UE 5.8.3: Engine/Shaders/Private/BasePassPixelShader.usf:2428-2435`).
  An unlit surface writes zero to the GBuffer targets (`BasePassPixelShader.usf:2388-2390`).
- **The encode packs several properties per target.** `EncodeGBuffer` packs normal, metallic,
  specular, roughness and the base colour into the GBuffer slots
  (`UE 5.8.3: Engine/Shaders/Private/DeferredShadingCommon.ush:968`, normal encode at `:137`).
- **The pass binds every target at once.** The renderer collects the GBuffer textures and binds them
  as one render target set with the scene depth (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/BasePassRendering.cpp:1012`,
  bindings at `:1138-1139`).

### ThreeNative before this PRD

- `Renderer::encodeFrame` drew a normal pass, a material pass, an albedo pass and an emissive pass,
  each a full scene pass with its own fragment, each direct-encoded every frame. The TRAA velocity
  pass was direct-encoded too. The main pass already replays a cached render bundle.
- `ComputePass::encode` asked the pipeline for its bind group layout and created a bind group on
  every dispatch.

### Phase 1 — one MRT pass for every post target

- [ ] `PipelineTarget` carries the colour formats after the first as a list that the pipeline cache keys on. proof: `ctest -R native_engine_renderer_pipeline`
  A single-format caller is unchanged.
- [ ] Each fragment output after `color` takes its own location, and albedo and emissive are program fields. proof: `tn-native-engine-material-test emissive_output`
  They were vertex-variant switches; the test holds the lit fragment's layout, the locations and the unfogged values.
- [ ] A graph that reads all four targets draws one MRT scene pass, replayed from a bundle on a steady frame. proof: `tn-native-engine-renderer-test aux_targets_one_pass`
  The TRAA velocity pass replays from its own bundle too.

### Phase 2 — a steady compute dispatch creates no bind group

- [ ] `ComputePass` keeps its layout and its 8 most recent bind groups, keyed on the bound resources. proof: `tn-native-engine-compute-test readback`
  It holds a reference to each bound resource while cached, so a recycled handle cannot hit a stale group.

### Phase 3 — measured and judged

- [ ] The native engine suites pass. proof: `ctest -L native-engine`
- [ ] The web Wasm engine builds. proof: `cmake --build build/wasm --target tn-native-engine-web`
- [ ] Hop Garden at tier high draws fewer calls per rendered frame than the baseline, steady window. proof: `measure.mjs` runs `before-1/2` and `after-1/2`
  Draws, `setBindGroup`, submits, render passes, `createBindGroup` and the main pass p95; headed Chromium, WebGPU, adapter `nvidia turing`.
- [ ] Visual judge on Hop Garden, Lantern Vale and Clover Cup, two runs per arm, returns NEUTRAL or better. proof: a fresh read-only Opus judge on `~/Downloads/mrt-merge-judge/`

## Decisions

- 2026-10-24, lane agent: **one MRT pass after the colour pass, not MRT on the colour pass.** The
  colour pass option needs every main program and pipeline, the main bundle formats, the viewport
  split pass, the render-target program variants and 4x MSAA textures per target to change, and the
  transparent, Basic and alpha-tested draws must then write zeros (an alpha-tested leaf would leave
  the background's targets under it). The merged pass stays inside the aux plan and encode code and
  keeps every skip rule. Recording the aux and velocity passes into cached bundles removes their
  per-frame encode cost, which is what the call counts measure.
- 2026-10-24, lane agent: **the merged fragment is the whole lit fragment.** The shader IR emits every
  statement, so the WGSL of an aux fragment still computes the lit colour before it overwrites it:
  a Standard fragment with a map and an environment is 557 lines lit, 558 lines as the old material
  fragment, 506 as albedo and 505 as emissive, with 7, 7, 5 and 5 `textureSample` calls. Before, each
  of the four passes paid most of that; now one pass pays it once. Whether the GPU driver drops the
  dead lighting is unverified. A normal-only frame keeps the small normal fragment.
- 2026-10-24, lane agent: **velocity stays its own pass.** It has its own vertex stage (previous-frame
  matrices) and its own skip set, so it cannot share the aux pass's pipeline. Unreal writes it in the
  base pass only because its base pass is the colour pass.
- 2026-10-24, lane agent: **at 4x MSAA every target draws single-sampled.** Before, the normal and
  material passes drew multisampled and the albedo and emissive passes single-sampled against the
  resolved depth with the LessEqual-plus-bias rule. The merged pass uses that rule for all four. TRAA
  forces one sample, so this applies only to tiers without TRAA.
- 2026-10-24, lane agent: **no feature-map row.** The map lists the base pass as covered, not a port
  target. This PRD borrows only the write-every-target-in-one-pass layout.

## Blocked on

- Nothing.
