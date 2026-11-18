// The forest's prop worlds: the bake's containers, the meadow the game plants at load, and the
// terminal gate this kit gives its spruces. The container loop, the record poses and the loaders
// live in `@threenative/terrain/starter`; this file supplies the rows that make them the forest's.
import type { IAssetLoader } from "@threenative/core";
import type { IShadowRegion, IWorldCellsFollow } from "@threenative/core/world";
import type { IPlacement, IPropBucketPackage, IPropPackage } from "@threenative/terrain";
import {
  type IPropWorldOptions as IPackagePropWorldOptions,
  type IPropPreparationProgress,
  type IScatter,
  invalidatePropShadows,
  loadCanopy,
  loadPropPackage,
  loadSky,
  propCounts as propCountsIn,
  streamProps as streamPropsIn,
} from "@threenative/terrain/starter";
import type { Box3 } from "three";
import { FAR_FOREST_IMPOSTOR, FAR_FOREST_LAYER } from "./farForest.js";
import { standShaded } from "./propMaterials.js";
import {
  GROUND_RULES,
  type IPropMaterials,
  type IPropPart,
  LOD_BANDS,
  NO_SHADOW_ASSETS,
  PROP_ASSETS,
  type PropGroundQuery,
  lodSteps,
  streamedBucket,
  streamedReach,
  variantFor,
} from "./props.js";

export interface IPropWorldOptions {
  /** The baked package, one streamed world per bucket. May be empty when every placement is live. */
  readonly package?: IPropPackage;
  /**
   * Placements the caller holds live, compiled here through `@threenative/terrain`.
   *
   * The game plants none: its records come from the bake. The editor compiles the placements it is
   * editing, and a script that proves one pose compiles the one it built.
   */
  readonly placements?: readonly IPlacement[];
  /** Which baked buckets this run keeps; the query flags answer it. Every bucket by default. */
  readonly buckets?: (bucket: IPropBucketPackage) => boolean;
  readonly groundAt: PropGroundQuery;
  readonly parts: Map<string, IPropPart[]>;
  readonly materials: IPropMaterials;
  readonly follow: IWorldCellsFollow;
  /** The world square the bake packaged; live placements use its bounds too. */
  readonly size: number;
  readonly horizonDistance?: number;
  readonly castShadows?: boolean;
  /** The biome row's `standShade`: the tint a spruce takes where no sun shadow is drawn on it. */
  readonly standShade?: readonly [number, number, number];
  /** The sun's outer shadow window, metres; a local spruce takes `standShade` past it. */
  readonly shadowReach?: number;
  readonly bundles?: boolean;
  readonly assets?: IAssetLoader;
  readonly whileCurrent: () => boolean;
  readonly invalidateShadows?: (region?: IShadowRegion) => void;
  readonly onProgress?: (progress: IPropPreparationProgress) => void;
  readonly onPublication?: (bounds: Box3) => void;
}

/**
 * Load the prop worlds, pose every record on the ground, and hand each bucket to `WorldCells`.
 *
 * The passes are short and yield between slices, because the whole point of streaming is that the
 * first frame does not wait for 200 000 records: the records are decoded and grounded in slices, and
 * each bucket loads as its own world.
 */
export async function streamProps(options: IPropWorldOptions) {
  const packageOptions: IPackagePropWorldOptions = {
    ...options,
    groundRules: GROUND_RULES,
    surface: options.materials.bark,
    materials: { ...options.materials },
    variantOf: (placement) => variantFor(placement, placement.asset),
    reachOf: streamedReach,
    bucketOf: (placement, reach) => ({
      name: streamedBucket(placement, reach),
      kind: placement.layer === FAR_FOREST_LAYER ? "far" : "local",
      shadows: !NO_SHADOW_ASSETS.has(placement.asset),
    }),
    lodOf: lodSteps,
    lodHysteresis: LOD_BANDS.hysteresis,
    lodFar: LOD_BANDS.far,
    assetNames: Object.keys(PROP_ASSETS),
    gateAsset: "spruce",
    gateFarDistance: FAR_FOREST_IMPOSTOR,
    shadeStand: standShaded,
    shadowsOf: (bucket) => bucket.bucket.endsWith(":true"),
  };
  return streamPropsIn(packageOptions);
}

/** Records per asset across the package's buckets: what the run report calls the scatter's counts. */
export function propCounts(pkg: IPropPackage): Record<string, number> {
  return propCountsIn(pkg, Object.keys(PROP_ASSETS));
}

export { invalidatePropShadows, loadCanopy, loadPropPackage, loadSky };
export type { IScatter, IPropPreparationProgress };
