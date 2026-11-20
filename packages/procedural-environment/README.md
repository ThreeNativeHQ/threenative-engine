# @threenative/procedural-environment

Optional bake-first procedural nature: trees, cover, the forest floor and rocks, found by
biome. An agent asks for `oak`, `reeds`, `log` or a coastal `cliff` and gets a GLB it owns. The
generators are [Arbor](LICENSES/Arbor-MIT.txt), [forest-kit](LICENSES/forest-kit-MIT.txt),
[Outcrop](LICENSES/Outcrop-MIT.txt) and the [Apex City Kit](LICENSES/Apex-MIT.txt), all written by João Paulo Furtado and vendored under the
MIT licence. `Arbor.three`, forest-kit's `build()`,
its three shapes and the browser PNG encoder are cut: the game owns the look and the sway, so no
game ships the generator.

```sh
npm i -D @threenative/procedural-environment
```

## Find what to bake

The bake catalog lists each element (`tree`, `cover`, `debris`, `rock`, `city`) with its biomes and the exact
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

## Browse everything: `pnpm asset-library`

From the repository root, `pnpm asset-library` builds this package and opens a Storybook-style
viewer. Search the sidebar by name or filter by style and biome, then open a story to orbit the
asset. Style follows the asset's default look: Realistic for nature and city modules, Stylized
for the Dungeon kit, and Low poly for the Stylized Biome Kit.
GLB stories run the package's bake with the selected controls. The Docs tab shows the exact
bake call and mesh attributes, and the Stats tab shows dimensions and triangle counts.
Story links retain the controls, such as `#/rock/cliff?biome=coastal&module=1`. Changes
under `src/`, `vendor/`, or `scans/` rebuild the package and reload the viewer.

### Stylized Biome Kit

Open **Stylized Biome Kit** in the same sidebar for the alpine forest, snow peaks, and desert
canyon scenes, all original asset variants, and the three mountain ridges. These generators
return Three.js objects with their original WebGL shader materials. Advance
`stylizedUniforms.uTime.value` each frame to animate water, snow, and foliage.

```ts
import { createStylizedAsset, stylizedAssets } from "@threenative/procedural-environment/stylized";

const assets = stylizedAssets();
const { group } = createStylizedAsset("mountain-snow", { seed: 8, variant: 1 });
scene.add(group);
```

The subpath also exports the source kit's `terrain`, `sky`, and `scatter` helpers. The Docs tab
copies the call for the selected asset and controls. Variant indices in code start at zero.

### Dungeon kit

The **Dungeon** section includes 49 procedural pieces and two assembled previews. Each piece comes
in Ancient Ruins, Ice Dungeon, and Lava Depths. Walls run along X and pair with 4 m floor modules.
Rotate walls 90° around Y for the other axis. Straight stairs rise 2 m toward negative Z.

```ts
import { createStylizedAsset, stylizedUniforms } from "@threenative/procedural-environment/stylized";

const torch = createStylizedAsset("dungeon-wall-torch", { seed: 12, variant: 0 });
scene.add(torch.group);

function tick(elapsedSeconds: number) {
  stylizedUniforms.uTime.value = elapsedSeconds;
  torch.update?.(elapsedSeconds);
}
```

The wall torch, brazier, hanging lamp, candle cluster, and altar carry their own point light. The
shader moves the flame and embers, and `update` flickers the emitted light. The Theme control in the
viewer corresponds to variant indices 0, 1, and 2.

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
- Textures are CC0 scans by default (`scans/credits.json`). Bark: species bark from Poly Haven on
  the Arbor trees whose bark has a scan (oak, cedar, palm, sakura ...; the pines keep Arbor's drawn orange bark, because the scan read pale and smooth). Wood and stone: a grey
  detail scan on forest-kit `log`, `stump`, `branch`, `twig` and `rock`, whose `COLOR_0` takes twice
  Arbor's untextured colour factor, so the kit's palette stays. The bake's `scan` names the bark or detail scan.
- Foliage: real scanned leaves, cut from the alpha atlases of Poly Haven plant models, and from
  ambientCG leaf sets where Poly Haven has no such leaf. Arbor still lays out each leaf card (its
  twigs, fronds and blossoms), but each leaf, blade, frond or needle sprig is a scan, tinted to the
  species palette. The families: oak (ambientCG `LeafSet016`), maple (`LeafSet027`), ovate and birch
  leaves (`shrub_01`), elliptic (`island_tree_01`), lance (`shrub_02`), feathery acacia and jacaranda
  (`jacaranda_tree`), grass blades (`grass_medium_02`), fern fronds (`fern_02`), spruce
  sprigs (`pine_tree_01`). Foliage is matte (roughness 0.85) with a gentle leaf normal (scale 0.5), so
  it does not reflect the sky as grey-white patches. forest-kit cover and leaf litter
  wear a grey blade or leaf scan with the same `COLOR_0` rule. Leaf litter then rides the alpha-masked
  `foliage` primitive, so each leaf keeps its scanned outline. The bake's `leafScan` names the
  sprites. Ginkgo, palm fronds, yucca, flower heads, the elephant ear and the fine-scale cedar,
  cypress, araucaria and pine needle cards read better drawn than scanned and
  keep Arbor's drawing (`__tests__/texture-health.spec.ts` fails on any other foliage without a scan
  or a texture).
- `textures: "generated"` keeps the generators' own textures pixel for pixel. Every embedded image
  is WebP (`EXT_texture_webp`, required): bark scans 512 px at q75 (normals q80), leaf sprites q75
  and leaf atlases q80, both with lossless alpha, so a cutout edge stays exact. A leaf card also carries a
  normal map at half resolution, cooked from its own outline and veins.
- One scan serves every species that shares it (19 bark profiles, 11 scans). Each GLB embeds its
  copy, and the cook's shared-images pass (`@threenative/assets`, on by default) writes each
  distinct image once under `shared/images/`, so a game ships the bark once.
- The Arbor presets also carry their bark and leaf atlas and alpha-masked leaves. A forest-kit
  preset shades from `COLOR_0` and its grey scan: wood and stone ride `bark`, cover (a thin blade or
  frond) and leaf litter ride the double-sided, alpha-masked `foliage` primitive, and its float sway
  is `_WIND.z`, with debris writing all four zero.
- `form` and `leafImage` patch an Arbor preset's shape and leaf card. A forest-kit preset throws
  when given either, because it has no leaf card to patch.
- `leafSize` caps the drawn leaf card's longest side: Arbor draws 1024 px, and a far level or a
  shrub a metre tall shows a few hundred at most, so a game that cares about bytes bakes those
  smaller. A game's own `leafImage` is never resized; the two together throw.
- `barkImage` and `barkNormalImage` paint a photographed surface and its relief on the bark
  instead of Arbor's drawn one. A species whose trunk is the whole silhouette needs it: a
  `saguaro` is a column, and the drawn cactus bark is a flat pinstripe. The relief is a glTF
  tangent-space normal PNG, drawn against the albedo; without it the bark is left flat, because
  Arbor's own bark normal belongs to a bark that is no longer sampled. `barkNormalImage` without
  `barkImage` throws.
- `@napi-rs/canvas` paints the leaf atlas at bake time (Arbor needs a Canvas 2D), and `sharp`
  encodes the WebPs.

## Rocks, cliffs and mountains

```ts
import { bakeRock } from "@threenative/procedural-environment";

await bakeRock({ form: "cliff", biome: "coastal", seed: 7, lods: [0, 1], out: "assets/rocks" });
// assets/rocks/cliff-coastal-7-lod0.glb ... the same { lod, path, triangles, bounds } entries
await bakeRock({ form: "boulder", biome: "forest", traits: { weathering: 0.8 }, out: "assets/rocks" });
```

- Forms: `boulder`, `slab`, `spire`, `hoodoo`, `stack` (sea stack), `mesa`, `arch`, `cliff`
  (tiles along X) and `mountain`. A cliff is one module of a wall: bake module n with the same
  seed and `module: n` (or `offset: [n * width, 0, 0]`), stand the modules one width apart and they join with no
  seam. A module that stands alone shows a cut face at each end. The biome sets the strata, fracture and weathering, and the
  painted cover: moss in a forest, snow in the tundra, sand in the desert, algae under the tide.
- `traits` and `surface` override the biome's values key by key (`roughness`, `strata`,
  `columnar`; `rockA`, `moss`, `snow`, `tide`), `size` sets metres and `detail` (0 to 1, default
  0.3) the level-0 density. An unknown key throws. Any override puts a hash in the file name.
- Each GLB holds one primitive on a `rock` material: `POSITION`, `NORMAL` and `COLOR_0` (linear
  RGB, rock and cover already blended), plus `_ROCK`, `_COVER` and `_WET`, the inputs of Outcrop's
  triplanar `createRockMaterial`. Beside it the bake writes that material's two maps as lossless
  WebPs (`rock` in the result: detail rgb albedo and a roughness, normal rgb and a height). No UVs:
  the material projects them triplanar. Metres, +Y up, the rock rests on y = 0.
- The same options write the same bytes. `three` builds the geometry at bake time only.

## City modules: roads, buildings, props, vehicles

```ts
import { bakeCity, environmentElements } from "@threenative/procedural-environment";

environmentElements({ kind: "city" }).map((element) => `${element.category}: ${element.id}`);
// 75 modules: Roads: cross, ... Buildings: office, ... Vehicles: sedan, ... Decals & Works: road-grime
await bakeCity({ module: "cross", out: "assets/city" });
// assets/city/cross-31082.glb, one { lod: 0, path, triangles, bounds } entry
await bakeCity({ module: "apartments", seed: 7, floors: 8, out: "assets/city" });
await bakeCity({
  module: "curve",
  bendAngle: 55,
  bendRadius: 24,
  bendSide: "left",
  roadWidth: 12,
  sidewalk: false,
  curb: false,
  out: "assets/city",
});
```

- The generator is the vendored [Apex City Kit](LICENSES/Apex-MIT.txt) page with its
  own three.js r183 in `vendor/apex/`. The bake runs the page's generator and its GLTFExporter in a
  `node:vm` context, with `@napi-rs/canvas` for the canvas and image decode, and exports the way
  the page's GLB button does (binary, `trs`, textures capped at 1024 px).
- Options and limits are the page's: `seed` 0 to 4294967295 (default 31082), `detail` 0 to 2
  (default 2), `wet` 0 to 100 (default 30), `floors` 2 to 12 (default 4), `text` at most 24
  characters, `dressing` true or false. An unknown module names the nearest ids. Options other
  than the seed put a hash in the file name.
- Each GLB holds one merged mesh per material with the page's PBR materials and embedded
  textures: the CC0 Poly Haven maps (asphalt, concrete, brick, paving, metal, rubber, oak, roof
  tiles, shutter, formwork; JPEG colour, PNG normal and ARM) and the canvas-drawn signs, liveries
  and markings. The root node's extras hold `module`, `seed`, `parameters`, `units` and the road
  `sockets`. Units are metres with +Y up. Stock tiles use a 24 m grid.
- Set `roadWidth` (6–16 m) on straight and curve modules, and `roadLength` (8–200 m)
  on straights. Curves expose `bendAngle` (5–180°), `bendRadius` (12–120 m), and
  `bendSide` (`left` or `right` from the north inlet). These pieces still carry two lanes.
  To join them, align the socket positions and point their outward directions opposite each
  other. Match socket widths for a flush join. The outlet of a non-90° bend has side `end`.
- Use `roadSurface` (`asphalt`, `concrete`, or `paving`) on socketed roads. Toggle
  `sidewalk` and `curb` independently on straight, curve, cross, tee, alley, grid, pit,
  and cul-de-sac modules. On straight and curve modules, `markings: false` removes lane paint.
- The page's PNG and JPEG maps are re-encoded as WebP q80 at bake (`EXT_texture_webp`): the 95
  distinct city images drop from 5.6 MB to 1.2 MB.
- The same options write the same bytes on one machine and Node major: sign text draws with the
  machine's `sans-serif` and `monospace` fonts, and Node 20 and 22 round some colour factors one
  bit differently from Node 24 and the browser.

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
| City roads, buildings, street props, vehicles, race kit (75 modules) | `bakeCity`, Apex City Kit modules, kind `city` | `@threenative/procedural-environment` |
| Which of these belong in a biome | `environmentElements({ biome, kind, search })`, `environmentBiomes()` | `@threenative/procedural-environment` |
| Grass that sways and parts around the player | `GrassField3D`, streamed in chunks under a frame budget | `@threenative/core` |
| Any other baked mesh scattered round the player | `ScatterField3D`, the same tile ring as grass, one `InstancedMesh` per level per part | `@threenative/core` |
| The look: materials, wind TSL, distance fade | the game's own `src/render/`, reading `_WIND` and `GRASS_FIELD_ATTRIBUTES` | game source |
| Sky and sun | `Daylight` | `@threenative/core` |
| Water | `WaterSurface3D`, `WaterBodies` | `@threenative/core` |
| Terrain, biomes and a cooked world | `@threenative/terrain` (`terrain_generate`, `arbor:<preset>[@seed]` species) | `@threenative/terrain` |
| Textures | Poly Haven CC0 bark and detail scans and CC0 leaf, blade and frond sprites (Poly Haven, ambientCG) vendored in `scans/` (WebP); other scanned CC0 maps through the asset MCP | `@threenative/procedural-environment` |
