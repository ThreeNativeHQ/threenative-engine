# Credits and assets — strata-terrain-preview

## Temperate forest: Project Nature and Epic Games

The owner imported **Spruce Forest**, **Grass Library**, **Ground Foliage**,
**Meadow Flowers**, **Fern Collection** and **Conifer Bushes & Saplings 1** from Project Nature, and **Open World
Demo Collection / Kite Demo** from Epic Games, through the owner's entitled Fab
library. The per-pack `import-report.json` records source, entitlement and model provenance.
These are licensed source assets, not CC0 files.

**All licensed originals and cooked outputs are LOCAL-ONLY, gitignored, and never committed.**
Only the preparation script and game-owned rendering code are distributed.
Run from this example:

```sh
FAB_TEMPERATE=/path/to/imported/fab node scripts/prep-fab-temperate.mjs
```

The script reads the import reports and selects three full, two half and three small
spruces; four grasses; four flowers including a red poppy; three ground clumps;
two ferns; three Kite boulders, river rock, scree and `SM_Cliff01`; both
`SM_MountainRock` faces, four `LargeVolcanicRock` variants, both `SM_GroundRevealRock`
meshes and the `RockFace003` diffuse/normal/height ground maps. New rock textures are
bounded to 1K; Unreal's ground normal green channel is flipped for OpenGL. It repairs
Project Nature atlas bindings and composites each photographed opacity mask into
its albedo, then reuses `@threenative/assets` for meshopt geometry and compressed
textures. Duplicate sections are joined before cooking. Outputs live under
`local-assets/temperate/` with a 130 MB gate and Three.js's Apache-2.0 Basis transcoder.
Round 3 bounded `--worlds` cook measures 121.6 MiB (127.5 MB); the prior 120 MB cap rises by 10 MB for this
bounded rock selection. Licensed provenance remains in the owner's import reports.

Round 16 adds a bounded `--canopy` cook: the unthinned `ScotsPineTall_01`,
`SM_FieldGrass_01` with its recovered `T_FieldGrass_01_D` color/alpha atlas,
and `Spruce_08` with opacity from the blue channel of `Spruce_AORO`.
The pine keeps its authored alpha cutoff and 2K needle atlas; the sapling atlas is 1K.
Its two bark sections share albedo and UVs; they share trunk relief so the existing
join pass reduces four draws to three without removing geometry.
The forest uses full-crown pine in its near ring, conical mature spruce farther out,
the new spruce at sapling size, and a broad FieldGrass mat. Each optional addition falls back to the
previous species before procedural art. Coast retains its existing species.
The 130 MB gate counts unique live manifest payload, including shared images,
rather than obsolete hashes retained by incremental cooks.

`src/render/pack.ts` retains photographed material maps. Every section of a tree
uses the same whole-model scale and ground origin. `src/render/props.ts` draws
reduced copies of the full spruce meshes at distance using the existing instancing bands.
If the folder or a species is absent, procedural geometry and CC0 starter surfaces
continue to draw through the same placements. The licensed pack is optional.

## Landscape Pro 2.0 Auto-Generated Material, by STF3d

The earlier optional forest pack is **Landscape Pro 2.0 Auto-Generated
Material** on Fab, listing `1ac647da-b1bc-4e72-a56d-60aaeb6918e1` (paid, Personal/Professional
licence, owned by this repository's owner).

**Those files are not in this repository, and must not be.** The Fab Standard License does not permit
redistributing a paid pack's assets as standalone files, so what is committed is the importer and the
loader. `scripts/prep-landscape-pro.mjs` copies the earlier nine-species selection, plus the Basis
transcoder a cooked model decodes through, out of the owner's Fab import into this example's
gitignored `local-assets/landscape-pro/`:

```sh
node scripts/prep-landscape-pro.mjs            # from a cooked asset tree (the default)
node scripts/prep-landscape-pro.mjs --raw      # from the uncooked .glb import
```

It reads the owner's Wildwood sandbox by default and honours `LANDSCAPE_PRO=<dir>`. The source is
either that sandbox's `public/` — where the ThreeNative asset pipeline has already cooked this
listing, so a mesh is 5–215 KB of meshopt-compressed geometry with its images content-addressed under
`shared/images/` — or, with `--raw`, its `assets/fab/<listing>/Models/*.glb`, which draw identically
and cost 200 MB of downloads instead of 11.

**Without that folder the world still grows.** `src/render/pack.ts` fails soft per species and
`buildPropVariants` builds the procedural spruce, boulder, fern, grass and poppy in its place, which
is what CI, a fresh clone and any review get. That fallback is a live path, not a stub: the same
playtest runs green without the pack.

## Everything else

The ground's PBR maps, the fir and the prepared props are the CC0 sets in
`packages/terrain/starter-assets/`, served through this example's `publicDir`; provenance is that
folder's `credits.json`.

Use `node scripts/prep-fab-temperate.mjs --worlds` to update only crags/RockFace003.
It cooks into a separate staging output before merging; existing forest/coast species
and intentionally missing aliases remain untouched. The default command rebuilds the full set.

## Surveyed alpine and desert geology — USGS 3DEP (public domain)

U.S. Geological Survey, **3D Elevation Program (3DEP), The National Map**, 1 meter
and 1/3 arc-second Digital Elevation Models, accessed October 3, 2026.
[USGS 1 m collection and public-domain designation](https://data.usgs.gov/datacatalog/data/USGS:77ae0551-c61e-4979-aedd-d797abdcde0e)
and [1/3 arc-second collection](https://data.usgs.gov/datacatalog/data/USGS:3a81321b-c153-416f-98b7-cc8e5f0e17c3).

- Alpine: Longs Peak's Diamond / Chasm Lake headwall, Colorado;
  `USGS_1M_13_x44y446_CO_DRCOG_2020_B20`, project temporal extent 2020-05-26–2021-03-13;
  surroundings `USGS_13_n41w106_20221118`.
- Desert: Setting Hen Butte, Valley of the Gods, Utah;
  `USGS_1M_12_x60y413_UT_WestEast_B22`, project temporal extent 2022-06-04–2023-10-04;
  surroundings `USGS_13_n38w110_20241031`.

The committed `scripts/dem/*.bin` crops are 512 m / 257² detail and 5 km / 513²
surroundings, with complete bbox, NAD83 UTM CRS, NAVD88 elevation offset, source URLs,
filter and SHA-256 sidecars. Detail uses a 2×2 area filter; surrounding samples are
reprojected and bilinearly reconstructed. Both are quantized to 0.1 m, translated
vertically, with no vertical exaggeration. The bake adds a light transport pass;
these modifications are the example's, and are not approved or endorsed by USGS.
`node scripts/dem/crop.mjs <download-directory>` reproduces the crops. `geotiff`
and `proj4` are example-only development tools; games load baked arrays.

### Remaining surveyed worlds (DEM round 2)

- Forest: Sprague Lake / Glacier Creek valley, Rocky Mountain National Park, Colorado;
  `USGS_1M_13_x44y447_CO_DRCOG_2020_B20`, temporal extent 2020-05-26–2021-03-13.
- Coastal: Sand Beach / Great Head, Acadia National Park, Maine;
  `USGS_1M_19_x56y491_ME_MidCoast_2021_B21`, temporal extent 2021-05-09–2022-05-11.
- Tundra: Trail Ridge alpine basin, Rocky Mountain National Park, Colorado;
  `USGS_1M_13_x43y448_CO_NorthwestCO_2020_D20`, temporal extent 2020-06-20–2021-08-28.

All three detail sources are 1 m lidar; committed 2 m vertices use the same 2×2
area filter as round 1. Forest/tundra surrounding tile: `USGS_13_n41w106_20221118`;
coastal: `USGS_13_n45w069_20260521`. These are USGS public-domain 3DEP products
under the collection citations above, accessed October 3, 2026. Same-site 5 km
continuations contain no procedural peaks. Each crop has its own bbox/CRS/date/URL/hash
sidecar in `scripts/dem/`. Supply matching `forest.tif`, `coastal.tif`, `tundra.tif`
and `<world>-horizon-current.tif` files to the existing crop command; optional trailing
world names rebuild only those crops.

The Sprague Lake survey is hydro-flattened: shallow lake bathymetry and a creek are
authored into the measured surface by the existing bake stages. Tundra retains two
authored ponds and connecting meltwater channels at elevations fitted to its survey.
These water beds are example modifications, not measured lidar bathymetry. Coastal
water retains the example's 1.5 m sea level; the survey's marine flat is not bathymetry.
