# Rendering

Set up the renderer, style your scene with plain Three.js, and find out where each frame spends
its time.

## Renderer settings

The generated game passes `render: config.renderer` to `defineGame`, so you set rendering options
in `threenative.config.ts`.

```ts
renderer: {
  preferWebGPU: true,
  resolutionScale: "auto",
  alphaAntialiasing: true,
},
```

ThreeNative uses WebGPU when the host exposes it and falls back to WebGL2. `ctx.renderer.kind`
tells you which one is active (`"webgpu"` or `"webgl2"`). GPU compute features need WebGPU, so
ship a simpler effect or tell players WebGPU is required.

`resolutionScale` defaults to `"auto"`, which scales the 3D drawing buffer to hold the
`display.maxFps` budget. On a desktop the scale stops at 0.61 rather than spending pixels that
nothing reconstructs; phones keep the whole ladder. CSS, UI and camera framing never change. Set a
number in `(0, 1]` to pin the scale, for example when you compare two versions of an effect.

`alphaAntialiasing` smooths alpha-tested cutouts such as foliage, fences and hair. Set it to
`false` for a hard-edged look.

## Scene, camera and look

`ctx.scene` and `ctx.camera` are ordinary Three.js objects. `ctx.renderer.raw` is the underlying
Three.js renderer, for integrations that need it. Geometry, meshes and node materials work as
usual.

Your project owns `src/render/`: camera, lighting, materials, sky, post-processing and the
loading screen. Edit those files directly. Keep world scale consistent with physics, and tune
lighting and exposure together.

Put each kind of work in the right phase:

| Work | Where |
| --- | --- |
| Movement and gameplay rules | The scene update |
| A camera that follows a physics body | `ctx.afterPhysics(callback)`, which runs after physics writes transforms |
| Visual changes right before drawing | `ctx.beforeRender(callback)`, which runs once per rendered frame |

Both registration calls return a function that removes the callback.

## Frame budget

At 60 fps you have about 16.7 ms per frame. At 30 fps you have 33.3 ms. The fix depends on where
the time goes.

| Where time goes | What to check | What to try |
| --- | --- | --- |
| CPU updates and draw preparation | Object count, transform updates, draw calls | Batch repeated shapes, update objects only when needed |
| GPU | Resolution, overdraw, shadows, effects | Lower render resolution, simplify the costliest effect |
| Startup | Downloads, asset decoding, shader preparation | Load assets in stages, watch startup progress |
| Memory | Assets, sounds and callbacks left after a scene ends | Repeat scene changes and check cleanup |
| Animation | Active characters and clips | Measure animated characters apart from static scenery |

The `DebugOverlay` Geometry tab captures one frame and ranks the objects that submitted its
triangles. Press backtick to open the overlay. Check shadow and reflection passes too, since one
object can draw in several passes.

## Repeated objects

`InstancedBatch` collects placements of one geometry and material, then builds a single
`InstancedMesh`. You do not need the final count up front, which suits procedural levels.

```ts
import { InstancedBatch } from "@threenative/core";
import { BoxGeometry } from "three";

const posts = new InstancedBatch({ geometry: new BoxGeometry(0.2, 1, 0.2), material });
for (const x of fenceXs) posts.place({ position: [x, 0.5, 0] });
posts.build({ parent: ctx.scene, castShadow: true });
```

Level of detail (LOD) swaps in simpler geometry at a distance. The asset build can generate those
versions. Compare them from the gameplay camera before you keep them.

`GPUSceneBVH` builds a GPU-searchable snapshot of selected scene geometry for ray queries in
shaders. The snapshot stays static until you call `rebuild()`. Use physics queries for gameplay
collision.

## Measure a change

Keep the scene, camera path, random seed, resolution and build settings the same between runs.
Measure startup apart from gameplay.

1. Record frame times, backend and render resolution.
2. Change one setting or system and run the same test.
3. Check the image still shows what it must at the intended quality.
4. Repeat on your lowest-spec target and the packaged native build.

## Source

- [renderer.ts](../../packages/core/src/renderer.ts)
- [scene.ts](../../packages/core/src/scene.ts)
- [instanced-batch.ts](../../packages/core/src/instanced-batch.ts)
