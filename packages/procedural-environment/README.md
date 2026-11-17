# @threenative/procedural-environment

Optional bake-first procedural nature: trees, cover, the forest floor and rocks, found by
biome. An agent asks for `oak`, `reeds`, `log` or a coastal `cliff` and gets a GLB it owns. The
generators are [Arbor](LICENSES/Arbor-MIT.txt), [forest-kit](LICENSES/forest-kit-MIT.txt) and
[Outcrop](LICENSES/Outcrop-MIT.txt), all written by João Paulo Furtado and vendored under the
MIT licence. `Arbor.three`, forest-kit's `build()`,
its three shapes and the browser PNG encoder are cut: the game owns the look and the sway, so no
game ships the generator.

```sh
npm i -D @threenative/procedural-environment
```

## Find what to bake

One catalog holds every element (`tree`, `cover`, `debris`, `rock`) with its biomes and the exact
bake call. A biome takes its id or a request word: `jungle` is `tropical`, `swamp` is `wetland`,
`canyon` is `desert`.

```ts
import { environmentBiomes, environmentElements } from "@threenative/procedural-environment";

environmentBiomes().map((biome) => biome.id);
// forest, hills, coastal, alpine, desert, tundra, volcanic, savanna, tropical, mediterranean, wetland, garden
environmentElements({ biome: "desert", kind: "rock" }).map((element) => element.bake);
// ['bakeRock({ form: "boulder", biome: "desert", seed: 1, out: "assets/environment" })', ...]
environmentElements({ search: "palm" }); // coconut, fanpalm, with their biomes
```

An unknown biome or kind throws and names the nearest ids. Biome ids match the Strata terrain
kits (forest, coastal, alpine, desert, tundra) where they overlap.

## Trees, cover and the forest floor

```ts
import { bakeVegetation, vegetationPresets } from "@threenative/procedural-environment";

vegetationPresets(); // [{ id: "oak", name: "English oak", latin: "Quercus robur", kind: "tree" }, ...]
const lods = await bakeVegetation({ preset: "oak", seed: 7, lods: [0, 1, 2], out: "assets/trees" });
// assets/trees/oak-7-lod0.glb ... each entry: { lod, path, triangles, bounds: { min, max } }
await bakeVegetation({ preset: "log", seed: 3, out: "assets/debris" });
await bakeVegetation({ preset: "reeds", seed: 4, out: "assets/cover" });
```

- The same preset, seed and lods write the same bytes. Files are written to a temporary name,
  then renamed.
- Fail closed: an unknown preset throws and names the nearest ids, the seed must be an
  integer, each lod is 0 (full) to 2 (far).
- Each GLB holds two primitives, `bark` and `foliage`, with `COLOR_0`, `TEXCOORD_0` and a
  `_WIND` vec4 per vertex: x trunk sway (m), y branch sway (m), z leaf flutter (m), w phase.
  Units are metres, +Y is up, the plant stands on the origin.
- The Arbor presets also carry their bark and leaf atlas and alpha-masked leaves. A forest-kit
  preset shades from `COLOR_0` alone: debris (opaque wood and stone) rides `bark`, cover (a thin
  blade or frond) rides the double-sided, alpha-masked `foliage` primitive, and its float sway is
  `_WIND.z`, with debris writing all four zero.
- `form` and `leafImage` patch an Arbor preset's shape and leaf card. A forest-kit preset throws
  when given either, because it has no leaf card to patch.
- `@napi-rs/canvas` paints the leaf atlas at bake time (Arbor needs a Canvas 2D).

## Rocks, cliffs and mountains

```ts
import { bakeRock } from "@threenative/procedural-environment";

await bakeRock({ form: "cliff", biome: "coastal", seed: 7, lods: [0, 1], out: "assets/rocks" });
// assets/rocks/cliff-coastal-7-lod0.glb ... the same { lod, path, triangles, bounds } entries
await bakeRock({ form: "boulder", biome: "forest", traits: { weathering: 0.8 }, out: "assets/rocks" });
```

- Forms: `boulder`, `slab`, `spire`, `hoodoo`, `stack` (sea stack), `mesa`, `arch`, `cliff`
  (tiles along X) and `mountain`. The biome sets the strata, fracture and weathering, and the
  painted cover: moss in a forest, snow in the tundra, sand in the desert, algae under the tide.
- `traits` and `surface` override the biome's values key by key (`roughness`, `strata`,
  `columnar`; `rockA`, `moss`, `snow`, `tide`), `size` sets metres and `detail` (0 to 1, default
  0.3) the level-0 density. An unknown key throws. Any override puts a hash in the file name.
- Each GLB holds one primitive on a `rock` material: `POSITION`, `NORMAL` and `COLOR_0` (linear
  RGB, rock and cover already blended). No UVs: a game material that wants texture detail
  projects it triplanar. Metres, +Y up, the rock rests on y = 0.
- The same options write the same bytes. `three` builds the geometry at bake time only.

## In a game

Cook the GLBs with `assets.models.passes.prune: false` (prune strips the uv and
`_WIND` a material reads), load them with `ctx.assets.model` and write the sway as TSL in
`src/render/wind.ts` (`attribute("_wind", "vec4")`, a time uniform, `modelWorldMatrixInverse`).

A Strata terrain world takes the same trees with the species prefix `arbor:<preset>[@seed]`
(`terrain_generate`, `terrain_biome_new`); install this package next to `@threenative/terrain`.

## Nature map

One package, one table: what bakes here, what the engine streams, and where the rest lives. An
agent asked for "a realistic forest" should not have to find nine places by itself.

| Piece | Where it lives | Import path |
| --- | --- | --- |
| Trees (28 species) | `bakeVegetation`, Arbor presets, kind `tree` | `@threenative/procedural-environment` |
| Cover (grasses, ferns, flowers, shrubs) | `bakeVegetation`, Arbor presets plus forest-kit `reeds`, `tussock`, `seedgrass`, `clover`, `dock`, `plume`, kind `cover` | `@threenative/procedural-environment` |
| Debris (`log`, `stump`, `twig`, `branch`, `leaflitter`, `rock`) | `bakeVegetation`, forest-kit presets, kind `debris` | `@threenative/procedural-environment` |
| Rocks, cliffs, arches, mesas, sea stacks, mountains | `bakeRock`, Outcrop forms, kind `rock` | `@threenative/procedural-environment` |
| Which of these belong in a biome | `environmentElements({ biome, kind, search })`, `environmentBiomes()` | `@threenative/procedural-environment` |
| Grass that sways and parts around the player | `GrassField3D`, streamed in chunks under a frame budget | `@threenative/core` |
| Any other baked mesh scattered round the player | `ScatterField3D`, the same tile ring as grass, one `InstancedMesh` per level per part | `@threenative/core` |
| The look: materials, wind TSL, distance fade | the game's own `src/render/`, reading `_WIND` and `GRASS_FIELD_ATTRIBUTES` | game source |
| Sky and sun | `Daylight` | `@threenative/core` |
| Water | `WaterSurface3D`, `WaterBodies` | `@threenative/core` |
| Terrain, biomes and a cooked world | `@threenative/terrain` (`terrain_generate`, `arbor:<preset>[@seed]` species) | `@threenative/terrain` |
| Textures | Arbor's bark and leaf atlases at bake; scanned CC0 maps through the asset MCP (Poly Haven, ambientCG) | — |
