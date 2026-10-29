# Stream a Blender-authored world by cell

A world larger than a few hundred metres does not fit one GLB, and loading it whole spends memory
and startup time on cells the player never sees. ThreeNative splits the job in three: Blender
authors a **world package**, the exporter writes the **v1 package format**, and `WorldCells`
streams that package around a followed point at runtime.

This guide is the authoring-to-streaming path. The format is binding in
[`world-package.ts`](../../packages/core/src/world-package.ts) — read the types there rather than
a copy here.

```mermaid
flowchart LR
  Blend["world.blend"] -->|blender_export_world / export_world.py| Package["world package v1"]
  Package --> Runtime["WorldCells.load"]
  Runtime --> Terrain["TerrainTiles terrain"]
  Runtime --> Instances["InstancedBatch props"]
  Runtime --> Chunks["chunk GLBs"]
  Follow["follow target<br/>(player or camera)"] --> Runtime
  Runtime --> Stats["stats(): residentCells, evictions,<br/>loadsInFlight, failures, pressure"]
```

## 1. Author the .blend

The exporter reads plain custom properties. Nothing is mandatory beyond the terrain marker.

| Marker | Where | Meaning |
| --- | --- | --- |
| `tn_world_terrain` | mesh object | Marks the heightmap mesh. Exactly one is required. |
| `tn_asset_id` | scatter emitter object | Stable id for an instanced asset. Falls back to the object name with a warning. |
| `tn_world_chunk` | collection | The collection's objects export as per-cell chunk GLBs. |
| `tn_max_distance` | scatter emitter | Cull distance in metres for that asset at runtime. |
| `tn_lod_distance` | scatter emitter | Overrides the default 60 m range at which the LOD1 is used. |

Hidden collections, excluded collections and `_`-prefixed collections are skipped, which is how a
game keeps construction geometry in the file without exporting it.

Scatter is read from the **render-mode** depsgraph, so a Geometry Nodes distribution switched by
`Is Viewport` exports at render density, not at the viewport share the author tuned for editing.
The emitter's Object Info node must set `As Instance = True`, or `instance_object` reports the
emitter instead of the asset and `tn_asset_id` is lost.

The exporter decides nothing about looks. Materials, colours, lights and curves come from the
.blend untouched; the runtime's terrain surface and any lighting are the game's, not the package's.

## 2. Export the package

Through the Blender MCP server (`threenative-blender`, package `threenative-blender-mcp`), call the
`blender_export_world` tool with `source`, `out` and `cell` (and optional `spacing`, default `2`).

From a shell, run the same recipe directly:

```sh
blender -b world.blend --python export_world.py -- --out /tmp/world --cell 64
```

The recipe is [`export_world.py`](../../packages/blender-mcp/gpl/recipes/export_world.py); it
imports `collapse_decimate` from `_common.py` for the LOD1 rather than reimplementing it.

The output directory is a package:

- `world.json` — the manifest: extent, cell size, terrain description, asset table, cell → run
  map and chunk list.
- `terrain/heightmap.u16` — raw little-endian `uint16`, `columns * rows` samples.
- `placements.bin` — little-endian `float32`, eight values per instance
  (`x, y, z, qx, qy, qz, qw, scale`), indexed by each run's `offset` and `count`.
- `assets/<id>.glb` and `assets/<id>_lod1.glb` — one model and one decimated LOD per referenced
  asset.
- `chunks/<collection>_<x>_<z>.glb` — per-cell chunks for every `tn_world_chunk` collection.

The exact shape of every field is in `world-package.ts` (`IWorldPackage`, `IWorldCell`,
`IWorldRun`, `IWorldAsset`). `validateWorldPackage` checks a parsed manifest — including the
heightmap and placement byte lengths — and collects every error with a named code instead of
throwing on the first.

## 3. Stream it at runtime

`WorldCells` lives at the `@threenative/core/world` subpath. Load a package, add it to the scene,
and let the frame drive it:

```ts
import { WorldCells } from "@threenative/core/world";
import { MeshNormalMaterial } from "three";

const world = await WorldCells.load({
  assets: ctx.assets,
  url: "world/world.json",
  surface: new MeshNormalMaterial(),
  follow: player,
  ring: 1,
  budgets: { residentCells: 25, instances: 20_000, bytes: 8_000_000 },
});
scene.add(world);
```

- `url` is a **logical** path: the package's own `world.json`, every other file it names, and every
  model GLB resolve through `IAssetLoader`, so a package under `assets/world/` served as
  content-addressed output with an `assets.manifest.json` loads like a raw one. A leading `/` is
  accepted and stripped, so an uncompiled `public/world` still works.
- `assets` is the loader those paths resolve through. Pass `ctx.assets` inside a game — it is the
  one built with the renderer, so a KTX2 texture decodes; the default is a fresh
  `createAssetLoader()` per load, which reads a manifest and falls back to the authored name and
  the project's `assets/` sources, but cannot transcode.
- `surface` is the game's terrain material, handed straight to the composed `TerrainTiles`. The
  class creates no material, colour or geometry of its own.
- `follow` is read once per update; any object with a `position` (`x`, `z`) works, including the
  camera.
- `ring` is the Chebyshev radius in cells kept resident. A cell is only evicted beyond `ring + 1`, so
  residency has hysteresis and does not thrash on a cell boundary.
- `budgets` are hard caps. A cap that is reached increments `stats().pressure` and skips the
  farthest cell; it never throws mid-frame.
- `rebuildsPerUpdate` caps how many cell-asset batches one `update` refilters, nearest cell first;
  it defaults to 16. A cell that did not get its turn keeps drawing what it has.
- `terrain` carries the composed `TerrainTiles` options: tile size, resolution, LOD factors and
  distances, skirt depth, plus the two radii below.
- `transparentScatter` is how a scattered part whose own material is `transparent` is drawn —
  `"cutout"` (default) or `"blend"`.
- `createCollider` and `loadModel` are optional overrides.

### Terrain reaches further than the props

`terrain.streamRadius` is the terrain residency radius in tiles, and it defaults to `ring`, so a
world streams ground and props over the same square. Raise it alone to put the ground out to the
horizon while the props stay near: the default `lodDistances` are `tileSize` multiples, so the far
tiles of the wider ring can take coarser levels. Each distance is the nearest allowed switch;
screen error can hold a finer level farther out. With a render camera and renderer, terrain shares
props’ resolved `autoLod.maxPixelError` budget and `lodHysteresis`, using the current drawing-buffer
height and camera projection. Resizing or moving the camera refreshes settled terrain without
resampling heights. Without a render view, existing distance-only selection is preserved.

`terrain.colliderRadius` is the separate Chebyshev radius that gets a `createCollider` body, and it also defaults to `ring`; a tile
crossing it has its body created or disposed as it goes, so a wide render ring does not cost a
physics body for every tile in it.

```ts
const world = await WorldCells.load({
  assets: ctx.assets,
  url: "world/world.json",
  surface: new MeshNormalMaterial(),
  follow: player,
  ring: 2,
  budgets: { residentCells: 49, instances: 200_000, bytes: 8_000_000 },
  // Ground out to 81 tiles, colliders only on the 25 nearest, props over the ring's 25 cells.
  terrain: { streamRadius: 4, colliderRadius: 2 },
});
```

### A view-distance recipe, and fog that hides the stream edge

Fog is a look, so the engine ships no fog and no view-distance constant. The recipe below is
arithmetic over the cell size `c`, for terrain tiles of the default size (`tileSize` = `c`). Change
`c` and every number follows. `pnpm exec vitest run packages/core/__tests__/world-streaming-recipe.spec.ts`
reads the right-hand column of this table and fails when the ordering below breaks.

| Setting | For cell size `c` | At `c` = 128 m (a 2 km map, 256 cells) |
| --- | --- | --- |
| `ring` | 2 | 2 |
| `terrain.streamRadius` | `ring + 1` | 3 |
| `terrain.colliderRadius` | 1 | 1 |
| `terrain.lodDistances` | `2c, 4c` (the defaults) | 256, 512 |
| fog `near` | `c` | 128 |
| fog `far` | `ring · c` | 256 |
| `budgets.residentCells` | `(2 · ring + 1)²` | 25 |

The numbers come from where each edge can be, measured from the follow point:

- **New props appear at `ring · c`.** A cell loads when the follow point crosses into the cell next
  to it, so the near side of a newly loaded cell can be only `ring` cells away: 256 m, not the 452 m
  corner of the resident square. Fog `far` must be at most `ring · c`, so a cell is fully fogged
  when it arrives. A `far` set against the corner leaves the side of the ring in plain view.
- **The ground ends at `streamRadius · c`.** That must be more than fog `far`, so the terrain edge
  is always behind the fog: 384 m against 256 m. The props' edge is then the only edge.
- **Bodies reach `colliderRadius · c`.** That is at most `ring`, because physics never needs ground
  the props have not reached. 128 m is far above any fall in one frame; a fast vehicle may want 2.
- **A terrain LOD switch is at least fog `near`**, so a switch pops inside the haze. The
  distances must increase, which `TerrainTiles` checks itself. Screen-error selection may delay a
  switch beyond these floors, so higher raster resolution cannot bring it in front of the haze.
- **`budgets.residentCells` is at least `(2 · ring + 1)²`**, the wanted square. Cells kept by the
  `ring + 1` hysteresis yield to wanted cells when the budget is full.

Set the fog in the game's own render source, and give the background the fog colour so a fogged
edge matches the sky:

```ts
import { Color, Fog } from "three";

const cellSize = 128;
const ring = 2;
ctx.scene.background = new Color(0x9fb4c8);
ctx.scene.fog = new Fog(0x9fb4c8, cellSize, ring * cellSize);
```

`stats().residentTiles` and `stats().residentColliders` report the two terrain radii at runtime.

`WorldCells` implements the framework's compute-driven contract with `processCadence: "render"`, so
registering it with `ctx.add(world)` is enough: the loop calls `update(renderer)` once per rendered
frame. Prop `maxDistance` batches are refiltered only after the follow point has moved an eighth of
the cull distance, and a chunk or asset load that completes after its cell was evicted is disposed
rather than attached.

A refilter that cannot change anything is skipped, not deferred. Every placement of a cell lies
inside that cell's `cellSize` square, so the distances from where the batch was built and from where
the follow point is now bracket every distance its placements can have had; when no `lods` switch or
cull distance of the asset falls in that span, the same placements draw at the same levels, and the
batch is measured against the position it was actually built from on the next move. What is genuinely
stale is refiltered nearest cell first, `rebuildsPerUpdate` of them per frame, so a fast player
streams a few stale-but-drawn batches rather than rebuilding every resident cell in one frame.

An asset's `lods` are consumed with it: every level is loaded through the same loader, limiter and
asset pipeline as the asset's own GLB, and each placement is drawn by the level its own distance
selects — `lods[i]` beyond its `distance`, the asset's own GLB nearer than that. That is one
`InstancedBatch` per level per cell, refiltered on the same trigger as `maxDistance` (an eighth of
the nearest distance the batching can be crossed at, whichever boundary that is), so the switch is a
hard one: nothing crossfades and a placement that crosses pops. A level that will not load falls
back to the one above it and is counted like any other failed load, and a `lods` entry at or beyond
`maxDistance` is never loaded at all, because an instance that far out is culled anyway.

A GLB is drawn per part, not per model. Several primitives in one GLB — a tree's bark `OPAQUE` and
needles `BLEND` — load as a `Group` of one child `Mesh` each, and each of them gets its own
`InstancedBatch` with its own geometry and material, named `cell:asset:level:part`. The placement's
instance matrix is the placement composed with the part's own transform inside the model, so a part
that sits above the model origin draws above the placement. `SkinnedMesh` parts are skipped: an
instanced copy would draw one rest pose.

A part whose own material is `transparent` draws as an alpha cutout by default, because an
`InstancedMesh` cannot sort its instances: a blended material would draw in submission order and pay
overdraw. The part gets one clone of its material per asset — never per cell, and never by mutating
the GLB's own — with `transparent: false`, `depthWrite: true` and an `alphaTest` of the material's
own cutout point, or `0.5` when it names none. The clone is released with the rest of the asset.
`transparentScatter: "blend"` draws the material as authored instead.

Read back what is happening with `stats()`:

| Field | Meaning |
| --- | --- |
| `residentCells` / `residentKeys` | Cells resident right now. |
| `residentTiles` | Terrain tiles drawn, out to `terrain.streamRadius`. |
| `residentColliders` | Tiles holding a `createCollider` body, inside `terrain.colliderRadius`; 0 with no factory. |
| `instances` | Placement instances the resident cells hold, before the `maxDistance` filter. |
| `loadsInFlight` | Asset and chunk loads that have not settled. |
| `evictions` | Cells released so far. |
| `rebuilds` | Cell-asset batches refiltered so far, across every update. |
| `failures` | Asset or chunk loads that rejected. |
| `pressure` | Requests rejected by a budget: `cells`, `instances`, `bytes`. |

Call `dispose()` to release every cell, batch, chunk model and the terrain.

### Virtualized geometry, and what is not culled yet

Clustered geometry ships: `ClusteredMesh` (a `Mesh` that culls and LOD-selects clusters on the GPU
and draws them through an indirect record) and `ClusteredBatch` are exported from `@threenative/core`,
and a `WorldCells` package gets the same treatment through `gpuScene`, which is **on by default**
wherever the backend can run it. Nothing here needs to be enabled to get it, and a backend without
compute or `drawIndexedIndirect` falls back to the CPU path and says so in `stats().gpuScene`.

What does not ship is occlusion culling. Nothing in `packages/core/src` reads a previous frame's
depth to skip geometry — no depth pyramid, no HZB — so a cell behind a hill is submitted and culled
by frustum only. It was declined twice on measured headroom and is now a single go/no-go:

[PRD-489](../PRDs/done/PRD-489-gpu-scene-occlusion-culling.md) — occlusion culling re-tested
on the GPU scene. Read it before assuming a cell is free to stream wide; the answer today is that it
is not.

### Terrain layers that blend by their own height

`loadTerrainSplat` mixes each table layer over the ones below it by that layer's mask weight, so a
mask edge is only as detailed as the mask. A layer whose table row says `"height": true` also loads
`<id>_h.jpg` as linear data, stacked into one more array texture (the marker then reports
`samplers=5` for a sixteen-layer package). The package owns no curve. It hands each layer's
weight and height sample to a function you pass as `layerWeight`:

```ts
import { loadTerrainSplat } from "@threenative/core/world";
import { heightBlend } from "./render/heightBlend.js";

const surface = await loadTerrainSplat({ assets, layerWeight: heightBlend, renderer, url });
```

`layerWeight(weight, { height, index, layer })` returns the weight the mix chain uses, and `height`
is `undefined` for a layer with no height set. Leave it out and the weight is the mask, unchanged.
[`heightBlend.ts`](../../examples/prd493-terrain-splat/src/render/heightBlend.ts) is the reference
curve: a half-painted layer holds the crests of its relief first, a fully painted layer covers, and
an unpainted one stays hidden. Edit or replace it to change the look. The package does not decide it.

## 4. Keep the bytes on disk

On the web, the asset loader stores every compiled file it downloads in the Cache API and reads it
back on the next visit, so a returning player downloads no compiled asset again. Files a game
authors straight into `public/` outside the asset pipeline (for example its own audio) are not in
the manifest and are not covered. Entries are content-addressed, so
they never go stale. Each game (page, base path and manifest) keeps one cache across releases:
startup deletes only the files the new manifest no longer lists, so a one-file patch downloads one
file. When the browser refuses a write for quota, the loader evicts the least recently accessed
entries the current session has not touched, one at a time, and retries after each. Only a complete body reaches disk: a
short or failed download retries after 0.5 s, 1 s and 2 s, then rejects naming the url and the last
status. A 404 or 403 is not retried, so the next candidate url starts at once.

Call `prefetch` before a scene change. It downloads the next scene's files at `soon` priority and
returns how many bytes it served (`requested`, `settled`, `requestedBytes`, `settledBytes`),
with no decode and no GPU memory:

```ts
await ctx.assets.prefetch(["world/assets/castle.glb", "ui/level-two.png"]);
await ctx.goto("level-two");
```

After the reveal, the loader fills the rest of the manifest at idle priority, in manifest order. A
`WorldCells` cell load is `soon`, so the ring's nearest files start before the fill; a `now`
request from the running scene starts first and pauses new idle starts until it settles. The fill
stops at the next file chunk when the browser reports `navigator.connection.saveData`. Read the result from
`ctx.assets.cache`: `{ enabled, persisted, hits, misses, bytesOnDisk, bytesTotal, filling,
backgroundFill }`, so a settings screen can show "1.2 of 2.0 GB on disk" and call
`await ctx.assets.cache.clear()`.

Two named overrides, both on `defineGame`'s `assets`: `cache: false` turns the disk cache off and
`backgroundFill: false` turns the fill off. Both are reported (`cache.enabled`,
`cache.backgroundFill`). A native host has no Cache API: the
cache reports `enabled: false` with the reason "native host reads installed files", `prefetch`
resolves at once, and the load path is unchanged.

## 5. Prove it

The in-repo fixture
[`world-flythrough.playtest.json`](../../examples/abyss-framework/playtests/world-flythrough.playtest.json)
flies the camera across the `world-v1` package committed as the example's own
[`assets/world/`](../../examples/abyss-framework/assets/world) source and asserts residency rises,
cells are evicted, loads settle and no load fails, with a measured p95 frame budget. Under
`?world&viewDistance` it runs the view-distance recipe above and also asserts 49 terrain tiles, 9
collider bodies, and no body farther than 1.5 tiles from the camera. The scene
behind it is
[`WorldProbe.ts`](../../examples/abyss-framework/src/scenes/WorldProbe.ts), which uses only the
public exports. Build first: the scenario runs against compiled, content-addressed output, not
against a dev server.

```sh
pnpm --filter abyss-framework build
CI=true node packages/playtest/dist/runner/cli.js \
  examples/abyss-framework/playtests/world-flythrough.playtest.json \
  --url 'http://127.0.0.1:5181/?world&viewDistance' \
  --server-command 'pnpm --filter abyss-framework preview --host 127.0.0.1 --port 5181 --strictPort' \
  --browser-recipe webgpu --headed
```

`--headed` matters: headless Chromium cannot capture WebGPU here and silently serves it from a CPU
rasteriser. A run that does not report a real `adapter.info` is not evidence — check
`artifacts/playtest/capture.json`.
