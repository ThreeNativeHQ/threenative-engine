import { type IAssetLoader, fetchAsset } from "@threenative/core";

/**
 * One baked file under `world/`, from the first root the asset loader resolves that serves it
 * (core `fetchAsset`). A miss on every root fails closed, naming the file the world is missing.
 */
export async function fetchBakedFile(
  assets: Pick<IAssetLoader, "resolve">,
  path: string,
  what = "world file",
): Promise<Response> {
  try {
    return await fetchAsset(assets, path);
  } catch (error) {
    throw new Error(`Missing baked ${what}: ${path}`, { cause: error });
  }
}
