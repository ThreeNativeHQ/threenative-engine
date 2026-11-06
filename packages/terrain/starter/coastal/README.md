# Coastal starter kit

A 512 m coastline on a real survey (USGS 1 m DEM, Colorado), with hydraulic and thermal erosion,
rock on the steep ground, sand on the low ground, an ocean at 1.5 m and fir stands kept out of the
water. It is game source: once copied, every file is yours to edit.

| File | What it decides |
| --- | --- |
| `recipe.json` | The terrain: the survey heightmap, erosion, the rock and sand surfaces, the ocean and the stands. |
| `assets.json` | The fir model, its LOD distance and draw distance, and its bounds. |
| `surface.json` | The ground: the sand base, the rock layer, tiles, tints and blend thresholds. |
| `bake.mjs` | Writes the world package and `world/water.json` from the three files above. |
| `world.ts` | The runtime: streams the baked world, one heightfield for the ground, sphere colliders for the firs near the player, and the sky as the props' light. |
| `sky.ts` | The daylight: the sun, sky, fill, haze, exposure and tone curve. |
| `sea.ts` | The sea: the installed spectral simulation drives a lit water surface at the level the bake wrote. |

Art is CC0 (Poly Haven); provenance is in `@threenative/terrain/starter-credits.json`.

## Substitution

The preview's coastal stands use its licensed spruce models, which cannot ship in a kit. This kit
plants the CC0 fir from the forest kit in their place, with the same count and spacing. The
ocean is written to `water.json` as the one entry in `lakes`, with no `at`: the game draws it.

## Status

The kit bakes, streams and draws its sea. The kit ships no scene: the game writes one. The sea is a
lit surface at the baked level: the simulation's waves, the surf from the bake's shoreline, and the depth
tint. Its colours and sea state are in `sea.ts`. The close-up view is named `boulders` in the shared captures, although
it frames a fir.

## Steps

1. Copy `node_modules/@threenative/terrain/starter/coastal` to `src/terrain/coastal`.
2. Run `node src/terrain/coastal/bake.mjs --out assets/terrain/coastal` (needs `@threenative/terrain`
   as a devDependency). The same recipe always writes the same bytes.
3. In the scene, call `addCoastal(ctx, follow)` for the world and `coastalDaylight(follow)` for the light.

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

const loaded = await addCoastal(ctx, player);
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
