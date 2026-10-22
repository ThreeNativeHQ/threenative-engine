// Run with [--assets <dir>] [--out <dir>]; defaults to installed assets and ./world.
import { cookTerrainWorld } from "@threenative/assets";
import { bakeKit } from "@threenative/terrain/kit";

await bakeKit(import.meta.url, {
  sky: "hdri/kloofendal_48d_partly_cloudy_1k.hdr",
  cookTerrainWorld,
});
