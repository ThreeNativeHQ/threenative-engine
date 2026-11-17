# Tundra starter kit

A 512 m alpine tundra on Trail Ridge, Rocky Mountain National Park, 3430-3480 m (USGS 1 m DEM),
above the tree line: short sedge and grass turf, fellfield gravel and grey lichen, late snow patches,
two meltwater streams and two kettle ponds, krummholz at the low edge, dwarf willow in the swales and
lichen-crusted erratics. The far ring is the same survey out to 5 km on the square's own datum: Trail
Ridge's 3.7-3.8 km peaks and the forested valleys under them. It is game source: once copied, every
file is yours to edit.

| File | What it decides |
| --- | --- |
| `recipe.json` | The terrain: the survey heightmap, erosion, the kettle beds, the two streams, the two ponds, the surfaces and the erratics; its `world` row names the ground layers, the art and the far ring. |
| `heightmap.r16` | The real elevations the recipe's heightmap layer reads: 16-bit samples, decoded at the bake to 0.1 m steps. `scripts/cook-kit-survey.ts` in `@threenative/terrain` cuts it and the far ring from any lat/lon. |
| `biome.data.json` | The biome record: the krummholz, the turf, the cushion plants, the willow, the stones and their bands. The streamed bake places from it. |
| `assets.json` | The legacy cell package's boulder model, LOD distance, draw distance and bounds. |
| `surface.json` | The legacy cell package's ground table: moss base, snow and rock layers, tiles, tints and thresholds. |
| `bake.mjs` | Runs `bakeKit` with this kit's look and writes the streamed world: the baked grid, its splat, the canopy and sky bytes, `horizon.json`, the prop package and the art. |
| `scene.ts` | The scene, `TundraScene`, and `TUNDRA_GAME`: the streamed ground, the far ring, the props, the sky, the ponds and streams, and the player rig. |
| `render/` | The look: the biome row (`render/biomes.ts`), the ground material, the palette, the species pack (`render/props/pack.ts`), the sky and the water. |
| `world.ts`, `sky.ts`, `water.ts` | The legacy cell-package loader, its daylight and its water, kept until the streamed bake retires them here. |

Art is CC0 (Poly Haven); provenance is in `@threenative/terrain/starter-credits.json`.

## What draws each species

The bake's ordered tundra stream places six kinds; `render/props/pack.ts` decides the art for each:

| Placed kind | Drawn as |
| --- | --- |
| `sapling` | Krummholz spruce and fir: the fir scan, squashed to a wind-pruned mat |
| `bush` | Dwarf willow and blueberry shrubs |
| `grass` | Short alpine sedge and grass tufts |
| `scrub` | Cushion plants and moss mats |
| `boulder`, `riverrock` | Lichen-crusted erratics and stream stones |

## Status

The kit is a source kit on the forest's stack: `scene.ts` streams the baked world, its far ring and
its props, and composes the player rig and diagnostics from `@threenative/terrain/starter`.

## Steps

1. Copy `node_modules/@threenative/terrain/starter/tundra` to `src/terrain/tundra`.
2. Run `node src/terrain/tundra/bake.mjs --out assets/terrain/tundra` (needs `@threenative/terrain`
   and `tsx` as devDependencies, because the bake reads this kit's TypeScript look). The same recipe
   always writes the same bytes.
3. Spread `TUNDRA_GAME` into `defineGame` and register `TundraScene`, as the forest kit's README shows.

## Edit at startup, without rebaking

> The streamed bake retires this path for the tundra kit: the ground table and the props now come
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

const loaded = await addTundra(ctx, player);
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
