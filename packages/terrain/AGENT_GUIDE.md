# Strata: instructions for a coding agent

## Read this first

Use the typed public `@threenative/terrain` imports to author terrain. The headless implementation is recovered from the owner-supplied Strata source. An operation records intent; `evaluate()` produces disposable data. Never modify an evaluated height array expecting to edit the recipe.

World units are metres. Y is up. X and Z range from `-size/2` to `+size/2`. Brush centres and masks use `[x,z]`; spline points use `[x,y,z]`. Rotation and slope thresholds use degrees. **Placement output yaw uses radians.** Heights are absolute world elevations, not normalized texture values.

Prefer stable semantic IDs: `base`, `north-peak`, `camp-pad`, `access-road`, `river-main`, `forest`. Repeating an operation with an existing ID replaces it **in place**. It does not append another layer. Use `label` for a human-readable name in fluent calls; the saved layer uses `name`. In `biome()` the `name` parameter is the biome key, not the display name.

## Workflow

1. Establish world size, seed, and a low preview resolution. Add base noise and large landforms.
2. Add erosion before fine roads/building pads. Roads and pads take their elevation from the ground they cross unless you pin one.
3. Add surface/biome rules and population. Put rules after the geometry changes whose slopes they should see. Road painting can override earlier surface rules; a later reset-material pass can also erase a road's paint.
4. Inspect the result and diagnostics. Modify known IDs, keeping the source stack small.
5. Export the recipe and derived runtime data at an explicit resolution. Verify the high-resolution result; resolution-dependent simulation is not guaranteed to match the preview exactly.

Use `transaction()` for a synchronous semantic edit that should undo as a unit. Validation failure rolls back the entire batch. `applyPatch()` accepts JSON-only atomic commands, useful for a tool-calling agent:

```js
terrain.applyPatch([
  { op: 'update', id: 'north-peak', patch: { params: { amplitude: 120 } } },
  { op: 'update', id: 'river-main', patch: { params: { width: 22 } } },
  { op: 'toggle', id: 'erosion', enabled: true },
]);
```

Allowed patch commands: `upsert` with `layer`, `update` with `id` and `patch`, `remove` with `id`, `move` with `id` and zero-based `index`, `toggle` with `id` and optional `enabled`. Do not invent methods such as `terrain.generate()`, `terrain.bake()` or `terrain.saveGLB()`. Use `evaluate()`, `bakeTerrain()` and `makeExport()`.

## API patterns

```js
import { Terrain, Mask, bakeMesh, bakeTerrain, makeExport } from '@threenative/terrain';
const t = new Terrain({ size: 512, resolution: 129, seed: 73 });

t.noise({ id: 'base', base: 15, amplitude: 20, scale: 140, octaves: 5, warp: 30 });
t.sculpt({ id: 'hill', at: [0,0], radius: 45, strength: 12, falloff: .7 });
t.sculpt({ id: 'ditch', points: [[-40,10],[0,30],[40,35]], radius: 10, strength: -5 });
t.smooth({ id: 'soften', at: [0,0], radius: 65, strength: .6, iterations: 4 });
t.flatten({ id: 'pad', at: [-70,50], radius: 28, height: 22, strength: 1 });
t.ramp({ id: 'ramp', from: [-70,22,50], to: [-20,38,50], width: 15, shoulder: 10 });
t.stamp({ id: 'cliff-mass', shape: 'mesa', at: [90,-70], radius: [70,40], amplitude: 50, rotation: 30 });
t.erode({ id: 'thermal', method: 'thermal', iterations: 15, talus: 32, rate: .22 });
t.erode({ id: 'hydraulic', method: 'hydraulic', droplets: 5000, maxSteps: 40 });
t.terrace({ id: 'strata', step: 8, softness: .22, strength: .7 });
```

A `flatten` with no `height` levels the pad to the ground already under it and lets the blend reach as far as its deepest cut or fill, so it is a bench rather than a mesa.

Stroke tools accept `at` or a polyline `points`. Brush radius is a **radius**, not diameter. Strength is signed metres for sculpt; `0..1` for smoothing, flattening and paint. Stroke coverage uses maximum falloff coverage, not repeated accumulation at every mouse event. Holding a brush stationary does not keep adding height. Points are interpolated at `2 * radius * spacing`; jitter is seeded. Procedural stamps use `amplitude` in metres. `opacity` is available on every layer.

Masks are serializable expressions, never callbacks:

```js
const forest = Mask.and(
  Mask.height(8, 85, 10),       // altitude band, feathered boundaries
  Mask.slope(0, 34, 6),        // slope degrees
  Mask.not(Mask.material('road')),
  Mask.not(Mask.circle([-70, 50], 38, .3)),
);

t.biome({ id: 'forest-zone', label: 'Conifer biome', name: 'forest', mask: forest });
t.scatter({ id: 'trees', asset: 'pine', count: 900, minDistance: 5,
  scale: [.75,1.25], maxSlope: 35, mask: Mask.biome('forest') });
t.clear({ id: 'clear-camp', target: 'scatter', mask: Mask.circle([-70,50],35) });
```

Additional masks: `Mask.rectangle(at, size, rotation, falloff)`, `Mask.noise(scale, threshold, seed, fade)`, `Mask.or(...)`, `Mask.all()`, `Mask.none()`. Slope/height masks are evaluated against the terrain at that operation's stage. Population is deferred: scatter rules sample the **final** heights/materials/biomes and re-evaluate their mask there, so later height edits do not leave trees floating. Clear-scatter masks affect preceding rules only. Minimum distance is guaranteed **within each rule**, not across different scatter rules. The bounded rejection sampler may place fewer than requested; inspect diagnostics rather than assuming an exact count.

Materials are exactly `grass`, `dirt`, `rock`, `snow`, `sand`, `mud`, `road`, `moss`. Splat arrays are sample-major: `splat[sampleIndex * 8 + channel]`. Weights sum to one. `paint()` blends and renormalizes; `materials()` applies ordered rules. A later rule can override an earlier one.

```js
t.materials({ id: 'surfaces', base: 'grass', rules: [
  { material: 'sand', mask: Mask.height(-100, 5, 3) },
  { material: 'rock', mask: Mask.slope(42, 90, 8) },
  { material: 'snow', mask: Mask.height(95, 1000, 15) },
] });
t.paint({ id: 'camp-dirt', at: [-70,50], radius: 27, material: 'dirt', strength: .9 });
```

## Roads, rivers and water

A road, river or ramp **grades itself to the ground it crosses** when a control point leaves its elevation out (`null`, or `NaN` in code) or when it sets `followTerrain: true`. The elevation is sampled along the centreline, low-passed along arc length, then held inside `maxGrade` (default 0.12) and `maxCut`/`maxFill` (default 2.5 m / 1.5 m); the shoulder widens into a batter with the cut or fill, so a corridor never stands on a retaining step. Leaving the ground is the hard limit: where the ground itself is steeper than `maxGrade`, the road is steep too. Absolute elevations are still honoured exactly, so existing documents keep their meaning. Horizontal spline interpolation is Catmull–Rom; vertical interpolation is linear between controls to avoid vertical overshoot. Use `smooth:false` for a polyline.

```js
t.road({ id: 'access-road', points: [[-220,null,100],[-150,null,70],[-70,null,50]], width: 12, shoulder: 8 });
t.river({ id: 'river-main', points: [[20,14,-240],[35,8,0],[80,3,240]], width: 18, depth: 4, enforceDownhill: true });
t.water({ id: 'lake', kind: 'lake', at: [80,210], radius: 75, level: 4 });
```

`enforceDownhill:true` validates non-increasing Y, rather than silently changing elevations in the API. River carving only lowers terrain. The water surface is a ribbon, not a flow simulation. Keep profiles sensible and avoid self-intersecting splines.

Lake flood fill starts at the supplied location, follows connected samples below `level`, and is limited by `radius`/mask. A seed above water level produces an empty mask and a diagnostic. Oceans flood from map boundaries. Water placement does not itself excavate a basin: lower the basin first. Scatter avoids flooded lake/ocean samples and submerged river ribbons by default.

## Copy/paste and external heightfields

```js
const heights = t.copyRegion({ at: [90,-70], size: 110, resolution: 65 });
t.paste({ id: 'copied-mass', data: heights, at: [-120,-90], size: 110,
  rotation: 90, mirrorX: true, blend: 'replace', falloff: .2 });
```

The copy contains heights only. Paste/stamp data is `{width,height,values}` in world metres. Fluent `heightmap()` / `paste()` / `stamp()` normalize typed arrays to plain arrays; raw recipe JSON must already contain plain arrays. RAW files have no self-describing dimensions/range. Preserve sidecars. PNG import accepts non-interlaced grayscale 8/16-bit images only, not RGB/palette images, and reports `hasEmbeddedRange`.

Stamp and paste footprints use `at: [x,z]`, `radius: [halfWidth,halfDepth]` or
`size: [width,depth]`, and `rotation` in degrees (positive turns +X towards +Z).
Existing `radius` takes precedence over `size`. All three landform operations use
positive `scale` for vertical gain and `offset` in metres after that gain;
additive blends add both the scaled height and offset. Heightmap accepts optional
`at`, `size`, `rotation` and `falloff` to place a bounded rectangular footprint.
Without these footprint fields it retains the supplied full-world sampling.
Outside a bounded footprint, existing terrain remains unchanged. Samples must
all be finite numbers. X/Z rotations that create overhangs have no heightfield
representation. These transforms change recipe parameters, not an independent
solid hidden inside the evaluated terrain.

## Inspect and export

```js
console.log(t.inspect({ resolution: 129 }));
const recipe = t.toJSON();
const same = Terrain.fromJSON(recipe);
const result = same.evaluate({ resolution: 257 });
const runtime = bakeTerrain(result, { chunkCells: 64, lodSteps: [1,2,4], skirtDepth: 6 });
const archive = await makeExport(result, recipe, 'runtime');
// Node: await writeFile(archive.name, archive.bytes)
```

`makeExport` kinds are `project`, `png`, `raw`, `splat`, `glb`, `runtime`; all return `{name,type,bytes}`. Exporting does not mutate the authoring recipe. Collision height samples are row-major from Z=-size/2 to Z=+size/2, with X increasing along each row. Grid vertices are `(x/(N-1)-.5)*size, height[z*N+x], (z/(N-1)-.5)*size`.

Do not promise navmesh, physics registration, EXR, seamless mixed-LOD stitching, procedural caves, true water simulation, or production art from this version. GLB exports terrain only; load placement assets separately. Native-engine integration is via arrays/manifests and still needs an engine-specific adapter.

## Bounds and operational safety

Valid grid resolutions: 17, 33, 65, 129, 257, 513, 1025 **vertices per side**. Use 129 or 257 while iterating, and inspect before moving to 513/1025. Changing resolution can change erosion and population. No cross-resolution exactness guarantee exists.

Maximum recipe layers: 512; maximum requested instances per scatter rule: 20,000; hydraulic droplets: 200,000; steps per droplet: 128; thermal/smooth iterations: 200; noise octaves: 10; spline/brush input points: 8192; interpolated brush centres per stroke: 65,536. These are input safeguards, not real-time performance targets. Do not choose all maximums together.

The evaluator is synchronous. An AbortSignal is checked between operations, not inside a long erosion pass. For real cancellation of a headless job, isolate it in a Node worker/process and terminate the worker. A prefix cache stores private snapshots, up to 48 MiB of counted height/splat/biome arrays by default; JavaScript metadata and output arrays are additional memory.

Never execute untrusted JavaScript from a recipe. The editor parses data only. Surface validation errors and preserve the previous valid recipe. Save the recipe, not just the baked mesh, before destructive project housekeeping.

Splatmaps are linear data, not color images: use a non-sRGB/NoColorSpace texture setting and renormalize sampled weights in the consuming shader. Do not use an 8-bit canvas conversion to read a PNG16 heightfield; the supplied decoder preserves its 16-bit samples.

## Live editor: environment, assets and surfaces

The running editor exposes three revision-checked operations beside the document, each also behind a GUI
panel that calls the same code. A write names `baseRevision`; a stale one is a 409 and nothing changes.

- `controller.environment({ op: "get" | "patch" | "reset" }, revision)`: sun azimuth/elevation/intensity/colour,
  sky fill, sky colour or image, `exp2` haze, exposure, sea colours, and an independent `lighting` image.
  `null` returns a field to the project's own value; an unsupported fog mode is refused by name. The
  project's `src/render/` decides what each value does. Nothing here evaluates the terrain.
- `controller.asset({ op: "register" | "upload" | "adjust" | "remove" | "list" | "map" | "unmap" }, revision)`:
  `register` takes an absolute local path (an asset-MCP download result), `upload` takes base64 bytes. Files
  are stored as `<kind>/<sha12>-<id>.<ext>` so a replacement is a new URL; GLB, PNG, JPEG, WebP, HDR and EXR are
  recognised by their bytes, measured, and refused by name when damaged, over the project's limits, or when a
  GLB points outside itself. Same id with other bytes needs `replace: true`. `remove` drops the entry, never
  the file, and is refused while a surface or an environment still uses it.
- `map` binds an image to a `<surface>.<channel>` input the project exposes (`bark.albedo`, `stone.normal`);
  albedo is read as sRGB, every other channel as linear data. Placing a model is a `scatter` layer whose
  `asset` is its id; `adjust` sets the file's unit scale and pivot without editing it.

## Three.js ownership

`@threenative/terrain/three` exports `toGeometry(bakeMesh(state))`. It creates only ordinary indexed geometry using your installed Three.js. Create the mesh/material in your own `src/render/`, register collision through the existing engine API, and dispose the geometry yourself. Baked vertex colours are absent by default; pass an explicit eight-channel sRGB `palette` to `bakeMesh` or `bakeTerrain` when wanted. The addon supplies no palette or material. The legacy `makeExport(..., "glb")` contains terrain only; use the separate static-world encoder below for resolved models and baked surfaces. The default GUI full-world action, chosen-resolution material/deformation baking and five final starter exports remain pending.


## Resolved static-world GLB

Import `exportWorldGLB` from `@threenative/terrain/export` in browser authoring source. Its import is DOM-free; encoding requires FileReader and canvas. Root and `/three` remain headless. This entry uses the installed Three.js GLTFExporter rather than a terrain-specific loader format.

```ts
import { exportWorldGLB } from '@threenative/terrain/export';
const output = await exportWorldGLB({
  revision,             // accepted document's 64-character content hash
  snapshotTime,         // finite seconds, pinned across all baked deformations
  state,                // evaluated committed recipe with applied override records
  terrain,              // canonical metre-frame Mesh with UVs and prepared PBR maps
  assets,               // Map<assetId, Object3D>: actual static models
  transforms,           // Map<placementId, Matrix4>: actual final grounded root matrices
  water,                // [{ id, object, time: snapshotTime, staleFrames: 0 }]
});
// output.bytes is the self-contained world.glb; persist only after success.
```

Game source owns all geometry, materials and images. The terrain needs albedo `map`, `normalMap`, `roughnessMap` and `aoMap`; vertex colours alone are insufficient. MeshStandardMaterial metallic/roughness surfaces are supported. Colour/emissive images are sRGB, data maps are NoColorSpace. Supply decoded byte images (at most 16 megapixels); DataTexture images need complete RGBA bytes. Bake alpha into the colour image. Bake displacement, bump/light maps, node shaders, skinning/morphing and wind into the supplied static geometry/material first. Use tangent-space normal maps with equal X/Y scale magnitudes; bake object-space/anisotropic maps first. MeshPhysicalMaterial extensions are outside this bounded encoder's contract.

All final matrices use metres, Y-up, positive scale and no shear. Keys are durable placement IDs, never instance indices; unmatched matrices fail. Ordinary glTF nodes share model mesh data without requiring EXT_mesh_gpu_instancing. Source geometry, images and material values are copied before asynchronous encoding, so later source edits cannot mix the export snapshot. Input objects remain owned by the caller.

Every evaluated water body/river needs its actual baked object at exactly `snapshotTime` with `staleFrames: 0`. A low-resolution or stale ocean CPU height sample does not satisfy this contract. Missing/unbaked content rejects before producing a download; preserve the previous valid export and document. Encoding does not perform the project's material bake, chosen-resolution re-evaluation or ocean readback for you.

`output.report` records revision, resolution, time and placement/water IDs. Model cameras/lights and source userData are excluded. The receiving game supplies its own lighting, sky/environment, fog, exposure, post and live water/wind; GLB does not carry those running systems. A vanilla Three.js GLTFLoader or a normal game model loader can consume the bytes without this addon.
