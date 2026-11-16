// Cooks the forest kit's landform inputs (recipe.json, assets.json, surface.json, heightmap.r16) to
// one world.glb with `bakeKit` and the asset cook: `node cook-forest-fixture.mjs --out <dir>`.
// `verify-consumer.mjs` reads it as the stock-loader fixture. The forest kit's own bake does not.
import { cookTerrainWorld } from "@threenative/assets";
import { bakeKit } from "@threenative/terrain/kit";

await bakeKit(
  new URL("../../../../packages/terrain/starter/forest/recipe.json", import.meta.url).href,
  {
    sky: "hdri/kloofendal_48d_partly_cloudy_1k.hdr",
    cookTerrainWorld,
  },
);
