# Forest starter kit

A 512 m forest on real elevations (USGS 3DEP), with hydraulic and thermal erosion, clustered fir
stands, young firs and boulder fields. It is game source: once copied, every file is yours to edit.

| File | What it decides |
| --- | --- |
| `recipe.json` | The terrain and the scatter: seed, size, erosion, `count`, `minDistance`, slope limits, `scale`, masks. |
| `assets.json` | Each prop's models, LOD distance, draw distance and bounds. |
| `surface.json` | The ground: texture layers, tiles, tints, far tiles and blend thresholds. |
| `bake.mjs` | Writes the world package and `world/water.json` (the lake and river) from the three files above. |
| `world.ts` | `addForest(ctx, follow)`: terrain, props, shadows, collision; `COLLIDERS` per prop. |
| `water.ts` | `addForestWater(ctx, water, field)`: the lake's surface (`WaterSurface3D`) and the river's ribbon, from `water.json`. |
| `sky.ts` | `forestDaylight(follow)`: sun, sky, fill, haze, exposure and tone curve. |

Art is CC0 (Poly Haven); provenance is in `@threenative/terrain/starter-assets/credits.json`.

## Three steps

1. Copy `node_modules/@threenative/terrain/starter/forest` to `src/terrain/forest`.
2. Run `node src/terrain/forest/bake.mjs --out assets/terrain/forest`. The bake imports both
   `@threenative/terrain` and `@threenative/assets`, so install them as devDependencies
   (`npm install --save-dev @threenative/terrain @threenative/assets`); `three` must be installed
   too, because `@threenative/terrain` declares it as a peer dependency. The same recipe always
   writes the same bytes.
3. Add it to a scene:

```ts
import { forestDaylight } from "../terrain/forest/sky.js";
import { addForest } from "../terrain/forest/world.js";

// In Scene.load (it awaits the package) — `player` is what the world streams around.
const forest = await addForest(ctx, player);
// In Scene.enter.
ctx.add(forestDaylight(ctx.camera));
```

`addForest` resolves once the ground can be stood on: one heightfield collider covers the whole
world before it returns. Set the camera's `far` to at least the sky size in `sky.ts` (5000 m).

## Changing it

- **A prop's collider:** edit its row in `COLLIDERS` in `world.ts` (`capsule`, `sphere` or `null`).
- **A prop's model:** point `assets.json` at another glTF with its bounds, then re-bake.
- **The layout:** edit `recipe.json` (or open it in the terrain editor), then re-bake.
- **The water:** the recipe's `lake-bed`, `river` and `lake` layers set where it lies and how deep;
  `water.ts` sets how it looks.
- **The look:** `surface.json` for the ground, `sky.ts` for the light, `PROP_SKY_LIGHT` in
  `world.ts` for how strongly the sky lights the props and `GROUND_SPECULAR` for the sheen on the
  ground (0 is matte; three's default is 1).

## Edit at startup, without rebaking

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
  clear: [{ center: [40, 18], radius: 6 }], // Optional assets: ["fir"] filter.
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

const loaded = await addForest(ctx, player);
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
