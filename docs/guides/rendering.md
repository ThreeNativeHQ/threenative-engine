# Rendering

Set up the renderer, style your scene with plain Three.js, and find out where each frame spends
its time.

## Renderer settings

The generated game passes `renderer: config.renderer` to `defineGame`, so you set rendering options
in `threenative.config.ts`.

```ts
renderer: {
  preferWebGPU: true,
  resolutionScale: "auto",
  alphaAntialiasing: true,
},
```

The default engine draws with WebGPU and has no WebGL2 path. A browser without WebGPU fails to
start with `TN_NO_RENDERER`, whose message carries the WebGPU failure behind it. `engine:
"threejs"` is the one exception: upstream Three.js keeps its WebGL2 renderer there, and
`ctx.renderer.kind` says which is active (`"webgpu"` or `"webgl2"`). GPU compute features need
WebGPU, so ship a simpler effect rather than a second renderer.

`resolutionScale` defaults to `"auto"`, which scales the 3D drawing buffer to hold the
`display.maxFps` budget. On a desktop the floor is `1`: its chain has no temporal upscaler to
reconstruct dropped pixels, so it holds full resolution and reports `TN_RESOLUTION_FLOOR` once
instead of spending them. A host whose chain does reconstruct the frame brings the rungs back, and a
mobile host starts one rung down. CSS, UI and camera framing never change. Set a number in `(0, 1]`
to pin the scale, for example when you compare two versions of an effect.

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

## The default look and its overrides

A scene with no look options gets the stock Unreal 5.8.3 look: the filmic tone curve and metered auto
exposure. `WorldEnvironment` is the node that runs it. Built with no options it starts from the
`high` tier, and every field you pass wins over the tier:

```ts
import { qualityPreset, qualityTiers, WorldEnvironment } from "@threenative/core";

const tier = qualityTiers.resolve({ gpuClass: ctx.renderer.gpuClass });
const world = new WorldEnvironment({ ...qualityPreset(tier), bloomEnabled: false });
ctx.add(world);
```

| Option | Does |
| --- | --- |
| `tonemapMode` | The curve: `"filmic"` (the default), `"aces"`, `"agx"`, `"neutral"` or `"none"`. |
| `autoExposureEnabled: false` + `exposure` | Stops the meter and pins the exposure. The override is reported, never silent. |
| `qualityTiers` | The tier tables: `resolve` picks a start tier from the GPU class, `gi` and `shadow` read one tier's settings. An unknown name throws with the names it expected. |
| `Daylight` | The outdoor rig: physical sky, one sun with shadows that follow the eye, hemisphere fill, sky-coloured haze and the AgX curve. Every value is required. |

The environment builds the stage factories and hands them to `ctx.renderer.createRenderChain()`,
which chooses the order, refuses a stage this target cannot run, and prints `TN_RENDER_CHAIN`
naming each stage as applied or refused with its reason. A stage that silently did nothing is
therefore never mistaken for one you turned off. Colours, strengths outside a tier and the exposure
are arguments you pass, and they stay in `src/render/`. Auto exposure has its own page:
[auto exposure](../../packages/create-threenative/agent-docs/references/auto-exposure.md).

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

## What the engine already batches

Static meshes that share a material merge into one draw with no call from the game. The pass waits
until the scene has stopped changing, merges only appearance-neutral meshes — opaque, one material,
a plain `position`/`normal`/`uv` geometry, no skin, morph, instancing or vertex displacement — and
brings a source back the moment you move, hide, re-material or re-add it. A raycast against the
merged mesh still names your authored mesh.

Two overrides, both reported: `userData.batch = "off"` on a mesh or any ancestor keeps that subtree
out, and `autoBatch: false` in `defineGame` turns the pass off. It prints `TN_AUTO_BATCH` as it
merges, and once when it is off.

`markStatic(root)` is the other half, and it is never automatic: it composes a subtree once and
freezes it, so scenery stops recomputing its matrices every frame. A change deeper inside a frozen
subtree must be announced with `invalidateStatic(object)`; `TN_RENDERLIST_VALIDATE=1` is what proves
it happened. Staticness is authored, never guessed.

## Global illumination, reflections and virtual shadows

These stages are the owned engine's Lumen-shaped path. The game builds and drives each one; the
chain decides the order and names a refusal in `TN_RENDER_CHAIN`.

| Stage | Answers |
| --- | --- |
| `ScreenProbeGather` | Bounce light that reads the room off screen: one probe per 16 × 16 pixels, an 8 × 8 octahedron of rays each, filtered into an irradiance octahedron. |
| `SurfaceCache`, `SurfaceLights` | What a traced ray reads where it hits: albedo and glow from a material atlas, plus the brightest eight local lamps. |
| `TracedReflections` | Reflections of geometry behind the camera, from a packed snapshot of static triangles. |
| `ShortRangeAO` | Contact occlusion, as `rgb` bent normal and an open-hemisphere share that multiplies indirect light only. |
| `GIBudget` | What GI costs against the frame period, and whether the frame fits its period less 10% headroom. |
| `VirtualShadowNode` | One sun whose shadow covers a large map at several resolutions. |

`ShortRangeAO` replaces GTAO while dynamic GI runs, so a gathered frame is not darkened twice. The
method a `GIBudget` observes (`none`, `irradianceField`, `screenProbeGather`) never changes while the
game runs: the resolution scale is the run-time lever, and the GI pass follows it.

`VirtualShadowNode` attaches as the sun's own shadow node and reports `TN_VIRTUAL_SHADOW`:

```ts
const sun = new DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.shadowNode = new VirtualShadowNode(sun, { clipExtents: [12, 40, 120] });
```

Every strength, colour and extent is an argument, and appearance stays in `src/render/`.
`ScreenProbeGather` is the owned engine only: under `engine: "threejs"` the upstream node has no
probes and `gather()` refuses with a reason.

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
