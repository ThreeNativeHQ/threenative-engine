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
viewer. Search the sidebar by name or filter by biome and style tags. Selecting several tags
shows assets with any of those tags. Nature and city modules are tagged Realistic, the Biome
Kit, the Dungeon kit, and the Village kit, one collection, are tagged Stylized. The Toybox kit is
tagged Stylized realism. Open a story to orbit the asset.
GLB stories run the package's bake with the selected controls. The Docs tab shows the exact
bake call and mesh attributes, and the Stats tab shows dimensions and triangle counts.
Story links retain the controls, such as `#/rock/cliff?biome=coastal&module=1`. Changes
under `src/`, `vendor/`, or `scans/` rebuild the package and reload the viewer.

### Workshop Kit

Open **Workshop Kit** for workshop, bedroom, lounge, dining, kitchen, bathroom and office furniture.
Use **Width** to resize work surfaces, the wall shelf, dining bench, vanity or bathtub. Pick two or three
**Seats** for the sofa or lounge, or four or six for the dining set. **Open** previews the top
drawer, cabinet and wardrobe doors, or the toilet and trunk lids. **Scale**, **Seed** and **Accent color** make size
and finish variants.

| Asset | Named nodes and placement |
| --- | --- |
| Workbench | `worktop`, `workbench-drawer-bay`, and `workbench-stool-bay` place props and matching furniture. |
| Stool and bed | `stool-seat` and `bed-sleep` sit on the usable surfaces. |
| Drawer cabinet | Translate `drawer-1` through `drawer-3` along local +Z. `drawer-content` follows the top drawer. |
| Wall shelf | Mount `shelf-wall` on a facing surface. Local +Z points away from the wall. Use `shelf-surface` for props. |
| Locker | Rotate `locker-door` around local Y. Place items on `locker-floor` or `locker-shelf`. |
| Sofa, armchair and lounge | Use `seat-1` through `seat-3` on the sofa and `armchair-seat` on the chair. The lounge includes both and the coffee table. |
| Coffee table | Place props at `coffee-surface` or `coffee-shelf`. |
| Media console | Rotate `console-door-left` and `console-door-right` around their local Y axes. Place props at `console-top` or `console-shelf`. |
| Dining table and set | Place dishes at `dining-top`. The set adds four or six separately movable chairs with `dining-seat-1` through `dining-seat-6`. Seat local +Z faces the table. |
| Dining chair and bench | Place characters at `dining-seat`, `bench-seat-left` or `bench-seat-right`. |
| Kitchen | Align each module's `{section}-join-right` with the next `{section}-join-left`, facing their local +Z axes toward each other. Counter height is 0.91 m before scale. `prep-surface`, `sink-basin`, `sink-faucet` and `cooktop-burner-1` through `cooktop-burner-4` mark work positions. Rotate `{section}-door-left` or `{section}-door-right` around local Y. |
| Vanity and tub | Place props at `vanity-shelf`, `vanity-basin` or `tub-bottom`. Water outlet nodes are `vanity-faucet` and `tub-spout`. Detach or reposition the `tub-faucet` group at its floor mount, `tub-filler`. The tub's long axis is local X. |
| Toilet | Rotate `toilet-seat` or `toilet-lid` upward around local −X. `toilet-sit` follows the seat and `toilet-flush` marks the button. |
| Office desk and workstation | Use `desk-monitor`, `desk-keyboard` and `desk-cable` to place equipment. The workstation includes the desk, swivel chair and monitor. **Width** changes the desk size and **Seat height** adjusts the chair independently. |
| Swivel chair and monitor | Turn `chair-swivel` around local Y. `chair-seat` follows its cushion. Rotate `monitor-panel` around local X to tilt it. Attach a 16:9 UI at `monitor-display`, facing local +Z. The screen corner nodes mark its 0.48 × 0.27 m area before scaling. |
| Bookcase | Set **Width** independently of **Shelf levels** (3–5). Use `bookcase-shelf-1` upward for item placement, starting at the bottom shelf. `bookcase-wall` faces the wall (local −Z of the bookcase). |
| Wardrobe and trunk | Set **Width** to fit the alcove or room. Rotate `wardrobe-door-left` around local −Y, `wardrobe-door-right` around +Y and `trunk-lid` around −X. Place props at `wardrobe-floor`, `wardrobe-shelf`, `wardrobe-hanger-rail` or `trunk-content`. `trunk-latch` marks the stationary front clasp. |
| Lamps | Set **Height** on the floor lamp (1.28–1.86 m) or **Tilt** on the desk lamp (−30° to 35°). Rotate `lamp-head` about local X to animate the desk lamp. Place the sconce's `lamp-wall` at the wall surface, pointing into the wall. |

**Lit** switches the lamp materials to emissive. To illuminate the scene, attach a game light at
`light-emitter` and aim its beam along the marker's local +Z. The desk lamp's emitter follows the
tilting head.

The assembled kitchen run includes prep, sink and cooktop cabinets. Changing **Width** resizes
the prep section while the sink and cooktop remain 0.6 m wide.

The furniture uses +Y up and faces +Z. The shared 512 px wood color and normal maps come from
[Poly Haven's CC0 Cherry Veneer](https://polyhaven.com/a/cherry_veneer) and ship embedded as WebP.

```ts
import { bakeWorkshop } from "@threenative/procedural-environment";

await bakeWorkshop({ module: "workshop-station", width: 2.4, out: "assets/furniture" });
```

### Logistics Kit

Open **Logistics Kit** for a timber pallet, stackable cargo tote, an assembled loaded pallet,
a pallet jack, an adjustable warehouse rack, and a walk-in shipping container. Change
**Shelf levels** to fit the rack to your space and **Doors open** to preview the container interior.
Use the same **Scale** across parts that interact. **Accent color** recolors painted surfaces
and **Seed** varies the timber and paint finish.

| Asset | Named nodes and placement |
| --- | --- |
| Pallet | `pallet-fork-rear` and `pallet-fork-front` face into the channels from opposite ends. `pallet-load-left` and `pallet-load-right` seat one tote each. |
| Cargo tote | Place the next tote at `tote-stack` for a vertical stack. |
| Pallet jack | Match `jack-fork-entry` to a pallet's fork socket. Raise the `jack-forks` group along +Y or tilt `jack-handle` around X relative to the jack. |
| Rack | `rack-shelf-1` through `rack-shelf-4` are the centers of available deck surfaces. Place an empty or loaded pallet at each. |
| Container | `container-deck` seats cargo on the interior floor. Door groups `container-door-left` and `container-door-right` pivot outward about local Y. |

The jack's forks and the container's entry face +Z. The models and their named nodes are
baked in metres. The game supplies the controls, collision, and cargo motion.

```ts
import { bakeLogistics } from "@threenative/procedural-environment";

await bakeLogistics({ module: "logistics-rack", shelves: 4, out: "assets/cargo" });
```

### Sports Kit

Open **Sports Kit** for a soccer goal, basketball hoop and backboard, a court net, and
three matching balls. Set the goal's clear opening width and height, the hoop's rim
height, or the court net's span and center height. The post and rim thickness stay
fixed when height changes. **Scale** resizes the whole piece. **Accent color** recolors
the visible paint or ball panels.

| Asset | Named nodes | Placement |
| --- | --- | --- |
| Soccer goal | `goal-center`, `goal-left-post`, `goal-right-post`, `goal-crossbar` | Opening faces +Z. Post and crossbar nodes mark the clear opening. |
| Basketball hoop | `rim-center`, `backboard-target` | Hoop faces +Z. Use the rim center to place a scoring test. |
| Court net | `net-left`, `net-center`, `net-right` | Net runs across X. Nodes mark the centerline of the top cord. |
| Soccer ball, basketball, tennis ball | `ball-center` | The model rests on y = 0. Use the center node for a rotation pivot. |

```ts
import { bakeSports } from "@threenative/procedural-environment";

await bakeSports({ module: "sports-net", span: 9.5, height: 2.24, out: "assets/sports" });
```

Dimensions are in metres before scale. The game owns collision, scoring and ball motion.

### Rail Kit

Open **Rail Kit** for straight and quarter-turn track, a raised approach, a trestle bridge,
a buffer stop and an open minecart. **Scale** applies to the whole piece, including its
attachment points. Keep the same scale across the route. **Accent color** recolors
the ramp, bridge, stop and cart. **Seed** varies the timber and iron finishes.

Snap `track-out` to the next piece's `track-in` by matching their world positions and rotations.
The sockets are at rail height and local +Z points along travel. The curve turns toward +X
with a 4 m centerline radius. Straight sections run 4 m. The ramp rises 1 m to the bridge's
rail height. The buffer stop has one track socket.

Place the cart origin at rail height and point its local +Z along the track. Rotate the
`cart-front-axle` and `cart-rear-axle` groups around their local X axes. The `cart-load` node is
at the center of the hopper floor. The game supplies the route, motion and collision.

```ts
import { bakeRail } from "@threenative/procedural-environment";

await bakeRail({ module: "rail-cart", accent: "#447c8a", out: "assets/rail" });
```

### Mechanism Kit

Open **Mechanism Kit** for a signal emitter, receiver and reflector, a modular conveyor,
a rotating deck and a power cell socket. All six bake as grounded PBR GLBs. Change **Accent color**
and **Scale** in the viewer. Toggle **Active** to bake lit indicators for the emitter, receiver or socket.

| Piece | Named node | Placement |
| --- | --- | --- |
| Emitter, receiver, reflector | `signal-output`, `signal-input`, `signal-reflector` | Face centre at y = 0.72 m. Local +Z points out. |
| Conveyor | `belt-start`, `belt-end` | 2 m sections run toward +Z with the belt at y = 0.34 m. |
| Rotating deck | `turntable-deck` | Rotate the child group around its Y axis. Its surface matches the conveyor. |
| Power cell socket | `cell-dock` | Seat the Station Kit power cell here at matching scale. |

These coordinates describe the default scale. Read the named world transforms in your game
to work with scaled or rotated pieces. The GLBs carry the visual parts and attachment points.
The game supplies movement, signals and collision.

```ts
import { bakeMechanism } from "@threenative/procedural-environment";

await bakeMechanism({ module: "mechanism-receiver", active: true, out: "assets/mechanisms" });
```

### Pickups

Open **Pickups** for seven stylized props for recovery, access and equipment: a medkit,
potion, access keycard, shield, vault key, parchment scroll and repair wrench. Use **Accent color**
for variants that need to read differently in play, **Scale** for size (0.5× to 2×), and **Seed** for
subtle changes in the finish. Set **Pose** to Flat on the access card, shield, vault key or wrench
for a face-up prop in an overhead game. GLBs use opaque PBR materials and sit at y = 0. Upright
props face +Z.

```ts
import { bakePickup, environmentElements } from "@threenative/procedural-environment";

environmentElements({ kind: "pickup" });
await bakePickup({
  module: "pickup-keycard",
  accent: "#ed5166",
  scale: 1.5,
  out: "assets/pickups",
});
```

### Frontier Kit

Open **Frontier Kit** for industrial buildings and props for strategy, colony and base-building
games. It includes command headquarters, a supply depot, an ore processor, a power generator,
a communications relay, a crystal ore deposit, a landing pad and an assembled outpost.

**Team color** sets the painted panels across the kit. **Scale** sets the uniform size from
0.5× to 2×. **Seed** varies the ore cluster and ceramic paint tones. The modules are centred at
ground level, use +Y up and are baked in metres as opaque PBR GLBs.

```ts
import { bakeFrontier, environmentElements } from "@threenative/procedural-environment";

environmentElements({ kind: "frontier" });
await bakeFrontier({
  module: "frontier-command",
  accent: "#628ac4",
  scale: 1.5,
  out: "assets/frontier",
});
```

### Station Kit

Open **Station Kit** for 12 stylized science-fiction interiors and props. The kit covers deck,
wall, bulkhead and ceiling pieces, straight, elbow, T and four-way corridors, a cargo case,
control terminal, power cell and an assembled maintenance junction. Use **Accent paint** to
recolor the kit and **Ceiling** to enclose a corridor or show its interior from above.

```ts
import { bakeStation, environmentElements } from "@threenative/procedural-environment";

environmentElements({ kind: "station" });
await bakeStation({
  module: "station-elbow",
  accent: "#ee9955",
  roof: true,
  out: "assets/station",
});
```

Corridors snap on a 4 m grid. North is −Z and the deck surface is 0.25 m above the origin.
Rotate in quarter turns to match the open sides. Corridor GLBs record their local openings
in `extras.sockets`. Place standalone props on the deck at y = 0.25 m, and place the separate
ceiling at y = 3.2 m. Paint and ceiling changes produce distinct filenames.

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

### Village kit

The **Village** section belongs to the same collection: it uses the Biome Kit's faceted painted
material and palettes. It has 43 pieces and two assembled scenes, Village green and Walled town.
Each piece comes in Meadow Village, Snowy Village, and Desert Village (variants 0, 1, and 2).
Snow, grass, or sand settles on roofs and stone tops for each theme.

- Buildings: cottage, two-storey house, tavern, barn, watchtower, windmill, forge, market stall, well.
- Enterable buildings: the house, the inn, and the shop have hollow walls, an open door, a plank
  floor, and furniture inside (bed, hearth, bar, shop counter). The `-cutaway` ids leave off the roof
  to show the room from above. Both scenes place walk-in houses, named `village-home`,
  `village-inn`, and `village-shop`.
- City walls: a 4 m wall segment along X with its outer face on +Z, a round wall tower, and a
  gatehouse with a half-raised portcullis.
- Walls, fences, paths, and props: timber-framed wall modules, fences, a gate, cobblestones, a cart,
  haystacks, a lamp post, a signpost, and the dungeon crate, barrel, sack, table, and bench.

```ts
import { createStylizedAsset } from "@threenative/procedural-environment/stylized";

const inn = createStylizedAsset("village-inn", { seed: 4, variant: 1 });
const town = createStylizedAsset("village-town", { variant: 2 }); // group, view, env
```

### Toybox kit

The **Toybox** kit (collection Stylized realism) has toy-like shapes with realistic surfaces:
clearcoat plastic, gold, riveted metal, layered rock, soil and planks (triplanar maps in `scans/toybox_*`),
dense grass blades and swaying trees. It has 56 modules and three scenes, Sky garden, Obstacle
course and Island cove, in Sky Garden, Frost Peak and Sand Ruins (variants 0, 1, and 2). Each scene
also returns a blurred sky panorama `backdrop` for that theme.

- Modules snap to a 2 m grid and stand on y = 0. Terrain blocks rise in whole metres (1 m and 2 m
  blocks, a collar edge, a rounded corner, a ramp, a cliff, a pond). Platforms are 0.5 m thick (slab,
  circuit deck panel, glass panel, launch pad, stairs, hover platform, 4 m bridge, rail, pipes). The
  pier deck is 1 m, level with a grass block. The deck panel traces meet at each edge, so a row of
  panels forms one circuit. The scenes are assembled only from these modules.
- Island cove stands its plateaus in an open sea that runs to the horizon. Shore foam edge and
  corner pieces follow a plateau's outline and lap at its walls. Vines hang over its straight edges.
- Temple ruins: cut-stone platforms, stepping pillars, floating and sliding stone rafts, carved ruin
  blocks with meander panels, and lattice glyph pillars, in sandstone and flagstone maps.
- Obstacles: a spinner bar, a spike trap, the sliding raft, and a goal gate. Obstacle course runs a
  full level through them, from a start garden to the gate.
- Props and plants: crate, barrel, stone gateway, palm, canopy tree, spiky rosette, broadleaf plant,
  tulips, fruit piles, round tree and bush, flowers, rocks, crystals.
- Gameplay pieces animate: coins spin and bob, the bounce pad squashes and launches, the cannon
  recoils, the spinner sweeps, the spikes shoot up, the stone rafts slide and bob, the hover platform bobs, glows pulse, the waterfall flows, the sea rolls and the
  shore foam laps.
- Grass, flowers and trees sway, and bend away from up to four pushers that you set with `toyboxPush`.

```ts
import { createStylizedAsset, stylizedUniforms, toyboxPush } from "@threenative/procedural-environment/stylized";

const { group, update, backdrop } = createStylizedAsset("toybox-garden", { variant: 0 });
// each frame:
stylizedUniforms.uTime.value = seconds;
update?.(seconds);
toyboxPush(0, player.x, player.y, player.z, 0.7);
```

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
