import type { IAssetLoader } from "@threenative/core";

/**
 * One baked file under `world/`, from the first root the asset loader resolves that serves it.
 *
 * A fresh clone serves the bake's output from the Vite root; a packaged build serves it from the
 * assets directory, and the loader resolves both. The first root that answers wins, and a miss on
 * every root fails closed rather than drawing a world with half its files.
 */
export async function fetchBakedFile(
  assets: Pick<IAssetLoader, "resolve">,
  path: string,
  what = "world file",
): Promise<Response> {
  for (const url of await assets.resolve(path)) {
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      continue;
    }
    if (response.ok) return response;
  }
  throw new Error(`Missing baked ${what}: ${path}`);
}
