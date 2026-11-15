# @threenative/procedural-vegetation

Optional bake-first procedural trees. An agent asks for `oak`, `spruce` or `baobab` and gets
a GLB it owns. The generator is [Arbor](LICENSES/Arbor-MIT.txt), written by João Paulo
Furtado and vendored under the MIT licence. `Arbor.three` and the browser PNG encoder are cut:
the game owns the look and the sway, so no game ships the generator.

```sh
npm i -D @threenative/procedural-vegetation
```

```ts
import { bakeVegetation, vegetationPresets } from "@threenative/procedural-vegetation";

vegetationPresets(); // [{ id: "oak", name: "English oak", latin: "Quercus robur", kind: "tree" }, ...]
const lods = await bakeVegetation({ preset: "oak", seed: 7, lods: [0, 1, 2], out: "assets/trees" });
// assets/trees/oak-7-lod0.glb ... each entry: { lod, path, triangles, bounds: { min, max } }
```

- The same preset, seed and lods write the same bytes. Files are written to a temporary name,
  then renamed.
- Fail closed: an unknown preset throws and names the nearest ids, the seed must be an
  integer, each lod is 0 (full) to 2 (far).
- Each GLB holds two primitives, `bark` and `foliage`, with `COLOR_0`, `TEXCOORD_0`, embedded
  textures, alpha-masked leaves and a `_WIND` vec4 per vertex: x trunk sway (m), y branch
  sway (m), z leaf flutter (m), w phase. Units are metres, +Y is up, the trunk stands on the
  origin.
- `@napi-rs/canvas` paints the leaf atlas at bake time (Arbor needs a Canvas 2D).

In a game, cook the GLBs with `assets.models.passes.prune: false` (prune strips the uv and
`_WIND` a material reads), load them with `ctx.assets.model` and write the sway as TSL in
`src/render/wind.ts` (`attribute("_wind", "vec4")`, a time uniform, `modelWorldMatrixInverse`).

A Strata terrain world takes the same trees with the species prefix `arbor:<preset>[@seed]`
(`terrain_generate`, `terrain_biome_new`); install this package next to `@threenative/terrain`.
