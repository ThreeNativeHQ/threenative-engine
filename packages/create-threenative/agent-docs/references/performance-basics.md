# Performance basics — what the engine already does, and what you choose

Every frame this framework runs the same measured loop. Some performance work is done for you;
the rest is a content choice only the game can make. This page is the short list of both, so you
reach for the right abstraction before you profile anything.

## The split

- **The engine decides what it can measure where it is used**: world-transform preparation, scene
  batching and projection, per-pass culling, resolution, load scheduling, asset cooking, first-use
  warmup, and the frame meter. Do not hand-roll these — a hand-rolled version usually costs you the
  engine's version.
- **You decide what cannot be read from the code**: how much detail is on screen, how many objects,
  what never moves, how far shadows reach, how many particles. Those are content decisions, and the
  frame meter reports what they cost.

If you can measure the value where it is used, let the engine decide; a constant you are told to
revisit later is the engine's job, not yours.

## Automatic — leave it alone

- **Scene batching and projection.** The engine merges equal geometry and material into fewer draws
  and projects the authored scene automatically. A per-mesh `onBeforeRender` / `onAfterRender` hook
  that packs buffers or mutates geometry makes the whole scene decline projection. Put once-per-draw
  work in `ctx.beforeRender(fn)` instead: it runs after the frame's last fixed update and before
  projection packs, on the batched and unbatched paths alike.
- **Transform preparation.** Exactly one world-matrix preparation runs per actual world draw. Never
  call `updateMatrixWorld(true)` yourself, and do not set `scene.matrixWorldAutoUpdate = false`
  unless you then update the scene yourself. Marking a measured-static subtree
  `matrixWorldAutoUpdate = false` is allowed and the engine will skip it, but its parents must stay
  still. For one node that never moves, `node.updateMatrix(); node.matrixAutoUpdate = false` is the
  cheaper pair: it skips the per-object compose and leaves the walk intact.
- **Per-pass culling.** The main camera, each shadow and each reflection pass cull their own way,
  and the engine owns that. Do not set `frustumCulled = false` on a batch, and do not give one
  batch bounds that span the map.
- **The projected-size cut is yours to tune**, not the engine's: `renderer.minimumProjectedPixels`
  (default `0.5`; a shipped title raised it to `2`) drops what the render camera cannot resolve
  before it is submitted. Raise it before you write LOD machinery, and read `TN_PROJECTION` to see
  how many objects it actually drops. Shadow casters are never dropped on the main view alone, so a
  scene of small casters stays expensive — `castShadow = false` on props the cut would otherwise
  drop is the game's call.
- **Resolution.** `render.resolutionScale` defaults to `"auto"`: it starts at 0.85 for
  `mobile-low`, otherwise 1, then measured windows adapt it. `TN_GPU_CLASS` reports the WebGPU
  family once per launch. It holds GPU headroom and never lowers resolution on a CPU overrun; `TN_FRAME_BUDGET` reports the scale actually used. A number
  is the named pin override.
- **Quality.** Each template ships `src/render/quality.ts` (three tiers, platform default,
  `TN_QUALITY_TIER`) and `adaptiveQuality.ts` (measured frame windows). Use the tiers; do not invent
  a fourth switch.
- **Loading.** `loadAll(items, load)` loads with bounded concurrency and returns results in the
  input's order. `addInSlices(objects, add)` attaches hundreds of objects across frames. A pool that
  pushes results lands a different asset every load.
- **Assets.** The build cooks textures to KTX2/Basis, deduplicates model images and reports bytes;
  `assets.budget` fails the build over a ceiling. Do not ship unpacked 4K textures and plan to
  optimize later.
- **First use.** `warmUpScene(scene, camera)` compiles what a scene needs in slices, presenting a
  frame between each. Warm up the real scene before interactive play; do not pre-touch every
  possible variant.

## Where the frame actually goes, in that order

Ask these three questions before you profile anything, because they decide who owns the fix:

1. **Is the GPU busy?** `TN_FRAME_BUDGET` carries `gpuMs`. A frame with a 16 ms `render` phase and a
   2 ms GPU is not a rendering problem — the GPU is idle and waiting for JavaScript.
   `gpuMs` is sampled one frame in eight (`renderer.gpuTimestampFrameInterval`, default `8`): reading
   every pass of every frame cost native Midway 161 ms/s of main-thread JavaScript.
2. **How many objects does the scene walk?** `TN_PROJECTION` reports `considered`, `culled`,
   `exemptShadowCasters` and `exemptFrustumCulled` for the frame. Three.js visits every object once
   per pass (main, each shadow, each reflection) and that visit is roughly 2 µs each on a desktop
   core: 1,600 objects is ~3.5 ms of a 16 ms render before a single draw is issued. This is the
   number to move, and the only lever is fewer objects.
3. **Is it the engine's own work?** It usually is not: measured on a 1,561-mesh game, the engine's
   whole share — camera cull, frame-op recorder, frame meter — was under 1.5 ms of a 20 ms frame,
   with the rest being three.js's walk over the game's scene plus the game's own `update`.

A GPU that is idle with a slow `render` phase is an object-count problem, not a graphics problem.

## Reach for these before you write your own

| You have | Use | What it gives you |
| --- | --- | --- |
| Many copies of one shape | `InstancedBatch` | One draw, no per-copy mesh |
| Many *different* shapes that never move relative to each other — a ship, a rig, a building, the static parts of an imported model | `mergeParts` | One mesh per material, so the walk visits one object instead of dozens; pass `preserve: ["uv", "normal"]` when the pieces carry authored normals or texture UVs |
| One over-detailed body seen at many distances | `ClusteredBatch` / `ClusteredMesh` | Each copy submits the detail its distance earns |
| A particle surface | `GPUParticles3D` | Pooled dispatch, game-owned appearance |
| Bullet streaks | `TracerPool3D` | Pooled travelling meshes |
| A sprite that faces the camera | `Billboard3D` | No hand-written per-frame orientation |
| One directional shadow over an open world | `VirtualShadowNode` | Camera-centred, texel-snapped clip levels; movers sort themselves; `trackCaster` pins one, `pinStatic` excludes one |
| Distance detail swaps | three's `LOD` | Standard, and the engine can still batch it |
| Raycasts over a large static scene | `GPUSceneBVH` / `ScenePicker` | Built once, queried many times |

## The shortcuts that cost a frame

- One mesh per bullet or particle. Pool them (`TracerPool3D`, `GPUParticles3D`) or instance them.
- A fresh `Vector3`, array or object per entity inside `update`. Hoist it out of the loop and reuse
  it; allocation shows up as GC in the trace, not in the average.
- A per-mesh render hook that packs buffers. That is `ctx.beforeRender` once per draw.
- Many shadow-casting lights, or one 4K shadow map for a whole valley. One directional light plus
  `VirtualShadowNode`.
- The same large equirect on `scene.background` and `scene.environment`. The environment light is
  charged again and moves in power-of-two steps — see `node_modules/create-threenative/agent-docs/references/mobile-memory-budget.md`.
- A unique material or texture per copy. Share materials and images; the batcher merges equal
  material and geometry.

## Measure, then change one thing

`TN_FRAME_BUDGET` reports `fps`, `gpuMs` and the five phases (`update`, `render`, `overlay`,
`residual`, `hostGap`) plus per-pass draws and triangles; `TN_PROJECTION` reports the object census
(`considered`, `culled`, `exemptShadowCasters`) and the cut's threshold; `TN_RENDER_PROJECTION`
reports whether the scene batched and, when it did not, the reason. Launching with `DEV_MODE=true`
turns on the engine's dev surfaces (backtick opens the object and geometry inspector) and puts the
scene-shape verdict in a corner chip, so the engine's own finding is on screen while you play instead
of after you grep. It draws the verdict alone: the loop's rAF rate is throttled under a compositor or
a virtual display, so a frame rate read off that chip — or off a screenshot — is a number that lies
exactly when someone is measuring. `npx @threenative/playtest perf` turns a log into a windowed
report. When the percentile is
bad but the cause is not obvious, `node_modules/create-threenative/agent-docs/references/trace-a-slow-frame.md` names the function before you
change a line.

## Static checks, and what they cannot tell you

`pnpm check` runs the strict typecheck, ESLint and a Biome format check, and `pnpm test` runs it
first. ESLint fails on a floating Promise and on an async callback given to a synchronous slot, and
it warns when a `new Vector3()`-style math constructor runs directly inside `Scene.update`,
`Scene.render` or a `ctx.beforeRender` callback. That warning is a prompt to measure, not a
finding: reuse an instance the scene owns only if `TN_FRAME_BUDGET` shows allocation pressure.
It does not follow helper calls, so a quiet result is not proof a frame allocates nothing. A
suppression needs a reason: `// eslint-disable-next-line <rule> -- <why>`. Lint does not prove a
frame rate, a resource leak or native portability; the playtest and the meters do.
