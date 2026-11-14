import type { IAssetLoader } from "@threenative/core";
import { fetchBakedFile } from "./render/bakedFile.js";
import type { IBakedWorld } from "./render/ground/terrain.js";

/**
 * The baked terrain arrays (`world/forest.json`, written by `bake.mjs`), fetched rather than imported:
 * as a JSON module the 6 MB file costs seconds to compile before the first frame.
 */
export async function loadBakedWorld(assets: Pick<IAssetLoader, "resolve">): Promise<IBakedWorld> {
  const response = await fetchBakedFile(assets, "world/forest.json");
  return (await response.json()) as IBakedWorld;
}
