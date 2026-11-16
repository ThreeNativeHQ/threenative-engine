# Alpine starter kit

A 512 m alpine headwall on a real survey (USGS 1 m DEM, Longs Peak, Colorado), with hydraulic and
thermal erosion, rock base, dirt on slopes, snow on the high steep ground and boulder scree. It is
game source: once copied, every file is yours to edit.

| File | What it decides |
| --- | --- |
| `recipe.json` | The terrain: the survey heightmap, erosion, the rock, dirt and snow surfaces, and the scree. |
| `heightmap.r16` | The real elevations the recipe's heightmap layer reads: 16-bit samples, decoded at the bake to 0.1 m steps. |
| `biome.data.json` | The biome record: tree stands, understorey, ground cover and their bands. The streamed bake places from it. |
| `assets.json` | The legacy cell package's boulder model, LOD distance, draw distance and bounds. |
| `surface.json` | The legacy cell package's ground table: rock base, dirt and snow layers, tiles, tints and thresholds. |
| `bake.mjs` | Runs `bakeKit` with this kit's look and writes the streamed world: the baked grid, its splat, the canopy and sky bytes, `horizon.json`, the prop package and the art. |
| `scene.ts` | The scene, `AlpineScene`, and `ALPINE_GAME`: the streamed ground, the far ring, the props, the sky, the water and the player rig. |
| `render/` | The look: the biome row, the ground material, the palette, the species pack, the sky and the water. |
| `world.ts`, `sky.ts` | The legacy cell-package loader and its daylight, kept until the streamed bake retires them here. |

Art is CC0 (Poly Haven); provenance is in `@threenative/terrain/starter-credits.json`.

## Status

The kit is a source kit on the forest's stack: `scene.ts` streams the baked world, its far ring and
its props, and composes the player rig and diagnostics from `@threenative/terrain/starter`. The
terrain is too steep to stand on near its centre, so the scene picks its spawn from the loaded
heightfield.

## Steps

1. Copy `node_modules/@threenative/terrain/starter/alpine` to `src/terrain/alpine`.
2. Run `node src/terrain/alpine/bake.mjs --out assets/terrain/alpine` (needs `@threenative/terrain`
   and `tsx` as devDependencies, because the bake reads this kit's TypeScript look). The same recipe
   always writes the same bytes.
3. Spread `ALPINE_GAME` into `defineGame` and register `AlpineScene`, as the forest kit's README shows.

## Edit at startup, without rebaking

> The streamed bake retires this path for the alpine kit: the ground table and the props now come
> from `render/`, and the section below still describes the legacy cell package.

The copied `world.ts` loads its own `surface.json` as the ground table on every startup.
Edit tints, tiling and blend thresholds there, or the material graph and prop dressing in
`world.ts`, then reload. The package's `terrain-table.json` remains the baked default for
package-only consumers; its splat masks and texture descriptors still supply the ground data.
A source table cannot name a mask that the bake did not produce.

Add `edits` to the existing `spec` in your copied `world.ts`. Read real stable IDs from the
package's `placement-ids.json` (named by `world.json.placementIds`); these example IDs are placeholders:

```ts
edits: {
  assets: {
    accent: { glb: "props/accent.glb", bounds: { min: [-1, -1, -1], max: [1, 1, 1] } },
  },
  remove: ["promote-id"],
  clear: [{ center: [40, 18], radius: 6 }], // Optional assets: ["boulder"] filter.
  overrides: {
    "move-id": { position: [12, 0, -30], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  },
  add: [{ id: "camp-accent", asset: "accent", position: [44, 0, 20],
    quaternion: [0, 0, 0, 1], scale: [1, 1, 1], grounding: true }],
},
```

`assets` replaces or adds a kind; copy the GLB into the served package directory first.
GLB and LOD paths are package-relative, with no URL scheme, leading slash or `..` segment;
provide accurate model-local `bounds`. The existing `COLLIDERS` table and dress function still
choose each kind's collision and appearance. Positions must lie inside the world's extent,
quaternions must be nonzero, values finite and scale uniform. Grounding defaults on and sets
the origin Y to `field.heightAt(x, z)`; `grounding: false` preserves the authored Y.

Edits run in the order shown: assets, remove, clear, overrides, add. A clear skips IDs named
by overrides. Removing and overriding the same ID throws; additions need new IDs. Unmatched
removal/override IDs warn and appear in `editReport.unmatched`. Old packages work without a
sidecar for assets, clear and add; ID edits need one re-bake to write the sidecar. Without
`edits`, the decoded manifest and placement bytes pass through unchanged.

Promote only a few props to ordinary Three objects: remove their IDs from the instances,
then use the returned `editReport.removed` in the scene. This example replaces each with a
game-owned glowing box; use your own geometry, material, light and collision shape:

```ts
import { CollisionShape3D, RigidBody3D } from "@threenative/physics";
import { BoxGeometry, Mesh, MeshStandardMaterial, PointLight } from "three";

const loaded = await addAlpine(ctx, player);
for (const p of loaded.editReport.removed) {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0xffbb66 }));
  mesh.position.set(p.position[0], loaded.field.heightAt(p.position[0], p.position[2]), p.position[2]);
  mesh.quaternion.fromArray(p.quaternion);
  mesh.scale.setScalar(p.scale);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.add(new PointLight(0xffaa55, 12, 6));
  ctx.add(mesh);
  const body = new RigidBody3D({ object: mesh, physics: ctx.physics, type: "fixed",
    shape: CollisionShape3D.box(p.scale, p.scale, p.scale) });
  ctx.entities.add(`promoted.${p.id}`, { dispose() {
    body.dispose(); mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose();
  } });
}
```

Rendering, nearby prop collision, dressing and returned `manifest`, `placements` and
`placementIds` all use the edited records. `clear` removals are not in the promotion report.
The separate `editWorldPlacements` helper and its types are exported from
`@threenative/terrain/starter` for callers that already own decoded package data.

Shape, topology, erosion, mask painting, distribution rules and water still require regeneration.
Changing cooked ground images requires the bake/cook texture normalization step; editing the
game table cannot replace baked texture descriptors or introduce new channels. To replace the
props' environment image at runtime, copy an HDR into the served package, change
`spec.lighting.sky` in `world.ts` to its package-relative path, then reload. The daylight and
background remain game choices in `sky.ts`. Package-only exports do not run these source edits.
