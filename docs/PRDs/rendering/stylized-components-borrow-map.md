# Stylized-components — portable mechanisms worth absorbing

Filed 2026-09-03 against engine `fa647b34`. Source read at
[`cortiz2894/stylized-components`](https://github.com/cortiz2894/stylized-components) commit
`c0c02c47971e70b214a25de01ac9633e7608fc84` (2026-08-20, MIT). No upstream code or assets have
been copied.

The source is a Next.js/R3F/WebGL gallery, not an engine. Its useful contribution is the failure
knowledge inside the components: depth attachments disappear when a composer rotates buffers,
Kuwahara cost is pixels times brush radius, invisible shadow catchers can still produce outlines,
and a water simulation needs fixed-step ping-pong state rather than a pretty fragment shader. The
intake below keeps those lessons while using ThreeNative's existing WebGPU/TSL and native paths.

## Ranked slices

Land them in order. PRD-347 is both useful alone and the integration seam PRD-348 needs.

| # | PRD | Layer | Complexity | User-visible result |
| --- | --- | --- | --- | --- |
| 1 | [347 — game-authored post stages enter the measured chain](PRD-347-game-authored-post-stages-enter-the-measured-chain.md) | `core` mechanism + generated starter source | 6 → MEDIUM | The starter's ink outline is ordinary `src/render/` code, ordered and reported by the existing chain rather than hidden in a second composer. |
| 2 | [348 — painterly paint is generated source and pays for its pixels](PRD-348-painterly-paint-is-generated-source-and-pays-for-its-pixels.md) | generated starter source only | 6 → MEDIUM | The high tier turns the starter into a measured painterly frame; lower tiers retain the same art direction at bounded cost. |

## The ownership split

The source contains good algorithms but packages them in the wrong ownership shape for this
repository.

- `RenderChain` ordering, availability, tier drops, lifecycle and reporting are framework
  mechanism. Today it rejects every stage name outside a closed engine list, even though the stage
  implementation is already supplied by the game. PRD-347 opens that seam without adding outline,
  paint or paper to the engine vocabulary.
- Sobel thresholds, ink colour, brush radius, paper grain, quantisation and stage order decide the
  look. They ship as generated `src/render/` source under PRDs 347–348. A game can replace the whole
  appearance without editing `packages/`.
- React Three Fiber, Leva, `postprocessing`, `ShaderMaterial`, raw GLSL and WebGL render targets do
  not enter any package or template. The port uses the installed Three.js TSL graph and the
  renderer the game already owns.

## Borrow map at `c0c02c4`

| Upstream source | Intake | Why |
| --- | --- | --- |
| `src/components/outline/OutlineFilter.tsx:10-198` | PRD-347, rewrite in TSL generated source | Eight-tap Sobel, scale-normalised depth threshold, physical-pixel texels and the invisible-depth-writer failure are useful and cheap. |
| `src/components/painterlyStarter/PainterlyStarter.tsx:52-72,215-268` | PRD-348, preserve ordering tests rather than JSX | The reference proves outline → paint → grade as one visible vertical slice and exposes each layer independently. |
| `src/components/kuwahara/AnisotropicKuwaharaPass.ts:20-226` and `glsl/*` | PRD-348, algorithm only | Two-pass half-float tensor plus edge-preserving anisotropic filter; no second scene render. The source's matrix-composition warning becomes a negative control. |
| `src/components/watercolor/WatercolorFilter.tsx:9-127` | PRD-348, rewrite without its private ACES curve | Luminance quantisation and procedural paper are useful look source; ThreeNative's existing final tone map remains the only tone map. |
| `src/components/waterFloor/components/WaterWaveSimulation/*` | Read, do not file | A distinct shallow-wave PDE is real, but there is no committed consumer and `FluidField2D`, `WaveField`, `SpectralOcean` and the compute lifetime already occupy the mechanism space. File only when a game needs height/normal output that none can supply. |
| `src/components/waterFloor/components/WaterDepthIntersection/*` | Reject as duplicate | `WaterSurface3D` already exposes metres of water beneath a pixel without the reference's extra full-resolution depth render. The line/glow remains a game material choice. |
| `src/components/waterFloor/index.tsx` ripple store and hooks | Generated game pattern, no PRD | A bounded event array plus surface-crossing test is portable ordinary state; speed, width, decay, colour and ring count are all look. |
| `src/components/waterFloor/components/WaterSparkles/*` | Use existing mechanism | `GPUParticles3D` already owns pooled compute/dispatch while the game owns star geometry, colour and lifetime curve. |
| `src/components/grassField/utils/scatter.ts:15-309` | Use Three.js / existing PRDs | `MeshSurfaceSampler` already supplies weighted surface sampling; `InstancedBatch` supplies assembly; PRDs 255 and 340 own high-count GPU placement. A fourth sampler would fail the kill switch. |
| `src/components/grassField/shaders/*`, `materials/*`, `presets.ts` | Keep as game-authored inspiration | Shared dirt masks, wind, translucency, flower cut-outs and seasons are one coherent look. They must not become engine defaults or a preset catalog. |
| `src/components/grass/ShadowController.tsx` | Use stock Three.js or `VirtualShadowNode` | `LightShadow.autoUpdate/needsUpdate` already freezes a small static shadow; `VirtualShadowNode` owns cached large-world shadows and movers. No wrapper is missing. |
| `src/components/skyDome/SkyDome.tsx` (1,560 lines) | Reject as package intake | `Atmosphere` already owns portable LUT mechanism. Gradients, moon, stars, aurora, clouds and four mood presets decide the game look. |

## Evidence that changes the next action

Current `packages/core/src/render/chain.ts:528-553` rejects an `IRenderChainStage` unless its name is
in `RENDER_CHAIN_STAGE_ORDER`, then sorts requests by that same closed list. This is the concrete
gap: generated source can author a node, but cannot put it through the framework's tier,
availability and `TN_RENDER_CHAIN` reporting contract under its own name.

Everything else in the survey has an incumbent or is appearance source. The next implementation
action is PRD-347 Phase 0: make the existing starter-look scenario fail when an outline stage is
requested but rejected, before changing `RenderChain`.
