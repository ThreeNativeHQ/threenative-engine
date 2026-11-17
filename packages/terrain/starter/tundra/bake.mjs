// Run with [--assets <dir>] [--out <dir>]; defaults to installed assets and ./world.
// The tundra kit's look: its palette, its ground maps, its canopy rows and its prop policy.
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
    ground: { maps: GROUND_MAPS, tile: GROUND_TILE },
    canopy: CANOPY_CROWN,
    props,
  },
});
