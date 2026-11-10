import type { IAssetLoader } from "@threenative/core";
import type { IBiomeSpec } from "@threenative/terrain";
import { fetchBakedFile } from "./render/bakedFile.js";
import type { WorldName } from "./render/biomes.js";
import type { IBakedWorld } from "./render/terrain.js";
import { WORLD_NAMES } from "./render/worldNames.js";

/**
 * Which key selects which world: the number keys, in `WORLD_NAMES` order.
 *
 * One list owns the selector: the input map binds these keys, the frame loop reads them, and
 * `__tests__/world-keys.spec.ts` pins them. A world's spawn, camera framing, bake and look rules come
 * from its biome row; its key is its place in the world list, so a new world adds no code here.
 */
const select = {} as Record<WorldName, { readonly keys: readonly string[] }>;
for (const [index, world] of WORLD_NAMES.entries())
  select[world] = { keys: [`Digit${String(index + 1)}`] };
export const WORLD_SELECT: Readonly<typeof select> = select;

/** The world the game opens in. */
export const START_WORLD: WorldName = "forest";

/** Every world this game offers, in the order the number keys reach them. */
export const WORLD_ORDER: readonly WorldName[] = WORLD_NAMES;

/**
 * The baked terrain arrays, fetched rather than imported: as JSON modules the 7–12 MB files cost
 * about 3 s each to compile before the first frame. Which file, and the key inside it, is the biome
 * file's own `bake`: two biomes baked from one DEM share a bundle, and no loader branch names a
 * world. The bundle's other keys are returned with the data, because a world drawn beside another
 * one is the world this one is compared with.
 */
export async function loadBakedWorld(
  assets: Pick<IAssetLoader, "resolve">,
  spec: IBiomeSpec,
): Promise<{ data: IBakedWorld; siblings: readonly string[] }> {
  const { file, key } = spec.bake;
  const response = await fetchBakedFile(assets, `world/${file}.json`);
  const json = await response.json();
  if (key === null) return { data: json as IBakedWorld, siblings: [] };
  const bundle = json as Record<string, IBakedWorld>;
  const data = bundle[key];
  if (data === undefined)
    throw new TypeError(`${spec.look}: the baked bundle '${file}' holds no '${key}'.`);
  return { data, siblings: Object.keys(bundle).filter((name) => name !== key) };
}
