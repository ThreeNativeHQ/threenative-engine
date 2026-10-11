# Optional terrain authoring

For authored terrain, install `@threenative/terrain` as a development dependency:

```sh
npm install --save-dev @threenative/terrain
```

Search `engine_search_capabilities` for terrain authoring and inspect the returned
`engine_capability_detail` before creating a terrain generator. Use the installed
terrain operations rather than writing noise, erosion, masks, roads or rivers again.

## Asked for a ready world? Start from a starter kit

A kit is a whole playable world as game source: recipe, bake script, CC0 art, terrain surface,
sky, props and colliders. `@threenative/terrain` ships them under `starter/<world>/` (today:
`forest`). Copy one into the game, bake, add it to a scene:

```sh
cp -r node_modules/@threenative/terrain/starter/forest src/terrain/forest
node src/terrain/forest/bake.mjs --out assets/terrain/forest
```

Then `await addForest(ctx, player)` in `Scene.load` and `ctx.add(forestDaylight(ctx.camera))` in
`Scene.enter`; the kit's `README.md` says what each file decides. Edit `recipe.json` for layout,
`COLLIDERS` in `world.ts` for what stops the player, `surface.json` and `sky.ts` for the look, and
re-run the bake. The bake writes the engine's `WorldCells` package (`bakeWorldPackage`).

## Generate once, play the bake

Run this in an authoring/build script, outside the game loop:

```js
import { Terrain, Mask, bakeMesh, bakeTerrain } from "@threenative/terrain";

const terrain = new Terrain({ size: 512, resolution: 257, seed: 42 })
  .noise({ id: "hills", amplitude: 30, scale: 180 })
  .flatten({ id: "spawn", height: 8, mask: Mask.circle([0, 0], 12) });
const state = terrain.evaluate();
const mesh = bakeMesh(state);
const collision = bakeTerrain(state).collision;
```

Persist the recipe with `terrain.toJSON()` for later editing, and save the baked
arrays for the game. Stable layer IDs let an agent replace an operation instead of
appending duplicate layers. `Terrain.fromJSON(recipe)` restores the authored stack;
`terrain.applyPatch(commands)` applies a validated edit atomically.

## Keep the game's appearance editable

`toGeometry(mesh)` from `@threenative/terrain/three` creates an ordinary caller-owned
Three.js `BufferGeometry`. Choose its material, lighting, water and vegetation in
this game's `src/render/`. Colours are only baked when you provide an explicit
palette; the package does not choose a material or a renderer. Dispose the geometry
and material when the scene releases them.

For collision, reuse `Heightfield` from `@threenative/core/world` and
`CollisionShape3D.heightfield` from `@threenative/physics`. Supply the same baked
height samples and extent to rendering and collision. Heightfield dimensions count
vertices; `toColliderHeights()` converts the canonical row-major samples once for
Rapier. One unit is one metre. Bilinear `heightAt()` is an interpolation aid; compare
actual triangles and physics contacts when verifying ground alignment.

Keep terrain evaluation, erosion and editor tooling out of the shipped game graph.
The runtime consumes baked arrays and assets. The legacy `encodeGLB`/`makeExport`
terrain export contains the terrain mesh only; it is not a full-world export of
vegetation, rocks, water and imported assets.

## Optional live terrain editor

Install the authoring dependency above; Vite remains the project's development
server. Save `terrain/world.json` as `{ "version": 1, "recipe": terrain.toJSON() }`.
Add the optional plugin to this project's Vite configuration:

```ts
import { resolve } from "node:path";
import { terrainEditor } from "@threenative/terrain/editor/server";

const editor = terrainEditor({ documentPath: resolve("terrain/world.json") });
// Add editor to the existing Vite plugins. Bind the server to 127.0.0.1/localhost.
// Add "@threenative/terrain/editor" to optimizeDeps.exclude so its adjacent
// evaluator worker remains a separate module.
```

The project supplies `/terrain-editor/index.html`. Its browser entry calls
`mountTerrainEditor` from `@threenative/terrain/editor` with `createView(host, controller)` and
an explicit eight-channel material colour palette. Implement the exported
`IEditorView` around this game's ThreeNative scene and `src/render/` helpers; keep
that authoring entry separate from `src/game.ts`. The addon reuses the recovered
brush, layer, recipe, cancellation and data-export controls around that view.
It does not create a second renderer or silently choose the game's appearance.
The view's `setDocument(document, revision)` applies metadata changes separately
from its terrain `update(state)` path. Keep camera and placement edits out of the
evaluator worker.
Track the accepted document and the successfully rendered recipe separately. While
a rebuild is pending or has failed, metadata must retain the last valid scene and
rendered revision; apply deferred transforms when that recipe renders successfully.

After the server listens and the route is ready, `await editor.activate()` returns
`editorUrl`, `projectId`, `sessionId` and the current content-hashed `revision`.
The development server also prints the bound editor URL. Present that returned
link; do not invent a port or give a user `0.0.0.0`. On a remote machine, configure
`viewerUrl` with the existing port-forwarded editor URL; without forwarding the
loopback link is local to that machine. Activation probes the advertised route;
an unreachable or failed private forward returns an error. Only the explicitly
configured viewer host/origin is additionally trusted; the server still binds to
loopback.

An agent can edit the same document without clicking the GUI:

```ts
import { TerrainEditorController } from "@threenative/terrain/editor";

const controller = new TerrainEditorController(activation.editorUrl);
const current = await controller.snapshot();
await controller.commit({
  baseRevision: current.revision,
  commands: [{ op: "update", id: "hills", patch: { params: { amplitude: 35 } } }],
});
```

Stale bases conflict. Read the latest snapshot and merge the intended semantic
edit; do not overwrite another agent/human's work with an old document. Complete
atomic JSON saves also update the shared view. Invalid disk saves retain the last
valid preview and show a diagnostic; restore a valid save before submitting more
patches. Editor imports, workers, watchers and the document stay out of the game
runtime. Bake committed data before handing it to the game. The editor's GLB action and
`exportWorldGLB` from `@threenative/terrain/export` write the whole resolved world (terrain,
props, final transforms, embedded PBR maps); the root `encodeGLB` stays terrain-only. The full
operation list, units and patch rules ship in `node_modules/@threenative/terrain/AGENT_GUIDE.md`.

For individual props, save `placementOverrides` in the authoring document, keyed
by evaluated placement `id`. Each entry contains `position: [x,y,z]`, a unit
`quaternion: [x,y,z,w]`, positive `scale: [sx,sy,sz]` and `grounding: true|false`.
Use `validatePlacementOverrides` and `applyPlacementOverrides` from the headless
addon. Grounding defaults on; the game uses its actual model bounds and terrain
triangles. A free Y lift records `grounding: false` and still measures clearance.
The resolved state and `bakeTerrain` retain transforms; the game must consume
them. Never use an instance-buffer index as a saved key. Keep unmatched overrides
visible until the author explicitly removes or reassigns them.
