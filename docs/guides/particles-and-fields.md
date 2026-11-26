# Particles, fluids and fields

Emit sparks and smoke, simulate cloth and water, and stream grass and props around the player,
while every colour, texture and count stays in your `src/render/`.

## What each system is for

All of these export from `@threenative/core`. Add them with `ctx.add(...)` so attach, per-step
dispatch and release follow the scene.

| Export | What it does | Runs on |
| --- | --- | --- |
| `GPUParticles3D` | Your own particle surface and process function, dispatched through a pooled system | WebGPU compute |
| `TracerPool3D` | Pooled travelling bullet streaks for hitscan shots | Any renderer |
| `FluidField2D` | A deterministic 2D velocity-and-dye field you sample in your own node | WebGPU compute |
| `FluidParticles3D` | Liquid as GPU particles: pour, splash, dam break, waterfall | WebGPU compute |
| `SoftBody3D` | Cloth and deformable bodies, optionally skinned to a mesh | WebGPU compute |
| `HairStrands3D` | Strand simulation with colliders | WebGPU compute |
| `SpectralOcean` | Cascaded wave spectra inverse-transformed each frame | WebGPU compute |
| `RippleField` | A disturbance propagating across a finite patch of water | CPU |
| `WaveField` | Analytic waves on the CPU, displaced by a matching TSL graph | CPU + TSL |
| `WaterSurface3D` | Mirror, refraction and depth for a surface you draw yourself | Any renderer |
| `GrassField3D` | Instanced grass in chunks around the camera, with pushers | CPU + TSL |
| `ScatterField3D` | Instanced copies of any baked mesh, thinned by distance | CPU |
| `WindField3D` | One world wind velocity that cloth, hair and grass read | CPU |

## Use a gallery preset

Import a named factory from `@threenative/core/vfx` when a game needs one stock effect.
For a picker, read `VFX_PRESETS` from `@threenative/core` and pass the selected ID to
`createVfxPreset`. The factory returns the layers to add to the scene, including both layers
of Portal Vortex.

```ts
import { createVfxPreset } from "@threenative/core";

const effect = createVfxPreset("impact-sparks", { scale: 1.5, tint: "#ff8844" });
for (const layer of effect.objects) {
  layer.position.copy(impactPoint);
  ctx.add(layer);
}
```

Call `effect.replay()` to retrigger a burst and `effect.dispose()` when the game removes the effect.
An `intensity` of zero holds the effect at its current starting frame.

## Compute-driven systems fail closed

The compute-driven systems need a WebGPU renderer. On a backend without compute they throw a named
error when they attach — they never draw an empty frame that looks like a quiet effect. A stage that
wants them checks the renderer first:

```ts
if (ctx.renderer.kind !== "webgpu") return;
ctx.add(new FluidParticles3D({ capacity: 4096, /* … */ }));
```

That is also the honest answer for the default engine: it is WebGPU-only, so a game shipped for
WebGPU only can rely on these. A game that also serves `engine: "threejs"` browsers gets both paths
from one `kind` check.

## Fields draw nothing

`FluidField2D`, `WaveField`, `RippleField`, `SpectralOcean`, `WaterSurface3D` and `ScatterField3D`
draw nothing on their own. They expose heights, samplers or instanced batches that your material
reads, so the mesh, the material and every colour are yours. A water surface, for example, is a
plane you own whose material reads the reflection and refraction the field provides.

## Read a throttled copy, never the live GPU state

A compute-driven system answers `sample`, `stats` or `height` from a copy that lags the GPU by a few
frames and reports `staleFrames`. Use it for gameplay that tolerates a frame or two, such as a boat's
lift or a splash trigger. For a value the simulation must agree with exactly, use an analytic field:
`WaveField.heightAt` is the CPU truth.

## Appearance stays yours

Every one of these takes its counts, sizes, colours and timing as arguments, and a stock look from
the template's `src/render/` is a starting point rather than a framework look. Edit those files
freely: the shapes, materials and effects are yours, while pooling, lifetime, billboarding,
instancing and dispatch are what the engine owns.

## Source

- [particles.ts](../../packages/core/src/particles.ts)
- [fluid-particles.ts](../../packages/core/src/fluid-particles.ts)
- [softbody.ts](../../packages/core/src/softbody.ts)
- [ocean/spectral.ts](../../packages/core/src/ocean/spectral.ts)
- [grass-field.ts](../../packages/core/src/grass-field.ts)
