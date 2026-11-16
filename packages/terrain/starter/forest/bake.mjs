// The forest's bake: `node src/terrain/forest/bake.mjs [--out <dir>]` (default `assets/terrain/forest`).
// `bakeKit` reads `recipe.json` (the surveyed Sprague Lake valley, USGS 3DEP, public domain; its far
// ring from the starter assets' `survey/` grids; its art) and `biome.data.json`; this kit's own TypeScript gives the look and the prop policy,
// so it runs under `tsx` (`npm i -D tsx`).
import { bakeKit } from "@threenative/terrain/kit";
import { register } from "tsx/esm/api";

register();
const { terrainPalette } = await import("./render/ground/palette.js");
const { GROUND_MAPS, GROUND_TILE } = await import("./world/terrainAssets.ts");
const { CANOPY_CROWN } = await import("./render/ground/terrain.ts");
const props = await import("./render/props/props.ts");

await bakeKit(import.meta.url, {
  look: {
    palette: terrainPalette,
    ground: {
      maps: {
        ...GROUND_MAPS,
        dirt: {
          diffuse: "river_small_rocks/river_small_rocks_diff_512.jpg",
          normal: "river_small_rocks/river_small_rocks_nor_gl_512.jpg",
        },
      },
      tile: GROUND_TILE,
    },
    canopy: CANOPY_CROWN,
    props,
  },
});
