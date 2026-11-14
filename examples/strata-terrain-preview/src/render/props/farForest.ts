// The forest past the playable square: spruce across the surveyed valley and up its lower slopes.
//
// The bake plants only the 512 m square, so from the vista the surroundings read as a bare lawn
// around one square block of trees. `@threenative/terrain` owns the rule now (`farForestPlacements`):
// altitude, slope, water, stands and spacing, each a density in 0..1 multiplied together, cited on
// the package's own tests. What stays here is the GAME's part: which worlds plant a collar, the
// layer its streaming buckets a far tree under, the impostor gate, and the biome row the numbers
// come from.
//
// Every tree is an ordinary spruce placement on the `far-forest` layer, so `propWorld.ts` draws
// it through WorldCells with the cooked LOD chain and the engine's whole-asset impostor; the far
// bucket switches to the impostor sooner and casts no shadow, which is what keeps it cheap.
// `?farForest=on` is the named override: trees past the square. Without it the frame is the one
// before this file.
import type { HeightfieldCollar } from "@threenative/core/world";
import {
  type IPlacement,
  collarSampler,
  farForestPlacements as farFieldPlacements,
} from "@threenative/terrain";
import { biomeSpec } from "../biomeData.js";
import type { WorldName } from "../biomes.js";
import type { IBakedLake, IBakedRiver } from "../water/river.js";

/**
 * Which far trees stand: `near` (the default) plants the band of hills just past the square, where a
 * bare lawn read as a bug (owner, 2026-11-09: "why some hills have barely any vegetation?");
 * `?farForest=on` plants the whole ring up the massif's slopes; `?farForest=off` plants none.
 */
const FAR_FOREST_MODE =
  new URLSearchParams(globalThis.location?.search ?? "").get("farForest") ?? "near";
export const FAR_FOREST = FAR_FOREST_MODE !== "off";
/** Metres past the square's edge the default band reaches (`?farForestReach=` while tuning). */
const NEAR_REACH = Number(
  new URLSearchParams(globalThis.location?.search ?? "").get("farForestReach") ?? 700,
);

/** The worlds that plant the collar past the square: the forest's surveyed valley. */
export const FAR_FOREST_WORLDS: readonly WorldName[] = ["forest"];

/** The layer `streamedBucket` reads to put a placement in the far, shadowless bucket. */
export const FAR_FOREST_LAYER = "far-forest";

/**
 * Unit-scale metres at which a far-forest spruce becomes the engine's whole-asset impostor; WorldCells
 * scales it by each placement's own scale. The square's spruce switch at 150 m over their smallest
 * scale (`impostorDistanceForScale`), about 360 m, and a cooked far spruce is 4-20 k triangles, so
 * the same gate on the collar's ninety thousand trees would draw millions of them from the vista.
 * The world package rejects a gate inside the last authored step, so with the licensed spruce's
 * 80/150 m chain `propWorld.ts` lifts it to just past 150 m. The world's biome row carries it
 * (`foliage[].far.impostor`), and this is the constant the streaming reads.
 */
export const FAR_FOREST_IMPOSTOR = 110;

export { collarSampler };

/** What the game hands the rule: its drawn collar, its treeline band, its water and its cameras. */
interface IFarForestOptions {
  readonly size: number;
  readonly resolution: number;
  /** The world's far collar, as drawn. */
  readonly collar: HeightfieldCollar;
  /** The measured treeline band, metres (`IWorldBiome.heightBands.treeline`). */
  readonly treeline: readonly [number, number];
  readonly world: WorldName;
  readonly rivers?: readonly IBakedRiver[];
  readonly lakes?: readonly IBakedLake[];
  /** Circles kept open, [x, z, radius]: the vista's meadow. */
  readonly clear?: readonly (readonly [
    number,
    number,
    number,
  ])[] /** The sea's surface height when the world has one (`data.waterLevel`): no tree under it. */;
  readonly seaLevel?: number | null;
}

/** Spruce placements on the collar; also paints the collar's `canopy` attribute under each crown. */
export function farForestPlacements(options: IFarForestOptions): IPlacement[] {
  const far = biomeSpec(options.world).foliage[0]?.far;
  if (far === undefined || far === null)
    throw new RangeError(`${options.world}: the biome file carries no far field rule`);
  const placed = farFieldPlacements({
    size: options.size,
    resolution: options.resolution,
    collar: options.collar,
    treeline: options.treeline,
    rivers: options.rivers,
    lakes: options.lakes,
    clear: options.clear,
    seaLevel: options.seaLevel,
    rules: far,
    asset: "spruce",
    layer: FAR_FOREST_LAYER,
  });
  if (FAR_FOREST_MODE !== "near") return placed;
  const reach = options.size / 2 + NEAR_REACH;
  return placed.filter(
    (tree) => Math.max(Math.abs(tree.position[0]), Math.abs(tree.position[2])) <= reach,
  );
}
